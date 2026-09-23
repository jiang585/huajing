//! 隐私空间：本地加密存储。
//!
//! 设计要点：
//! - 密钥由密码经 PBKDF2-HMAC-SHA256（20 万轮）派生，只存在内存里，进程退出即失效。
//! - 每张图单独用 AES-256-GCM 加密，文件格式是 `[12 字节随机 nonce][密文+认证标签]`。
//! - **索引文件本身也加密**，所以连"里面有几张图、叫什么名字"都不泄露。
//! - 缩略图和大图都只在内存里解密后转 base64 交给界面，绝不落明文到磁盘。
//!
//! 忘记密码没有找回途径 —— 这是加密存储的固有性质，不是缺陷。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::AppHandle;
use zeroize::Zeroizing;

/// PBKDF2 迭代轮数。20 万轮在桌面 CPU 上约 0.2 秒，对交互无感但对暴力破解足够贵。
/// 公开给集成测试用（见 tests/vault_crypto.rs）
pub const KDF_ITERATIONS: u32 = 200_000;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const META_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct VaultMeta {
    pub version: u32,
    /// base64，每个空间独立随机
    pub salt: String,
    pub iterations: u32,
    pub created_at: i64,
    /// 可选的密码提示（明文存，不要写密码本身）
    pub hint: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultEntry {
    pub id: String,
    /// 原始文件名，仅用于展示
    pub name: String,
    pub added_at: i64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// 来源模式标签（文生图 / 单图编辑 …），移出时写回历史用
    pub from: String,
    pub prompt: String,
    /// 这张图当时对应的生成参数，移出后重建历史记录要用
    pub params: serde_json::Value,
}

struct VaultInner {
    /// 派生密钥。None 表示锁定。
    key: Option<Zeroizing<Vec<u8>>>,
    entries: Vec<VaultEntry>,
    /// 会话内解密缩略图缓存：id -> data URL
    thumbs: HashMap<String, String>,
}

pub struct VaultState {
    inner: Arc<Mutex<VaultInner>>,
}

impl VaultState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VaultInner {
                key: None,
                entries: Vec::new(),
                thumbs: HashMap::new(),
            })),
        }
    }
}

// ---------------------------------------------------------------- 路径

fn vault_dir(app: &AppHandle) -> PathBuf {
    super::comfy::app_data_dir(app).join("vault")
}
fn meta_path(app: &AppHandle) -> PathBuf {
    meta_at(&vault_dir(app))
}
pub fn meta_at(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}
pub fn index_at(dir: &Path) -> PathBuf {
    dir.join("index.enc")
}
pub fn blob_at(dir: &Path, id: &str) -> PathBuf {
    dir.join("blobs").join(format!("{id}.bin"))
}

// ---------------------------------------------------------------- 加密

pub fn derive_key(password: &str, salt: &[u8], iterations: u32) -> Zeroizing<Vec<u8>> {
    let mut key = Zeroizing::new(vec![0u8; KEY_LEN]);
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    key
}

pub fn encrypt(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| "加密失败".to_string())?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 解密。密码不对时 GCM 的认证标签校验会失败，这里统一报成一句人话。
pub fn decrypt(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() <= NONCE_LEN {
        return Err("密文长度异常，文件可能已损坏".into());
    }
    let (nonce_bytes, ct) = data.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "解密失败：密码不对，或文件已损坏".to_string())
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

// ---------------------------------------------------------------- 索引读写

fn read_meta(app: &AppHandle) -> Option<VaultMeta> {
    read_meta_at(&vault_dir(app))
}
pub fn read_meta_at(dir: &Path) -> Option<VaultMeta> {
    let text = std::fs::read_to_string(meta_at(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_index(app: &AppHandle, key: &[u8]) -> Result<Vec<VaultEntry>, String> {
    read_index_at(&vault_dir(app), key)
}
pub fn read_index_at(dir: &Path, key: &[u8]) -> Result<Vec<VaultEntry>, String> {
    let path = index_at(dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read(&path).map_err(|e| format!("读取索引失败：{e}"))?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let plain = decrypt(key, &raw)?;
    serde_json::from_slice(&plain).map_err(|e| format!("索引解析失败：{e}"))
}

fn write_index(app: &AppHandle, key: &[u8], entries: &[VaultEntry]) -> Result<(), String> {
    write_index_at(&vault_dir(app), key, entries)
}
pub fn write_index_at(dir: &Path, key: &[u8], entries: &[VaultEntry]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let plain = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    let enc = encrypt(key, &plain)?;
    let path = index_at(dir);
    let tmp = path.with_extension("enc.tmp");
    std::fs::write(&tmp, &enc).map_err(|e| format!("写入索引失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存索引失败：{e}"))?;
    Ok(())
}

// ---------------------------------------------------------------- 状态

#[derive(Serialize)]
pub struct VaultStatus {
    /// 是否已经设置过密码（meta.json 存在）
    pub enabled: bool,
    /// 本次会话是否已解锁
    pub unlocked: bool,
    /// 只有解锁后才给数量，锁定时连张数都不透露
    pub count: Option<usize>,
    pub hint: Option<String>,
    pub iterations: u32,
}

fn status_impl(app: &AppHandle, inner: &Arc<Mutex<VaultInner>>) -> VaultStatus {
    let meta = read_meta(app);
    let g = inner.lock().unwrap();
    VaultStatus {
        enabled: meta.is_some(),
        unlocked: g.key.is_some(),
        count: if g.key.is_some() {
            Some(g.entries.len())
        } else {
            None
        },
        hint: meta.as_ref().map(|m| m.hint.clone()).filter(|h| !h.is_empty()),
        iterations: meta.map(|m| m.iterations).unwrap_or(KDF_ITERATIONS),
    }
}

#[tauri::command]
pub fn vault_status(app: AppHandle, state: tauri::State<'_, VaultState>) -> VaultStatus {
    status_impl(&app, &state.inner)
}

/// 首次启用：写入 salt 和空索引。
#[tauri::command]
pub async fn vault_enable(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    password: String,
    hint: String,
) -> Result<VaultStatus, String> {
    if password.chars().count() < 6 {
        return Err("密码至少 6 位".into());
    }
    if read_meta(&app).is_some() {
        return Err("隐私空间已经启用过了。如果要重设密码，请先解锁后修改。".into());
    }
    let inner = state.inner.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let dir = vault_dir(&app2);
        std::fs::create_dir_all(dir.join("blobs")).map_err(|e| format!("创建目录失败：{e}"))?;

        let mut salt = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let meta = VaultMeta {
            version: META_VERSION,
            salt: b64().encode(&salt),
            iterations: KDF_ITERATIONS,
            created_at: chrono::Local::now().timestamp(),
            hint,
        };
        std::fs::write(
            meta_path(&app2),
            serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("写入元数据失败：{e}"))?;

        let key = derive_key(&password, &salt, KDF_ITERATIONS);
        write_index(&app2, &key, &[])?;

        let mut g = inner.lock().unwrap();
        g.key = Some(key);
        g.entries = Vec::new();
        g.thumbs.clear();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(status_impl(&app, &state.inner))
}

/// 解锁。密码不对返回 Ok(false) 而不是 Err —— 这是正常的用户输入，不是故障。
#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    password: String,
) -> Result<bool, String> {
    let Some(meta) = read_meta(&app) else {
        return Err("隐私空间还没有启用。".into());
    };
    let inner = state.inner.clone();
    let app2 = app.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let salt = b64()
            .decode(&meta.salt)
            .map_err(|_| "元数据损坏：salt 无法解析".to_string())?;
        let key = derive_key(&password, &salt, meta.iterations);
        // 用能不能解开索引来判断密码对不对
        let entries = match read_index(&app2, &key) {
            Ok(e) => e,
            Err(_) => return Ok(false),
        };
        let mut g = inner.lock().unwrap();
        g.key = Some(key);
        g.entries = entries;
        g.thumbs.clear();
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(ok)
}

#[tauri::command]
pub fn vault_lock(state: tauri::State<'_, VaultState>) {
    let mut g = state.inner.lock().unwrap();
    // 密钥离开作用域时会被 zeroize 抹掉
    g.key = None;
    g.entries.clear();
    g.thumbs.clear();
}

#[tauri::command]
pub async fn vault_change_password(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.chars().count() < 6 {
        return Err("新密码至少 6 位".into());
    }
    let inner = state.inner.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let meta = read_meta(&app2).ok_or("隐私空间还没有启用。")?;
        let salt = b64().decode(&meta.salt).map_err(|_| "元数据损坏".to_string())?;
        let old_key = derive_key(&old_password, &salt, meta.iterations);
        let entries = read_index(&app2, &old_key).map_err(|_| "原密码不对".to_string())?;

        // 换新盐重派生，然后整库重新加密（索引 + 每个 blob）
        let mut new_salt = vec![0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut new_salt);
        let new_key = derive_key(&new_password, &new_salt, KDF_ITERATIONS);

        for e in &entries {
            let p = blob_at(&vault_dir(&app2), &e.id);
            if !p.exists() {
                continue;
            }
            let raw = std::fs::read(&p).map_err(|err| format!("读取失败：{err}"))?;
            let plain = decrypt(&old_key, &raw)?;
            let re = encrypt(&new_key, &plain)?;
            std::fs::write(&p, re).map_err(|err| format!("写入失败：{err}"))?;
        }
        write_index(&app2, &new_key, &entries)?;

        let new_meta = VaultMeta {
            version: META_VERSION,
            salt: b64().encode(&new_salt),
            iterations: KDF_ITERATIONS,
            created_at: meta.created_at,
            hint: meta.hint,
        };
        std::fs::write(
            meta_path(&app2),
            serde_json::to_string_pretty(&new_meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("写入元数据失败：{e}"))?;

        let mut g = inner.lock().unwrap();
        g.key = Some(new_key);
        g.entries = entries;
        g.thumbs.clear();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 停用隐私空间。要求先清空 —— 直接连带删掉加密数据太危险。
#[tauri::command]
pub async fn vault_disable(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    password: String,
) -> Result<(), String> {
    let inner = state.inner.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let meta = read_meta(&app2).ok_or("隐私空间还没有启用。")?;
        let salt = b64().decode(&meta.salt).map_err(|_| "元数据损坏".to_string())?;
        let key = derive_key(&password, &salt, meta.iterations);
        let entries = read_index(&app2, &key).map_err(|_| "密码不对".to_string())?;
        if !entries.is_empty() {
            return Err(format!(
                "隐私空间里还有 {} 张图。请先把它们全部移出，再停用。",
                entries.len()
            ));
        }
        std::fs::remove_dir_all(vault_dir(&app2)).map_err(|e| format!("删除失败：{e}"))?;
        let mut g = inner.lock().unwrap();
        g.key = None;
        g.entries.clear();
        g.thumbs.clear();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- 可测试的操作层
//
// 这一层以 `dir`（隐私空间目录）为参数，不碰 Tauri 运行时，
// 所以 tests/vault_lifecycle.rs 能拿临时目录把「移入删原文件 / 移出恢复 / 索引往返」
// 整条链路跑一遍。下面的命令只是薄包装。

/// 移入请求：文件路径 + 生成来源信息（移出时用来重建历史记录）
#[derive(Deserialize, Clone)]
pub struct ImportItem {
    pub path: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// 移出结果：条目元数据 + 实际落盘路径。
/// 文件名是按时间戳生成的，前端猜不到，所以必须一并返回。
#[derive(Serialize)]
pub struct ExportedEntry {
    pub entry: VaultEntry,
    pub path: String,
}

/// 首次启用：生成盐、派生密钥、写入空的加密索引。
pub fn enable_at(dir: &Path, password: &str, hint: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if password.chars().count() < 6 {
        return Err("密码至少 6 位".into());
    }
    if read_meta_at(dir).is_some() {
        return Err("隐私空间已经启用过了。如果要重设密码，请先解锁后修改。".into());
    }
    std::fs::create_dir_all(dir.join("blobs")).map_err(|e| format!("创建目录失败：{e}"))?;

    let mut salt = vec![0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let meta = VaultMeta {
        version: META_VERSION,
        salt: b64().encode(&salt),
        iterations: KDF_ITERATIONS,
        created_at: chrono::Local::now().timestamp(),
        hint: hint.to_string(),
    };
    std::fs::write(
        meta_at(dir),
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入元数据失败：{e}"))?;

    let key = derive_key(password, &salt, KDF_ITERATIONS);
    write_index_at(dir, &key, &[])?;
    Ok(key)
}

/// 解锁：用密码派生密钥，再拿能不能解开索引来判断密码对不对。
/// 返回 None 表示密码错误（这是正常的用户输入，不是故障）。
pub fn unlock_at(
    dir: &Path,
    password: &str,
) -> Result<Option<(Zeroizing<Vec<u8>>, Vec<VaultEntry>)>, String> {
    let Some(meta) = read_meta_at(dir) else {
        return Err("隐私空间还没有启用。".into());
    };
    let salt = b64()
        .decode(&meta.salt)
        .map_err(|_| "元数据损坏：salt 无法解析".to_string())?;
    let key = derive_key(password, &salt, meta.iterations);
    match read_index_at(dir, &key) {
        Ok(entries) => Ok(Some((key, entries))),
        Err(_) => Ok(None),
    }
}

/// 把文件加密收进隐私空间，并删除原文件（真移入，磁盘上不留明文）。
/// `entries` 是当前的索引内容，会被就地更新并重新写盘。
pub fn import_at(
    dir: &Path,
    key: &[u8],
    entries: &mut Vec<VaultEntry>,
    items: &[ImportItem],
) -> Result<Vec<VaultEntry>, String> {
    std::fs::create_dir_all(dir.join("blobs")).map_err(|e| format!("创建目录失败：{e}"))?;

    let mut added = Vec::new();
    for it in items {
        let src = PathBuf::from(&it.path);
        if !src.is_file() {
            continue;
        }
        let raw = std::fs::read(&src).map_err(|e| format!("读取 {} 失败：{e}", src.display()))?;
        let bytes = raw.len() as u64;
        let (w, h) = image::image_dimensions(&src).unwrap_or((0, 0));

        let id = uuid::Uuid::new_v4().to_string();
        let enc = encrypt(key, &raw)?;
        let dest = blob_at(dir, &id);
        std::fs::write(&dest, &enc).map_err(|e| format!("写入失败：{e}"))?;

        // 原文件删掉。删不掉就把刚写的密文也撤了，避免出现两份。
        if let Err(e) = std::fs::remove_file(&src) {
            let _ = std::fs::remove_file(&dest);
            return Err(format!("原文件删除失败，已回滚：{e}"));
        }

        added.push(VaultEntry {
            id,
            name: src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "image.png".into()),
            added_at: chrono::Local::now().timestamp_millis(),
            width: w,
            height: h,
            bytes,
            from: it.from.clone(),
            prompt: it.prompt.clone(),
            params: it.params.clone(),
        });
    }

    entries.extend(added.iter().cloned());
    write_index_at(dir, key, entries)?;
    Ok(added)
}

/// 移出：解密到目标目录，并从索引里删掉。
pub fn export_at(
    dir: &Path,
    key: &[u8],
    entries: &mut Vec<VaultEntry>,
    ids: &[String],
    dest_dir: &Path,
) -> Result<Vec<ExportedEntry>, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("创建目录失败：{e}"))?;

    let picked: Vec<VaultEntry> = entries
        .iter()
        .filter(|e| ids.contains(&e.id))
        .cloned()
        .collect();

    let mut out = Vec::new();
    for e in picked {
        let p = blob_at(dir, &e.id);
        let raw = std::fs::read(&p).map_err(|err| format!("读取失败：{err}"))?;
        let plain = decrypt(key, &raw)?;

        let ext = Path::new(&e.name)
            .extension()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|| "png".into());
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut dest = dest_dir.join(format!("{stamp}.{ext}"));
        let mut n = 1;
        while dest.exists() {
            dest = dest_dir.join(format!("{stamp}-{n}.{ext}"));
            n += 1;
        }
        std::fs::write(&dest, &plain).map_err(|err| format!("写入失败：{err}"))?;
        let _ = std::fs::remove_file(&p);
        out.push(ExportedEntry {
            path: dest.to_string_lossy().to_string(),
            entry: e,
        });
    }

    entries.retain(|e| !ids.contains(&e.id));
    write_index_at(dir, key, entries)?;
    Ok(out)
}

/// 永久删除（连密文一起）。
pub fn delete_at(
    dir: &Path,
    key: &[u8],
    entries: &mut Vec<VaultEntry>,
    ids: &[String],
) -> Result<usize, String> {
    let mut removed = 0usize;
    for id in ids {
        let p = blob_at(dir, id);
        if p.exists() && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    entries.retain(|e| !ids.contains(&e.id));
    write_index_at(dir, key, entries)?;
    Ok(removed)
}

/// 换密码：换新盐重新派生，并把索引和每个 blob 都用新密钥重新加密。
pub fn change_password_at(dir: &Path, old_pw: &str, new_pw: &str) -> Result<(), String> {
    if new_pw.chars().count() < 6 {
        return Err("新密码至少 6 位".into());
    }
    let meta = read_meta_at(dir).ok_or("隐私空间还没有启用。")?;
    let salt = b64().decode(&meta.salt).map_err(|_| "元数据损坏".to_string())?;
    let old_key = derive_key(old_pw, &salt, meta.iterations);
    let entries = read_index_at(dir, &old_key).map_err(|_| "原密码不对".to_string())?;

    let mut new_salt = vec![0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut new_salt);
    let new_key = derive_key(new_pw, &new_salt, KDF_ITERATIONS);

    for e in &entries {
        let p = blob_at(dir, &e.id);
        if !p.exists() {
            continue;
        }
        let raw = std::fs::read(&p).map_err(|err| format!("读取失败：{err}"))?;
        let plain = decrypt(&old_key, &raw)?;
        let re = encrypt(&new_key, &plain)?;
        std::fs::write(&p, re).map_err(|err| format!("写入失败：{err}"))?;
    }
    write_index_at(dir, &new_key, &entries)?;

    let new_meta = VaultMeta {
        version: META_VERSION,
        salt: b64().encode(&new_salt),
        iterations: KDF_ITERATIONS,
        created_at: meta.created_at,
        hint: meta.hint,
    };
    std::fs::write(
        meta_at(dir),
        serde_json::to_string_pretty(&new_meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入元数据失败：{e}"))?;
    Ok(())
}

// ---------------------------------------------------------------- 命令
//
// 都只是薄包装：解析目录、拿内存里的密钥、加锁、调用上面的操作层。

fn require_key(inner: &Arc<Mutex<VaultInner>>) -> Result<Zeroizing<Vec<u8>>, String> {
    let g = inner.lock().unwrap();
    g.key
        .as_ref()
        .map(|k| Zeroizing::new(k.to_vec()))
        .ok_or_else(|| "隐私空间已锁定".to_string())
}

#[tauri::command]
pub fn vault_list(state: tauri::State<'_, VaultState>) -> Result<Vec<VaultEntry>, String> {
    let g = state.inner.lock().unwrap();
    if g.key.is_none() {
        return Err("隐私空间已锁定".into());
    }
    let mut list = g.entries.clone();
    list.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    Ok(list)
}

#[tauri::command]
pub async fn vault_import(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    items: Vec<ImportItem>,
) -> Result<Vec<VaultEntry>, String> {
    let key = require_key(&state.inner)?;
    let inner = state.inner.clone();
    let dir = vault_dir(&app);
    let added = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<VaultEntry>, String> {
        let mut g = inner.lock().unwrap();
        let mut entries = std::mem::take(&mut g.entries);
        let added = import_at(&dir, &key, &mut entries, &items)?;
        g.entries = entries;
        g.thumbs.clear();
        Ok(added)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(added)
}

#[tauri::command]
pub async fn vault_export(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    ids: Vec<String>,
    dest_dir: String,
) -> Result<Vec<ExportedEntry>, String> {
    let key = require_key(&state.inner)?;
    let inner = state.inner.clone();
    let dir = vault_dir(&app);
    let moved = tauri::async_runtime::spawn_blocking(
        move || -> Result<Vec<ExportedEntry>, String> {
            let mut g = inner.lock().unwrap();
            let mut entries = std::mem::take(&mut g.entries);
            let out = export_at(&dir, &key, &mut entries, &ids, Path::new(&dest_dir))?;
            g.entries = entries;
            g.thumbs.clear();
            Ok(out)
        },
    )
    .await
    .map_err(|e| e.to_string())??;
    Ok(moved)
}

#[tauri::command]
pub async fn vault_delete(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let key = require_key(&state.inner)?;
    let inner = state.inner.clone();
    let dir = vault_dir(&app);
    let n = tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let mut g = inner.lock().unwrap();
        let mut entries = std::mem::take(&mut g.entries);
        let n = delete_at(&dir, &key, &mut entries, &ids)?;
        g.entries = entries;
        g.thumbs.clear();
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(n)
}

// ---------------------------------------------------------------- 解密取图

/// 解密后按需缩到指定边长，编码成 JPEG data URL。全过程只在内存里。
pub fn to_data_url(key: &[u8], path: &Path, max: u32) -> Result<String, String> {
    let raw = std::fs::read(path).map_err(|e| format!("读取失败：{e}"))?;
    let plain = decrypt(key, &raw)?;
    let img = image::load_from_memory(&plain).map_err(|e| format!("解码失败：{e}"))?;
    let out = if max > 0 {
        img.thumbnail(max, max).to_rgb8()
    } else {
        img.to_rgb8()
    };
    let mut buf = std::io::Cursor::new(Vec::new());
    out.write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| format!("编码失败：{e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        b64().encode(buf.into_inner())
    ))
}

/// 缩略图：网格用，结果按 id 缓存在内存里。
#[tauri::command]
pub async fn vault_thumb(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    id: String,
) -> Result<String, String> {
    let key = require_key(&state.inner)?;
    {
        let g = state.inner.lock().unwrap();
        if let Some(t) = g.thumbs.get(&id) {
            return Ok(t.clone());
        }
    }
    let inner = state.inner.clone();
    let app2 = app.clone();
    let id_for_io = id.clone();
    let url = tauri::async_runtime::spawn_blocking(move || {
        to_data_url(&key, &blob_at(&vault_dir(&app2), &id_for_io), 512)
    })
    .await
    .map_err(|e| e.to_string())??;

    inner.lock().unwrap().thumbs.insert(id, url.clone());
    Ok(url)
}

/// 原图预览：只给当前这一张，不缓存（大图 base64 很占内存）。
#[tauri::command]
pub async fn vault_preview(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    id: String,
) -> Result<String, String> {
    let key = require_key(&state.inner)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        to_data_url(&key, &blob_at(&vault_dir(&app2), &id), 0)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把解密后的原图另存到指定路径（下载按钮用）。
#[tauri::command]
pub async fn vault_save_as(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    id: String,
    dest_path: String,
) -> Result<String, String> {
    let key = require_key(&state.inner)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let p = blob_at(&vault_dir(&app2), &id);
        let raw = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
        let plain = decrypt(&key, &raw)?;
        let dest = PathBuf::from(&dest_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        std::fs::write(&dest, &plain).map_err(|e| format!("写入失败：{e}"))?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 已解锁时返回某个 id 对应的明文文件名，供界面展示。
#[tauri::command]
pub fn vault_name(state: tauri::State<'_, VaultState>, id: String) -> Option<String> {
    let g = state.inner.lock().unwrap();
    g.entries
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.name.clone())
}

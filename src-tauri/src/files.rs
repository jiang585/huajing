//! 文件操作：落盘命名、缩略图、尺寸探测、删除。
//!
//! 缩略图是必须的：历史图库里全是 2K PNG，直接喂给 WebView 解码会吃掉几百 MB 内存，
//! 所以网格里一律用 Rust 侧生成的小图，原图只在预览时加载。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const THUMB_MAX: u32 = 512;

fn thumb_dir(app: &AppHandle) -> PathBuf {
    super::comfy::app_data_dir(app).join("thumbs")
}

fn cache_key(path: &Path) -> String {
    let mut h = DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    if let Ok(md) = std::fs::metadata(path) {
        md.len().hash(&mut h);
        if let Ok(t) = md.modified() {
            if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                d.as_secs().hash(&mut h);
            }
        }
    }
    format!("{:016x}", h.finish())
}

#[derive(Serialize)]
pub struct ImageInfo {
    pub path: String,
    pub exists: bool,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub thumb: Option<String>,
}

/// 生成（或复用）缩略图，返回缩略图路径。
/// 任何一步失败都返回 None —— 缩略图只是优化，不该让界面报错。
fn ensure_thumb(app: &AppHandle, src: &Path) -> Option<String> {
    let dir = thumb_dir(app);
    std::fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(format!("{}.jpg", cache_key(src)));
    if dest.exists() {
        return Some(dest.to_string_lossy().to_string());
    }

    let img = image::open(src).ok()?;
    let thumb = img.thumbnail(THUMB_MAX, THUMB_MAX);
    // 缩略图统一转 RGB，否则带 alpha 的图存 JPEG 会失败
    thumb.to_rgb8().save(&dest).ok()?;
    Some(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn image_info(app: AppHandle, path: String) -> ImageInfo {
    let p = PathBuf::from(&path);
    let exists = p.is_file();
    let mut info = ImageInfo {
        path: path.clone(),
        exists,
        width: 0,
        height: 0,
        bytes: 0,
        thumb: None,
    };
    if !exists {
        return info;
    }

    // 把文件显式加进 asset 协议的放行名单。
    // tauri.conf.json 里的静态 scope 是 glob 匹配，对 Windows 绝对路径（还带中文）
    // 不一定稳；凡是我们要交给前端显示的文件，这里逐个授权最保险。
    let _ = app.asset_protocol_scope().allow_file(&p);

    info.bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    // image_dimensions 只读文件头，比完整解码快得多
    if let Ok((w, h)) = image::image_dimensions(&p) {
        info.width = w;
        info.height = h;
    }
    info.thumb = ensure_thumb(&app, &p);
    if let Some(t) = &info.thumb {
        let _ = app.asset_protocol_scope().allow_file(t);
    }
    info
}

/// 批量取信息，用于历史/图库网格。
#[tauri::command]
pub fn image_infos(app: AppHandle, paths: Vec<String>) -> Vec<ImageInfo> {
    paths.iter().map(|p| image_info(app.clone(), p.clone())).collect()
}

/// 给保存结果生成一个不冲突的落盘路径，并确保父目录存在。
#[tauri::command]
pub fn build_output_path(
    base_dir: String,
    subfolder: String,
    prefix: String,
    ext: String,
) -> Result<String, String> {
    let mut dir = PathBuf::from(&base_dir);
    if !subfolder.is_empty() {
        dir.push(&subfolder);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let ext = ext.trim_start_matches('.').to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    // 前缀可选，用于区分不同模式产出的文件
    let stem = format!("{}{stamp}", prefix.trim());

    for n in 0..1000 {
        let name = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }
    Err("同名文件过多，无法生成文件名".into())
}

/// 复制文件到指定目录（图库导入用）。
#[tauri::command]
pub fn copy_file(src: String, dest_dir: String) -> Result<String, String> {
    let s = PathBuf::from(&src);
    if !s.is_file() {
        return Err(format!("源文件不存在：{src}"));
    }
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let name = s
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.png".into());
    let stem = s.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = s.extension().map(|n| format!(".{}", n.to_string_lossy())).unwrap_or_default();
    let mut source = std::fs::File::open(&s).map_err(|e| format!("读取文件失败：{e}"))?;
    for attempt in 0..100 {
        let file_name = if attempt == 0 { name.clone() } else {
            format!("{stem}-{}{ext}", uuid::Uuid::new_v4().simple())
        };
        let dest = PathBuf::from(&dest_dir).join(file_name);
        let mut output = match std::fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建文件失败：{e}")),
        };
        let result = std::io::copy(&mut source, &mut output);
        drop(output);
        if let Err(e) = result {
            let _ = std::fs::remove_file(&dest);
            return Err(format!("复制失败：{e}"));
        }
        return Ok(dest.to_string_lossy().to_string());
    }
    Err("同名文件过多，无法保存副本".into())
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))?;
    }
    Ok(())
}

/// 把前端 canvas 导出的 data URL 落成图片文件（画面标注用）。
///
/// 标注是在原图上直接画线再存成新文件，而不是另存一层矢量数据 —— 这样送进模型的就是
/// 用户眼睛看到的同一张图，不会有"我以为标了但模型没看到"的偏差。
#[tauri::command]
pub fn save_data_url(data_url: String, dest_path: String) -> Result<String, String> {
    use base64::Engine;
    let payload = data_url
        .split_once(',')
        .map(|(_, b)| b)
        .ok_or_else(|| "data URL 格式不对".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("图片数据解码失败：{e}"))?;
    if bytes.is_empty() {
        return Err("标注结果为空".into());
    }

    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&dest, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// 清理某目录下超过保留数量的旧文件（标注副本会持续产生，需要回收）。
#[tauri::command]
pub fn prune_dir(path: String, keep: usize) -> Result<usize, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Ok(0);
    }
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&p)
        .map_err(|e| format!("读取目录失败：{e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|f| f.is_file())
        .filter_map(|f| {
            let t = std::fs::metadata(&f).ok()?.modified().ok()?;
            Some((t, f))
        })
        .collect();
    if files.len() <= keep {
        return Ok(0);
    }
    // 新的排前面，砍掉后面的
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut removed = 0;
    for (_, f) in files.into_iter().skip(keep) {
        if std::fs::remove_file(&f).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 目录占用空间，设置页显示用。
#[tauri::command]
pub fn dir_stats(path: String) -> Result<(u64, usize), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Ok((0, 0));
    }
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in walk_dir(&p) {
        if let Ok(md) = std::fs::metadata(&entry) {
            total += md.len();
            count += 1;
        }
    }
    Ok((total, count))
}

fn walk_dir(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out
}

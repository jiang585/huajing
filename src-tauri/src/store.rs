//! 本地持久化：设置、生成历史、备用图库索引。
//!
//! 全部存成应用数据目录下的 JSON 文件，结构简单、可读、可手工修。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;
use tauri::AppHandle;

fn store_dir(app: &AppHandle) -> PathBuf {
    super::comfy::app_data_dir(app)
}

fn store_file(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.json"))
}

/// 同一份 JSON 的写入队列。
///
/// 前端会有多个保存请求并发：设置、历史、图库、表单各写各的，同一份也可能同时来两次
/// （例如任务完成写历史的同时，隐私空间移入又改历史）。所有写入原先共用同一个
/// `history.json.tmp`，于是可能互相覆盖、重命名失败，或者晚到的旧快照盖掉新快照。
/// 现在每个资源一把锁，写入按到达顺序逐个完成；临时文件也改成每次唯一。
fn write_lock(name: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    locks
        .lock()
        .unwrap()
        .entry(name.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 每次写入独有的临时文件名，写完再原子改名到目标。
fn temp_file(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ))
}

/// 读一份 JSON；文件不存在或损坏时返回 None，让前端用默认值。
///
/// 写入是先写临时文件再改名，所以读到的要么是旧版本、要么是新版本，不会是半截内容。
pub fn read_json_at(dir: &Path, name: &str) -> Option<Value> {
    let text = std::fs::read_to_string(store_file(dir, name)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 写一份 JSON。调用方负责串行化（见 [`write_json`]）。
pub fn write_json_at(dir: &Path, name: &str, data: &Value) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let path = store_file(dir, name);
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;

    let tmp = temp_file(dir, name);
    if let Err(e) = std::fs::write(&tmp, text) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入失败：{e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("保存失败：{e}"));
    }
    Ok(())
}

pub fn read_json(app: &AppHandle, name: &str) -> Option<Value> {
    read_json_at(&store_dir(app), name)
}

/// 串行写入：同一份 JSON 的保存请求排队执行，不并发。
///
/// 落盘是阻塞 IO，挪到阻塞线程池，别占着异步运行时。
pub async fn write_json_at_serialized(dir: &Path, name: &str, data: Value) -> Result<(), String> {
    let dir = dir.to_path_buf();
    let name = name.to_string();
    // 锁要绑定到具名变量：临时的 Arc 会在语句结束时被释放，guard 就悬空了
    let lock = write_lock(&name);
    let _guard = lock.lock().await;
    tokio::task::spawn_blocking(move || write_json_at(&dir, &name, &data))
        .await
        .map_err(|e| format!("保存失败：{e}"))?
}

pub async fn write_json(app: &AppHandle, name: &str, data: Value) -> Result<(), String> {
    write_json_at_serialized(&store_dir(app), name, data).await
}

#[tauri::command]
pub async fn store_load(app: AppHandle, name: String) -> Option<Value> {
    read_json(&app, &name)
}

#[tauri::command]
pub async fn store_save(app: AppHandle, name: String, data: Value) -> Result<(), String> {
    write_json(&app, &name, data).await
}

#[tauri::command]
pub fn store_dir_path(app: AppHandle) -> String {
    store_dir(&app).to_string_lossy().to_string()
}

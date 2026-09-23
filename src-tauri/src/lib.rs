//! 画境 —— 基于 ComfyUI 的本地 AI 影像工作台。
//!
//! 前端只负责界面与工作流图（API 格式）的拼装，所有跟 ComfyUI 以及本机文件系统的
//! 交互都经由这里的命令完成。

pub mod files;
// 这几个对外公开，是为了让 tests/ 下的集成测试能直接调用里面的纯逻辑
pub mod store;
pub mod comfy;
pub mod video;
pub mod deepseek;
pub mod vault;
pub mod lan;

use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
pub struct AppPaths {
    /// 设置、历史、图库索引的存放位置
    pub data_dir: String,
    /// 缩略图缓存目录
    pub thumb_dir: String,
    pub version: String,
}

#[tauri::command]
fn app_paths(app: tauri::AppHandle) -> AppPaths {
    let data = comfy::app_data_dir(&app);
    AppPaths {
        thumb_dir: data.join("thumbs").to_string_lossy().to_string(),
        data_dir: data.to_string_lossy().to_string(),
        version: app.package_info().version.to_string(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // ComfyUI 根目录优先取设置里存的，没有就用默认值
            let root = store::read_json(&app.handle(), "settings")
                .and_then(|v| {
                    v.get("comfyRoot")
                        .and_then(|s| s.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|| PathBuf::from(comfy::DEFAULT_COMFY_ROOT));
            app.manage(comfy::ComfyState::new(root));
            app.manage(vault::VaultState::new());
            let lan_state = lan::start(app.handle().clone());
            app.manage(lan_state);

            // 把进度通道拉起来。稍微等一下，让前端有时间挂上事件监听。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                let _ = comfy::ensure_ws(&handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_paths,
            // ComfyUI 后端
            comfy::comfy_status,
            comfy::comfy_start,
            comfy::comfy_stop,
            comfy::comfy_logs,
            comfy::comfy_set_root,
            comfy::comfy_client_id,
            comfy::comfy_ws_ensure,
            comfy::comfy_upload_image,
            comfy::comfy_queue_prompt,
            comfy::comfy_history,
            comfy::comfy_queue,
            comfy::comfy_fetch_image,
            comfy::comfy_models,
            video::comfy_video_capabilities,
            video::comfy_fetch_video,
            video::comfy_cancel_prompt,
            // 文件
            comfy::open_path,
            comfy::reveal_path,
            comfy::path_exists,
            comfy::pick_directory,
            comfy::pick_images,
            files::image_info,
            files::image_infos,
            files::build_output_path,
            files::copy_file,
            files::delete_file,
            files::dir_stats,
            files::save_data_url,
            files::prune_dir,
            // 持久化
            store::store_load,
            store::store_save,
            store::store_dir_path,
            // DeepSeek 提示词优化
            deepseek::deepseek_models,
            deepseek::deepseek_optimize,
            // 隐私空间
            vault::vault_status,
            vault::vault_enable,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_change_password,
            vault::vault_disable,
            vault::vault_list,
            vault::vault_import,
            vault::vault_export,
            vault::vault_delete,
            vault::vault_thumb,
            vault::vault_preview,
            vault::vault_save_as,
            vault::vault_name,
            lan::lan_pairing_code,
            lan::lan_devices,
            lan::lan_revoke_device,
        ])
        .run(tauri::generate_context!())
        .expect("画境启动失败");
}

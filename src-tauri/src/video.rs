//! Local MiniMax H3 workflow discovery and video result transport.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::comfy::{self, ComfyState};

const REQUIRED_NODES: &[&str] = &[
    "LoadImage", "ImageScale", "UNETLoader", "CLIPLoader", "VAELoader",
    "MiniMaxH3TurboLoRA", "MiniMaxH3SigmaShift", "MiniMaxH3ImageToVideo",
    "BasicGuider", "MiniMaxH3TurboSampler", "BasicScheduler", "RandomNoise",
    "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo",
];

#[derive(Debug, Serialize)]
pub struct VideoModels {
    pub unet: String,
    pub clip: String,
    pub video_vae: String,
    pub audio_vae: String,
    pub lora: String,
}

#[derive(Debug, Serialize)]
pub struct VideoCapabilities {
    pub ready: bool,
    pub missing_nodes: Vec<String>,
    pub missing_models: Vec<String>,
    pub models: VideoModels,
    pub supports_last_frame: bool,
    pub save_video_dynamic: bool,
    pub message: String,
}

fn input<'a>(info: &'a Value, node: &str, name: &str) -> Option<&'a Value> {
    ["required", "optional"].iter()
        .find_map(|group| info.get(node)?.get("input")?.get(group)?.get(name))
}

fn model_choice(info: &Value, node: &str, name: &str, expected: &str, missing: &mut Vec<String>) -> String {
    let available = input(info, node, name).and_then(|v| v.get(0)).and_then(Value::as_array);
    if let Some(found) = available.and_then(|values| values.iter().filter_map(Value::as_str).find(|value| {
        value.replace('\\', "/").rsplit('/').next() == Some(expected)
    })) {
        return found.to_owned();
    }
    missing.push(expected.to_owned());
    expected.to_owned()
}

/// Inspect the running server's schema, including models it actually accepts.
/// This also handles model files moved into subfolders without inventing names.
pub fn capabilities_from_object_info(info: &Value) -> VideoCapabilities {
    let mut missing_nodes: Vec<String> = REQUIRED_NODES.iter()
        .filter(|name| !info.get(**name).is_some_and(Value::is_object))
        .map(|name| (*name).to_owned()).collect();
    let mut missing_models = Vec::new();
    let models = VideoModels {
        unet: model_choice(info, "UNETLoader", "unet_name", "minimax_h3_fl2va_pruned_int8_convrot.safetensors", &mut missing_models),
        clip: model_choice(info, "CLIPLoader", "clip_name", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", &mut missing_models),
        video_vae: model_choice(info, "VAELoader", "vae_name", "minimax_h3_video_vae_fp16.safetensors", &mut missing_models),
        audio_vae: model_choice(info, "VAELoader", "vae_name", "minimax_h3_audio_vae_fp32.safetensors", &mut missing_models),
        lora: model_choice(info, "MiniMaxH3TurboLoRA", "lora_name", "minimax_h3_turbo_4step_ckpt500.safetensors", &mut missing_models),
    };
    if info.get("CLIPLoader").is_some()
        && !input(info, "CLIPLoader", "type").and_then(|v| v.get(0)).and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some("minimax"))) {
        missing_nodes.push("CLIPLoader（缺少 minimax 类型）".into());
    }
    let supports_last_frame = input(info, "MiniMaxH3ImageToVideo", "last_frame").is_some();
    let save_video_dynamic = input(info, "SaveVideo", "format").and_then(|v| v.get(0)).and_then(Value::as_str)
        == Some("COMFY_DYNAMICCOMBO_V3");
    let ready = missing_nodes.is_empty() && missing_models.is_empty();
    let message = if ready {
        "本机 MiniMax H3 Turbo 已就绪，使用本地模型生成视频。".into()
    } else {
        let mut parts = Vec::new();
        if !missing_nodes.is_empty() { parts.push(format!("缺少节点：{}", missing_nodes.join("、"))); }
        if !missing_models.is_empty() { parts.push(format!("缺少模型：{}", missing_models.join("、"))); }
        parts.join("；")
    };
    VideoCapabilities { ready, missing_nodes, missing_models, models, supports_last_frame, save_video_dynamic, message }
}

pub async fn capabilities_from(client: &reqwest::Client, base: &str) -> Result<VideoCapabilities, String> {
    let resp = client.get(format!("{base}/object_info"))
        .timeout(Duration::from_secs(45)).send().await
        .map_err(|_| "无法检查视频工作流，请先启动 ComfyUI，再点重新检测。".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("读取 ComfyUI 节点信息失败：HTTP {}", resp.status()));
    }
    let info: Value = resp.json().await.map_err(|e| format!("读取节点信息失败：{e}"))?;
    Ok(capabilities_from_object_info(&info))
}

#[tauri::command]
pub async fn comfy_video_capabilities(state: tauri::State<'_, ComfyState>) -> Result<VideoCapabilities, String> {
    capabilities_from(&state.http, &comfy::base_url()).await
}

#[tauri::command]
pub async fn comfy_fetch_video(
    app: AppHandle,
    state: tauri::State<'_, ComfyState>,
    filename: String,
    subfolder: String,
    kind: String,
    dest_path: String,
) -> Result<String, String> {
    let path = comfy::fetch_media_from(&state.http, &comfy::base_url(), &filename, &subfolder, &kind, Path::new(&dest_path)).await?;
    app.asset_protocol_scope().allow_file(&path).map_err(|e| format!("视频已保存，但无法授权播放：{e}"))?;
    Ok(path)
}

fn queue_contains(queue: &Value, section: &str, prompt_id: &str) -> bool {
    queue.get(section).and_then(Value::as_array).is_some_and(|rows| {
        rows.iter().any(|row| row.get(1).and_then(Value::as_str) == Some(prompt_id))
    })
}

async fn queue_from(client: &reqwest::Client, base: &str) -> Result<Value, String> {
    client.get(format!("{base}/queue")).timeout(Duration::from_secs(15)).send().await
        .map_err(|e| format!("读取任务队列失败：{e}"))?.error_for_status()
        .map_err(|e| format!("读取任务队列失败：{e}"))?.json().await
        .map_err(|e| format!("读取任务队列失败：{e}"))
}

async fn history_of(client: &reqwest::Client, base: &str, prompt_id: &str) -> Result<Option<Value>, String> {
    comfy::history_of_at(client, base, prompt_id).await
}

fn history_finished(record: &Value) -> bool {
    let status = record.get("status");
    status.and_then(|s| s.get("completed")).and_then(Value::as_bool) == Some(true)
        || status.and_then(|s| s.get("status_str")).and_then(Value::as_str) == Some("success")
}

/// 取消的确认窗口。ComfyUI 收到中断后还要清理采样、写输出、释放显存，
/// 这段时间里用户如果又提交一次，两个任务会叠在一起抢显存。
const CANCEL_CONFIRM_TIMEOUT: Duration = Duration::from_secs(90);

/// 等待任务真的从队列里消失。
///
/// 拿到 HTTP 成功响应 ≠ 任务停了：`/queue delete` 或者定向 `/interrupt` 只是把请求递过去，
/// 后端可能仍在采样或写文件。这里按 prompt id 继续看队列与历史，确认它已经不在
/// `queue_running` / `queue_pending` 里（历史里也已经出现记录）才返回。
async fn confirm_stopped(
    client: &reqwest::Client,
    base: &str,
    prompt_id: &str,
    kind: &str,
    confirm_timeout: Duration,
) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + confirm_timeout;
    loop {
        let queue = queue_from(client, base).await?;
        let queued = queue_contains(&queue, "queue_pending", prompt_id)
            || queue_contains(&queue, "queue_running", prompt_id);
        if !queued {
            // 队列里已经没有了：看历史确认它是被中断还是刚好跑完了。
            match history_of(client, base, prompt_id).await {
                Ok(Some(record)) if history_finished(&record) => return Ok("finished".into()),
                Ok(Some(_)) => return Ok("interrupted".into()),
                // 没有历史记录也可能是后端重启过；队列已空，任务确实不再占资源了。
                Ok(None) => return Ok(kind.to_string()),
                Err(e) => return Err(format!("{kind}，但无法确认任务状态：{e}")),
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "已发出取消请求，但 {} 秒内任务仍在 ComfyUI 队列中。它可能还在清理，请不要重复提交同一批参数。",
                confirm_timeout.as_secs()
            ));
        }
        // 最后一次轮询不要睡过头，否则确认窗口会比设定的长
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        tokio::time::sleep(remaining.min(Duration::from_millis(600))).await;
    }
}

/// Never send the global interrupt command: other ComfyUI clients share this queue.
/// The local server supports prompt_id in /interrupt and rechecks it atomically.
///
/// 返回只在**确认任务已经停止**之后发生，所以前端拿到返回值就可以安全地解锁运行状态。
pub async fn cancel_prompt_at(client: &reqwest::Client, base: &str, prompt_id: &str) -> Result<String, String> {
    cancel_prompt_at_with(client, base, prompt_id, CANCEL_CONFIRM_TIMEOUT).await
}

/// 同上，确认窗口可指定 —— 集成测试用它把 90 秒压到几百毫秒。
pub async fn cancel_prompt_at_with(
    client: &reqwest::Client,
    base: &str,
    prompt_id: &str,
    confirm_timeout: Duration,
) -> Result<String, String> {
    if prompt_id.trim().is_empty() { return Err("缺少要取消的任务编号。".into()); }
    let mut queue = queue_from(client, base).await?;
    let pending = queue_contains(&queue, "queue_pending", prompt_id);
    if pending {
        client.post(format!("{base}/queue")).json(&json!({"delete": [prompt_id]}))
            .timeout(Duration::from_secs(15)).send().await.map_err(|e| format!("取消排队失败：{e}"))?
            .error_for_status().map_err(|e| format!("取消排队失败：{e}"))?;
        // It may have started between reading and deleting the queue entry.
        queue = queue_from(client, base).await?;
    }
    let running = queue_contains(&queue, "queue_running", prompt_id);
    if running {
        client.post(format!("{base}/interrupt")).json(&json!({"prompt_id": prompt_id}))
            .timeout(Duration::from_secs(15)).send().await.map_err(|e| format!("中断任务失败：{e}"))?
            .error_for_status().map_err(|e| format!("中断任务失败：{e}"))?;
    }
    if !pending && !running {
        // 已经不在队列里了：可能在我们读队列之前就完成了
        if let Some(record) = history_of(client, base, prompt_id).await? {
            return Ok(if history_finished(&record) { "finished".into() } else { "interrupted".into() });
        }
        return Err("任务已不在 ComfyUI 队列中，可能已完成；请等待结果刷新。".into());
    }
    let kind = if running { "interrupted" } else { "removed" };
    confirm_stopped(client, base, prompt_id, kind, confirm_timeout).await
}

#[tauri::command]
pub async fn comfy_cancel_prompt(state: tauri::State<'_, ComfyState>, prompt_id: String) -> Result<String, String> {
    cancel_prompt_at(&state.http, &comfy::base_url(), &prompt_id).await
}

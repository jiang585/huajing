//! Authenticated LAN bridge for RolePlayChat.
//!
//! The bridge accepts high-level image requests and keeps ComfyUI's raw API private.

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex}};
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};

use crate::{comfy, store};

const PORT: u16 = 17890;
/// UDP beacon port used only for finding a Huajing instance after its LAN IP changes.
/// No credentials are sent in the beacon; the phone still validates the saved token
/// through `/v1/connection` before accepting an address.
const DISCOVERY_PORT: u16 = 17891;
const STORE_NAME: &str = "lan_devices";

#[derive(Clone)]
pub struct LanState {
    pub app: AppHandle,
    pub pairing_code: String,
    devices: Arc<Mutex<HashMap<String, DeviceRecord>>>,
    assets: Arc<Mutex<HashMap<String, PathBuf>>>,
    jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DeviceRecord {
    device_id: String,
    device_name: String,
    token_hash: String,
    app_instance_id: String,
    created_at: i64,
    last_seen_at: i64,
}

#[derive(Clone, Serialize)]
struct JobRecord {
    job_id: String,
    client_job_id: String,
    status: String,
    stage: String,
    progress: f32,
    result_asset_id: Option<String>,
    error_code: Option<String>,
    started_at: Option<i64>,
    finished_at: Option<i64>,
}

#[derive(Deserialize)]
struct PairRequest { #[serde(rename = "pairingCode")] pairing_code: String, #[serde(rename = "deviceName")] device_name: String, #[serde(rename = "appInstanceId")] app_instance_id: String }

#[derive(Deserialize, Clone)]
struct GenerationRequest {
    #[serde(rename = "clientJobId")] client_job_id: String,
    model: String,
    mode: String,
    prompt: String,
    #[serde(rename = "negativePrompt", default)] negative_prompt: String,
    #[serde(default)] references: Vec<Reference>,
    size: Size,
    seed: u64,
    metadata: Metadata,
}
#[derive(Deserialize, Clone)]
struct Reference { #[serde(rename = "assetId")] asset_id: String, #[allow(dead_code)] role: Option<String>, #[allow(dead_code)] order: Option<u32> }
#[derive(Deserialize, Clone)]
struct Size { width: u32, height: u32 }
#[derive(Deserialize, Clone)]
struct Metadata { #[serde(rename = "scriptId")] #[allow(dead_code)] script_id: String, #[serde(rename = "characterId")] #[allow(dead_code)] character_id: Option<String>, #[allow(dead_code)] trigger: String }

impl LanState {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let devices = store::read_json(&app, STORE_NAME)
            .and_then(|v| serde_json::from_value::<Vec<DeviceRecord>>(v).ok())
            .unwrap_or_default()
            .into_iter().map(|d| (d.device_id.clone(), d)).collect();
        Arc::new(Self { app, pairing_code: format!("{:06}", rand::random::<u32>() % 1_000_000), devices: Arc::new(Mutex::new(devices)), assets: Arc::new(Mutex::new(HashMap::new())), jobs: Arc::new(Mutex::new(HashMap::new())) })
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        let Some(value) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else { return false; };
        let Some(token) = value.strip_prefix("Bearer ") else { return false; };
        let device = headers.get("x-huajing-device").and_then(|v| v.to_str().ok()).unwrap_or_default();
        let mut devices = self.devices.lock().unwrap();
        if let Some(record) = devices.get_mut(device) {
            if record.token_hash == token_hash(token) { record.last_seen_at = chrono::Utc::now().timestamp(); return true; }
        }
        false
    }

    async fn persist_devices(&self) {
        let items: Vec<DeviceRecord> = self.devices.lock().unwrap().values().cloned().collect();
        let _ = store::write_json(&self.app, STORE_NAME, serde_json::to_value(items).unwrap_or_else(|_| json!([]))).await;
    }
}

pub fn start(app: AppHandle) -> Arc<LanState> {
    let state = LanState::new(app);
    let server_state = state.clone();
    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/v1/health", get(health))
            .route("/v1/connection", get(connection))
            .route("/v1/pairing/claim", post(pair))
            .route("/v1/assets/:sha256", put(upload_asset))
            .route("/v1/assets/:asset_id/content", get(download_asset))
            .route("/v1/generation/jobs", post(create_job))
            .route("/v1/generation/jobs/:job_id", get(job_status))
            .with_state(server_state);
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await {
            Ok(v) => v,
            Err(error) => { eprintln!("Huajing LAN bridge failed to bind: {error}"); return; }
        };
        if let Err(error) = axum::serve(listener, router).await { eprintln!("Huajing LAN bridge stopped: {error}"); }
    });
    start_discovery_beacon();
    state
}

fn start_discovery_beacon() {
    tauri::async_runtime::spawn(async move {
        let socket = match tokio::net::UdpSocket::bind(("0.0.0.0", 0)).await {
            Ok(socket) => socket,
            Err(error) => { eprintln!("Huajing LAN discovery beacon unavailable: {error}"); return; }
        };
        if let Err(error) = socket.set_broadcast(true) {
            eprintln!("Huajing LAN discovery beacon unavailable: {error}");
            return;
        }
        let payload = br#"{"service":"huajing","protocol":1,"port":17890}"#;
        loop {
            let _ = socket.send_to(payload, ("255.255.255.255", DISCOVERY_PORT)).await;
            sleep(Duration::from_secs(2)).await;
        }
    });
}

#[tauri::command]
pub fn lan_pairing_code(state: tauri::State<'_, Arc<LanState>>) -> String { state.pairing_code.clone() }

#[tauri::command]
pub fn lan_devices(state: tauri::State<'_, Arc<LanState>>) -> Vec<serde_json::Value> {
    state.devices.lock().unwrap().values().map(|d| json!({
        "deviceId": d.device_id, "deviceName": d.device_name,
        "appInstanceId": d.app_instance_id, "createdAt": d.created_at, "lastSeenAt": d.last_seen_at
    })).collect()
}

#[tauri::command]
pub fn lan_jobs(state: tauri::State<'_, Arc<LanState>>) -> Vec<serde_json::Value> {
    let mut jobs: Vec<_> = state.jobs.lock().unwrap().values().cloned().collect();
    jobs.sort_by_key(|job| std::cmp::Reverse(job.started_at.unwrap_or(0)));
    jobs.into_iter().map(|job| json!({
        "jobId": job.job_id, "clientJobId": job.client_job_id, "status": job.status,
        "stage": job.stage, "progress": job.progress, "resultAssetId": job.result_asset_id,
        "errorCode": job.error_code, "startedAt": job.started_at, "finishedAt": job.finished_at
    })).collect()
}

#[tauri::command]
pub fn lan_revoke_device(state: tauri::State<'_, Arc<LanState>>, device_id: String) -> Result<bool, String> {
    let removed = state.devices.lock().unwrap().remove(&device_id).is_some();
    if removed { tauri::async_runtime::block_on(state.persist_devices()); }
    Ok(removed)
}

async fn health(State(state): State<Arc<LanState>>) -> impl IntoResponse {
    let comfy_state = state.app.state::<comfy::ComfyState>();
    let status = comfy::status_of(&comfy_state).await;
    let root = std::path::PathBuf::from(&status.root);
    let qwen = root.join("models").join("diffusion_models").join("qwen_image_2.1_int8_convrot.safetensors").is_file()
        && root.join("models").join("text_encoders").join("qwen3vl_8b_int8_convrot.safetensors").is_file();
    let zimage = root.join("models").join("diffusion_models").join("z_image_turbo_int8_convrot.safetensors").is_file()
        && root.join("models").join("text_encoders").join("qwen_3_4b_fp8_mixed.safetensors").is_file();
    Json(json!({
        "service":"huajing", "version":state.app.package_info().version.to_string(),
        "comfyui": if status.running { "ready" } else { "stopped" },
        "comfyManaged": status.managed,
        "models": { "qwenImage21": qwen, "zImage": zimage },
        "canGenerate": status.running && (qwen || zimage),
        "root": status.root
    }))
}

async fn connection(State(state): State<Arc<LanState>>, headers: HeaderMap) -> impl IntoResponse {
    if !state.authorized(&headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"UNAUTHORIZED"}))).into_response();
    }
    Json(json!({"service":"huajing","protocol":1,"port":PORT})).into_response()
}

async fn pair(State(state): State<Arc<LanState>>, Json(input): Json<PairRequest>) -> impl IntoResponse {
    if input.pairing_code != state.pairing_code { return (StatusCode::UNAUTHORIZED, Json(json!({"error":"PAIRING_CODE_INVALID"}))).into_response(); }
    let device_id = uuid::Uuid::new_v4().to_string();
    let token = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    let record = DeviceRecord { device_id: device_id.clone(), device_name: input.device_name, token_hash: token_hash(&token), app_instance_id: input.app_instance_id, created_at: chrono::Utc::now().timestamp(), last_seen_at: chrono::Utc::now().timestamp() };
    state.devices.lock().unwrap().insert(device_id.clone(), record);
    state.persist_devices().await;
    Json(json!({"deviceId":device_id,"accessToken":token,"expiresAt":null})).into_response()
}

async fn upload_asset(State(state): State<Arc<LanState>>, headers: HeaderMap, Path(sha256): Path<String>, mut multipart: Multipart) -> impl IntoResponse {
    if !state.authorized(&headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error":"UNAUTHORIZED"}))).into_response(); }
    let base = comfy::app_data_dir(&state.app).join("lan_assets");
    if let Err(error) = tokio::fs::create_dir_all(&base).await { return server_error(error.to_string()); }
    let path = base.join(format!("{sha256}.input"));
    while let Ok(Some(field)) = multipart.next_field().await {
        let Ok(bytes) = field.bytes().await else { return server_error("invalid multipart body".into()); };
        if bytes.len() > 20 * 1024 * 1024 { return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error":"ASSET_TOO_LARGE"}))).into_response(); }
        if let Err(error) = tokio::fs::write(&path, &bytes).await { return server_error(error.to_string()); }
        break;
    }
    let asset_id = format!("asset_{sha256}");
    state.assets.lock().unwrap().insert(asset_id.clone(), path);
    Json(json!({"assetId":asset_id,"sha256":sha256,"reused":false})).into_response()
}

async fn create_job(State(state): State<Arc<LanState>>, headers: HeaderMap, Json(input): Json<GenerationRequest>) -> impl IntoResponse {
    if !state.authorized(&headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error":"UNAUTHORIZED"}))).into_response(); }
    if input.client_job_id.trim().is_empty() || input.prompt.trim().is_empty() || input.metadata.script_id.trim().is_empty() { return (StatusCode::BAD_REQUEST, Json(json!({"error":"INVALID_REQUEST"}))).into_response(); }
    if input.model == "zimage" && input.mode != "txt2img" { return (StatusCode::BAD_REQUEST, Json(json!({"error":"ZIMAGE_ONLY_SUPPORTS_TXT2IMG"}))).into_response(); }
    if input.model == "qwenimage2.1" && input.mode != "edit" && input.mode != "multiref" { return (StatusCode::BAD_REQUEST, Json(json!({"error":"QWEN_MODE_INVALID"}))).into_response(); }
    if input.model == "qwenimage2.1" && input.references.is_empty() { return (StatusCode::BAD_REQUEST, Json(json!({"error":"QWEN_REFERENCE_REQUIRED"}))).into_response(); }
    let job_id = uuid::Uuid::new_v4().to_string();
    let record = JobRecord { job_id: job_id.clone(), client_job_id: input.client_job_id.clone(), status: "QUEUED".into(), stage: "等待执行".into(), progress: 0.0, result_asset_id: None, error_code: None, started_at: None, finished_at: None };
    state.jobs.lock().unwrap().insert(job_id.clone(), record);
    let worker_state = state.clone(); let worker_job = job_id.clone();
    tauri::async_runtime::spawn(async move { run_job(worker_state, worker_job, input).await; });
    (StatusCode::ACCEPTED, Json(json!({"jobId":job_id,"status":"QUEUED"}))).into_response()
}

async fn job_status(State(state): State<Arc<LanState>>, headers: HeaderMap, Path(job_id): Path<String>) -> impl IntoResponse {
    if !state.authorized(&headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error":"UNAUTHORIZED"}))).into_response(); }
    let Some(job) = state.jobs.lock().unwrap().get(&job_id).cloned() else { return (StatusCode::NOT_FOUND, Json(json!({"error":"JOB_NOT_FOUND"}))).into_response(); };
    Json(json!({"jobId":job.job_id,"clientJobId":job.client_job_id,"status":job.status,"stage":job.stage,"progress":job.progress,"resultAssetId":job.result_asset_id,"errorCode":job.error_code})).into_response()
}

async fn download_asset(State(state): State<Arc<LanState>>, headers: HeaderMap, Path(asset_id): Path<String>) -> impl IntoResponse {
    if !state.authorized(&headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error":"UNAUTHORIZED"}))).into_response(); }
    let Some(path) = state.assets.lock().unwrap().get(&asset_id).cloned() else { return (StatusCode::NOT_FOUND, Json(json!({"error":"ASSET_NOT_FOUND"}))).into_response(); };
    match tokio::fs::read(path).await { Ok(bytes) => Response::builder().header(header::CONTENT_TYPE, "image/png").body(Body::from(bytes)).unwrap(), Err(_) => (StatusCode::NOT_FOUND, Json(json!({"error":"ASSET_NOT_FOUND"}))).into_response() }
}

async fn run_job(state: Arc<LanState>, job_id: String, input: GenerationRequest) {
    set_job(&state, &job_id, "RUNNING", "准备工作流", 0.05, None, None);
    let result = execute_job(&state, &job_id, &input).await;
    match result { Ok(asset_id) => set_job(&state, &job_id, "READY", "完成", 1.0, Some(asset_id), None), Err(error) => set_job(&state, &job_id, "FAILED_RETRYABLE", "生成失败", 0.0, None, Some(error)) }
}

async fn execute_job(state: &LanState, job_id: &str, input: &GenerationRequest) -> Result<String, String> {
    let comfy_state = state.app.state::<comfy::ComfyState>();
    set_job(state, job_id, "RUNNING", "启动 ComfyUI", 0.02, None, None);
    comfy::start_if_needed(&state.app, &comfy_state).await?;
    comfy::ensure_ws(&state.app).await?;
    let mut names = Vec::new();
    for reference in &input.references {
        let path = state.assets.lock().unwrap().get(&reference.asset_id).cloned().ok_or_else(|| "REFERENCE_NOT_FOUND".to_string())?;
        let uploaded = comfy::upload_image_to(&comfy_state.http, &path).await?;
        names.push(if uploaded.subfolder.is_empty() { uploaded.name } else { format!("{}/{}", uploaded.subfolder, uploaded.name) });
    }
    set_job(state, job_id, "RUNNING", "提交 ComfyUI", 0.15, None, None);
    let graph = build_graph(input, &names)?;
    let queued = comfy::queue_prompt_to(&comfy_state.http, &graph, &comfy_state.client_id).await?;
    for poll in 0..600 {
        if let Some(history) = comfy::history_of(&comfy_state.http, &queued.prompt_id).await? {
            if let Some((filename, subfolder, kind)) = first_output(&history) {
                let output_dir = comfy::app_data_dir(&state.app).join("lan_outputs"); tokio::fs::create_dir_all(&output_dir).await.map_err(|e| e.to_string())?;
                let path = output_dir.join(format!("{job_id}.png"));
                comfy::fetch_image_to(&comfy_state.http, &filename, &subfolder, &kind, &path).await?;
                let asset_id = format!("result_{job_id}"); state.assets.lock().unwrap().insert(asset_id.clone(), path); return Ok(asset_id);
            }
        }
        let progress = 0.2 + (poll as f32 / 600.0) * 0.75;
        set_job(state, job_id, "RUNNING", "生成中", progress.min(0.95), None, None); sleep(Duration::from_millis(1200)).await;
    }
    Err("GENERATION_TIMEOUT".into())
}

fn first_output(history: &Value) -> Option<(String, String, String)> {
    fn walk(value: &Value) -> Option<(String, String, String)> {
        if let Some(obj) = value.as_object() { for (key, child) in obj { if key == "images" { if let Some(items) = child.as_array() { if let Some(item) = items.first() { let filename = item.get("filename")?.as_str()?.to_string(); let subfolder = item.get("subfolder").and_then(Value::as_str).unwrap_or_default().to_string(); let kind = item.get("type").and_then(Value::as_str).unwrap_or("output").to_string(); return Some((filename, subfolder, kind)); } } } if let Some(found) = walk(child) { return Some(found); } } }
        if let Some(items) = value.as_array() { for child in items { if let Some(found) = walk(child) { return Some(found); } } }
        None
    }
    walk(history)
}

fn build_graph(input: &GenerationRequest, references: &[String]) -> Result<Value, String> {
    if input.size.width < 256 || input.size.height < 256 || input.size.width > 4096 || input.size.height > 4096 { return Err("INVALID_SIZE".into()); }
    let mut graph = serde_json::Map::new();
    if input.model == "zimage" {
        if !references.is_empty() { return Err("ZIMAGE_DOES_NOT_ACCEPT_REFERENCES".into()); }
        graph.insert("1".into(), json!({"class_type":"UNETLoader","inputs":{"unet_name":"z_image_turbo_int8_convrot.safetensors","weight_dtype":"default"}}));
        graph.insert("2".into(), json!({"class_type":"CLIPLoader","inputs":{"clip_name":"qwen_3_4b_fp8_mixed.safetensors","type":"lumina2","device":"default"}}));
        graph.insert("3".into(), json!({"class_type":"VAELoader","inputs":{"vae_name":"ae.safetensors"}}));
        graph.insert("4".into(), json!({"class_type":"ModelSamplingAuraFlow","inputs":{"model":["1",0],"shift":3}}));
        graph.insert("5".into(), json!({"class_type":"CLIPTextEncode","inputs":{"clip":["2",0],"text":input.prompt}}));
        graph.insert("6".into(), json!({"class_type":"CLIPTextEncode","inputs":{"clip":["2",0],"text":input.negative_prompt}}));
        graph.insert("7".into(), json!({"class_type":"ConditioningZeroOut","inputs":{"conditioning":["6",0]}}));
        graph.insert("8".into(), json!({"class_type":"EmptySD3LatentImage","inputs":{"width":input.size.width,"height":input.size.height,"batch_size":1}}));
        graph.insert("9".into(), json!({"class_type":"KSampler","inputs":{"model":["4",0],"positive":["5",0],"negative":["7",0],"latent_image":["8",0],"seed":input.seed,"steps":8,"cfg":1.0,"sampler_name":"res_multistep","scheduler":"simple","denoise":1.0}}));
        graph.insert("10".into(), json!({"class_type":"VAEDecode","inputs":{"samples":["9",0],"vae":["3",0]}}));
        graph.insert("11".into(), json!({"class_type":"SaveImage","inputs":{"images":["10",0],"filename_prefix":"画境/局域网"}}));
    } else {
        if references.is_empty() { return Err("QWEN_REFERENCE_REQUIRED".into()); }
        graph.insert("1".into(), json!({"class_type":"UNETLoader","inputs":{"unet_name":"qwen_image_2.1_int8_convrot.safetensors","weight_dtype":"default"}}));
        graph.insert("3".into(), json!({"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3vl_8b_int8_convrot.safetensors","type":"qwen_image","device":"default"}}));
        graph.insert("4".into(), json!({"class_type":"VAELoader","inputs":{"vae_name":"qwen_image_2.1_vae_bf16.safetensors"}}));
        let mut ref_inputs = serde_json::Map::new();
        for (i, reference) in references.iter().enumerate() { let node = (10 + i).to_string(); graph.insert(node.clone(), json!({"class_type":"LoadImage","inputs":{"image":reference}})); ref_inputs.insert(format!("images.image_{}", i + 1), json!([node, 0])); }
        let mut enc = json!({"class_type":"TextEncodeQwenImage21","inputs":{"clip":["3",0],"prompt":input.prompt,"negative_prompt":input.negative_prompt,"resolution":input.size.width,"vae":["4",0]}});
        if let Some(obj) = enc.get_mut("inputs").and_then(Value::as_object_mut) { for (key, value) in ref_inputs { obj.insert(key, value); } }
        let enc_id = (10 + references.len()).to_string(); let sample_id = (11 + references.len()).to_string(); let decode_id = (12 + references.len()).to_string(); let save_id = (13 + references.len()).to_string();
        graph.insert(enc_id.clone(), enc); graph.insert(sample_id.clone(), json!({"class_type":"KSampler","inputs":{"model":["1",0],"positive":[enc_id,0],"negative":[enc_id,1],"latent_image":[enc_id,2],"seed":input.seed,"steps":25,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0}}));
        graph.insert(decode_id.clone(), json!({"class_type":"VAEDecode","inputs":{"samples":[sample_id,0],"vae":["4",0]}})); graph.insert(save_id.clone(), json!({"class_type":"SaveImage","inputs":{"images":[decode_id,0],"filename_prefix":"画境/局域网"}}));
    }
    Ok(Value::Object(graph))
}

fn set_job(state: &LanState, id: &str, status: &str, stage: &str, progress: f32, asset: Option<String>, error: Option<String>) {
    if let Some(job) = state.jobs.lock().unwrap().get_mut(id) {
        let now = chrono::Utc::now().timestamp_millis();
        job.status=status.into(); job.stage=stage.into(); job.progress=progress; job.result_asset_id=asset; job.error_code=error;
        if status == "RUNNING" && job.started_at.is_none() { job.started_at = Some(now); }
        if matches!(status, "READY" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "CANCELLED") { job.finished_at = Some(now); }
    }
}
fn server_error(message: String) -> Response { (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":message}))).into_response() }

fn token_hash(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

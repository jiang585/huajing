//! ComfyUI 后端管理：进程启停、端口探测、HTTP API 代理。
//!
//! 所有对 ComfyUI 的 HTTP 调用都走这里（而不是前端 fetch），原因有两个：
//! 1. ComfyUI 默认不发 CORS 头，WebView 里直接 fetch 会被拦；
//! 2. 上传/下载图片是二进制大对象，放 Rust 侧处理更省内存。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};

// tokio::process::Command 自带 Windows 下的 creation_flags，不需要额外 trait
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 启动 ComfyUI 时使用的参数，与桌面启动脚本保持一致（已验证可用）。
///
/// 这是对外契约：tests/launch_recipe.rs 会检查关键开关还在不在。
/// 改这里之前先想清楚 —— 少了 `--lowvram` 或 `--disable-pinned-memory`，
/// 8G 显存上很容易 OOM 之后卡死。
pub const LAUNCH_ARGS: &[&str] = &[
    "-u",
    "start_comfy.py",
    "--disable-auto-launch",
    "--lowvram",
    "--reserve-vram",
    "1.0",
    "--fast-disk",
    "--disable-pinned-memory",
    "--preview-method",
    "none",
    "--cache-ram",
    "6",
    "12",
    "--use-sage-attention",
];

pub const DEFAULT_COMFY_ROOT: &str = r"E:\ComfyUI";

/// ComfyUI 控制台日志文件，放在 ComfyUI 根目录下，用户能直接找到。
pub fn console_log_path(root: &Path) -> PathBuf {
    root.join("huajing_console.log")
}

/// 打开控制台日志用于追加，返回 stdout / stderr 两个句柄（指向同一文件）。
///
/// 为什么不用管道：管道是父子进程之间的私有通道，**读端随父进程消失就没了**。
/// 应用退出后，被孤立的 ComfyUI 每次往 stderr 写都会失败 —— tqdm 建进度条时要
/// flush stderr，于是每次采样都抛 `OSError: [Errno 22] Invalid argument`，
/// 整个后端等于废掉。重定向到文件则与父进程生死无关。
pub fn open_console_log(root: &Path) -> Result<(std::fs::File, std::fs::File), String> {
    let path = console_log_path(root);
    let open = || {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
    };
    let out = open().map_err(|e| format!("打开日志文件失败（{}）：{e}", path.display()))?;
    let err = open().map_err(|e| format!("打开日志文件失败（{}）：{e}", path.display()))?;
    Ok((out, err))
}

/// 组装拉起 ComfyUI 的命令。
/// 抽成独立函数是为了让测试走完全同一条代码路径 —— 「应用内一键启停」是核心功能，
/// 不能只靠人工点一次就算验证过。
pub fn build_launch_command(root: &Path) -> Result<Command, String> {
    let python = root.join("venv").join("Scripts").join("python.exe");
    if !python.exists() {
        return Err(format!(
            "找不到 Python 解释器：{}\n请在「设置」里确认 ComfyUI 根目录是否正确。",
            python.display()
        ));
    }
    let (out, err) = open_console_log(root)?;

    let mut cmd = Command::new(&python);
    cmd.args(LAUNCH_ARGS)
        .current_dir(root)
        // 文件而不是管道，见 open_console_log 的说明
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .stdin(Stdio::null())
        // 中文 Windows 上 Python 被重定向时会按本地代码页（GBK）编码输出，
        // tqdm 的进度块这类字符就会把日志变成非法 UTF-8：界面读出来是乱码，
        // 按行读取还会整块失败。强制 UTF-8 输出，日志从此是合法文本。
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// 给日志面板用的一行命令预览。
pub fn launch_command_preview(root: &Path) -> String {
    format!(
        r"{}\venv\Scripts\python.exe {}",
        root.display(),
        LAUNCH_ARGS.join(" ")
    )
}

// ---------------------------------------------------------------- 可独立测试的 HTTP 层
//
// 这一层刻意不依赖 Tauri 运行时（不收 State、不收 AppHandle），
// 这样集成测试能直接调用它，不必先起一个窗口。

pub fn make_client() -> reqwest::Client {
    reqwest::Client::builder()
        // 本地回环不走系统代理，否则用户开了代理时请求会被转发出去
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("构建 HTTP 客户端失败")
}

pub fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

fn http_err(e: reqwest::Error) -> String {
    if e.is_connect() {
        "连接 ComfyUI 失败，请确认后端正在运行。".to_string()
    } else if e.is_timeout() {
        "请求 ComfyUI 超时。".to_string()
    } else {
        format!("请求 ComfyUI 出错：{e}")
    }
}

#[derive(Serialize, Debug)]
pub struct UploadedImage {
    pub name: String,
    pub subfolder: String,
    pub kind: String,
}

/// 上传一张本地图片到 ComfyUI 的 input 目录，返回它认识的文件名。
pub async fn upload_image_to(
    client: &reqwest::Client,
    path: &Path,
) -> Result<UploadedImage, String> {
    if !path.is_file() {
        return Err(format!("文件不存在：{}", path.display()));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("读取图片失败：{e}"))?;
    let original_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload.png".into());
    // Different source folders often contain the same name. Each input must keep
    // its own bytes, including when several references are uploaded together.
    let filename = unique_upload_name(&original_name);
    let mime = match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    };

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("type", "input")
        .text("overwrite", "false");

    let resp = client
        .post(format!("{}/upload/image", base_url()))
        .multipart(form)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(http_err)?;

    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("上传图片失败（HTTP {code}）：{body}"));
    }

    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(UploadedImage {
        name: v["name"].as_str().unwrap_or_default().to_string(),
        subfolder: v["subfolder"].as_str().unwrap_or_default().to_string(),
        kind: v["type"].as_str().unwrap_or("input").to_string(),
    })
}

pub fn unique_upload_name(original_name: &str) -> String {
    format!("huajing_{}_{}", uuid::Uuid::new_v4().simple(), original_name)
}

#[derive(Serialize, Debug)]
pub struct QueuedPrompt {
    pub prompt_id: String,
    pub number: Option<i64>,
}

/// 提交工作流图（API 格式）到执行队列。
pub async fn queue_prompt_to(
    client: &reqwest::Client,
    graph: &Value,
    client_id: &str,
) -> Result<QueuedPrompt, String> {
    let body = json!({ "prompt": graph, "client_id": client_id });

    let resp = client
        .post(format!("{}/prompt", base_url()))
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(http_err)?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        // ComfyUI 的校验失败信息在 node_errors 里，尽量把可读的部分提炼出来
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            let mut msgs: Vec<String> = Vec::new();
            if let Some(err) = v.get("error") {
                let t = err["type"].as_str().unwrap_or("error");
                let m = err["message"].as_str().unwrap_or("");
                let d = err["details"].as_str().unwrap_or("");
                msgs.push(format!("{t}: {m} {d}").trim().to_string());
            }
            if let Some(nodes) = v.get("node_errors").and_then(|n| n.as_object()) {
                for (nid, info) in nodes {
                    if let Some(errs) = info["errors"].as_array() {
                        for e in errs {
                            msgs.push(format!(
                                "节点 {nid}：{}",
                                e["message"].as_str().unwrap_or("参数校验失败")
                            ));
                        }
                    }
                }
            }
            if !msgs.is_empty() {
                return Err(msgs.join("\n"));
            }
        }
        return Err(format!("提交失败（HTTP {status}）：{text}"));
    }

    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(QueuedPrompt {
        prompt_id: v["prompt_id"].as_str().unwrap_or_default().to_string(),
        number: v["number"].as_i64(),
    })
}

/// 查询某次执行的结果。返回 None 表示还在队列里或正在跑。
pub async fn history_of(
    client: &reqwest::Client,
    prompt_id: &str,
) -> Result<Option<Value>, String> {
    history_of_at(client, &base_url(), prompt_id).await
}

/// 同上，但可以指定服务地址 —— 集成测试用本地假服务器验证取消确认流程。
pub async fn history_of_at(
    client: &reqwest::Client,
    base: &str,
    prompt_id: &str,
) -> Result<Option<Value>, String> {
    let resp = client
        .get(format!("{base}/history/{prompt_id}"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(http_err)?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.get(prompt_id).cloned())
}

/// 把 ComfyUI 产出的图片下载到本地指定路径。
pub async fn fetch_image_to(
    client: &reqwest::Client,
    filename: &str,
    subfolder: &str,
    kind: &str,
    dest: &Path,
) -> Result<String, String> {
    fetch_media_from(client, &base_url(), filename, subfolder, kind, dest).await
}

/// Stream large videos directly to disk, without holding the complete result in RAM.
///
/// 先写同目录下的唯一临时文件，整段读完并确认为非空之后再原子改名到目标：
/// 应用退出、网络中断或磁盘错误都不会在输出目录留下一个"看起来完整但播不了"的文件。
pub async fn fetch_media_from(
    client: &reqwest::Client,
    base: &str,
    filename: &str,
    subfolder: &str,
    kind: &str,
    dest: &Path,
) -> Result<String, String> {
    use futures_util::StreamExt;
    // 不覆盖已存在的成果文件：重名时宁可直接报错，也不能把上一次的结果冲掉。
    if dest.exists() {
        return Err(format!("目标文件已存在，未覆盖：{}", dest.display()));
    }
    let resp = client
        .get(format!("{base}/view"))
        .query(&[("filename", filename), ("subfolder", subfolder), ("type", kind)])
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(http_err)?;

    if !resp.status().is_success() {
        return Err(format!("下载结果失败（HTTP {}）：{filename}", resp.status()));
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let temp = temp_download_path(dest);
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
        .map_err(|e| format!("写入失败：{e}"))?;
    let mut stream = resp.bytes_stream();
    let saved: Result<u64, String> = async {
        let mut count = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(http_err)?;
            file.write_all(&chunk).await.map_err(|e| format!("写入失败：{e}"))?;
            count += chunk.len() as u64;
        }
        if count == 0 { return Err("ComfyUI 返回了空文件，请重新保存结果。".into()); }
        file.flush().await.map_err(|e| format!("写入失败：{e}"))?;
        Ok(count)
    }.await;
    // 句柄必须先关掉，否则 Windows 上改名会失败
    drop(file);
    if let Err(error) = saved {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(error);
    }
    if let Err(e) = tokio::fs::rename(&temp, dest).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(format!("保存失败：{e}"));
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 下载用的临时文件：和目标是同一个目录（改名才能是原子的），文件名唯一（并发不互相覆盖）。
fn temp_download_path(dest: &Path) -> PathBuf {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let stem = dest.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
    parent.join(format!(".{stem}.{}.part", uuid::Uuid::new_v4().simple()))
}

// ---------------------------------------------------------------- 状态

pub struct ComfyState {
    /// 由本应用拉起的进程。外部启动的 ComfyUI 这里为 None。
    child: Mutex<Option<Child>>,
    /// 启动请求串行化。前端有两个入口会启动后端（顶栏按钮、生成前的自动启动），
    /// 并发调用必须共用同一次启动过程。
    start_lock: tokio::sync::Mutex<()>,
    /// 本应用的 websocket client id，/prompt 与 /ws 必须一致才能收到进度。
    pub client_id: String,
    /// websocket 监听循环是否已在运行。
    ws_running: Arc<AtomicBool>,
    /// ComfyUI 根目录，可在设置里改。
    root: Mutex<PathBuf>,
    /// 后端 stdout/stderr 的环形缓冲，供界面日志面板查看。
    logs: Arc<Mutex<Vec<String>>>,
    /// 日志跟随任务的代号。每次启动自增，旧任务看到代号变了就自行退出。
    log_gen: Arc<std::sync::atomic::AtomicU64>,
    pub(crate) http: reqwest::Client,
}

impl ComfyState {
    pub fn new(root: PathBuf) -> Self {
        let http = make_client();
        Self {
            child: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            client_id: uuid::Uuid::new_v4().to_string(),
            ws_running: Arc::new(AtomicBool::new(false)),
            root: Mutex::new(root),
            logs: Arc::new(Mutex::new(Vec::new())),
            log_gen: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            http,
        }
    }

    /// 受管子进程的 PID，前提是它**还在运行**。
    ///
    /// 已经退出的进程会顺手清掉：否则一个早就死掉的句柄会一直让界面显示
    /// 「由画境启动」并给出一个无效 PID，后续启动也会被误判成"已经有一个在跑了"。
    fn live_child_pid(&self) -> Option<u32> {
        let mut guard = self.child.lock().unwrap();
        let alive = match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => child.id(),
                _ => None,
            },
            None => None,
        };
        if guard.is_some() && alive.is_none() {
            *guard = None;
        }
        alive
    }

    pub fn root(&self) -> PathBuf {
        self.root.lock().unwrap().clone()
    }

    pub fn set_root(&self, p: PathBuf) {
        *self.root.lock().unwrap() = p;
    }

    fn python_exe(&self) -> PathBuf {
        self.root().join("venv").join("Scripts").join("python.exe")
    }

    fn push_log(&self, line: String) {
        let mut logs = self.logs.lock().unwrap();
        logs.push(line);
        // 只留最近 400 行，避免长时间运行后内存无限增长
        let len = logs.len();
        if len > 400 {
            logs.drain(0..len - 400);
        }
    }
}

#[derive(Serialize)]
pub struct ComfyStatus {
    pub running: bool,
    /// 进程是否由本应用拉起（决定「关闭」按钮用哪种方式杀）
    pub managed: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub root: String,
    pub python_ok: bool,
}

pub const PORT: u16 = 8188;

/// 换行与回车。用常量而不是内联字面量，避免多层转义把字符吃成真换行。
const NEWLINE: char = '\n';
const CARRIAGE_RETURN: char = '\r';

/// 从缓冲区里取出所有**完整**的行，剩下的半行留在缓冲区等后续字节。
///
/// ComfyUI 是持续追加输出的，一次读取很可能正好切在行中间；
/// 不处理的话日志面板会出现半截行，多字节字符被切断时还会变乱码。
pub fn take_complete_lines(pending: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(i) = pending.find(NEWLINE) {
        // 兼容 Windows 的 CRLF
        let line = pending[..i].trim_end_matches(CARRIAGE_RETURN).to_string();
        pending.drain(..=i);
        out.push(line);
    }
    out
}

/// 从字节缓冲区里取出**完整 UTF-8 序列**能覆盖的部分。
///
/// 日志是持续追加的，一次读取很可能正好切在一个中文字符的三个字节中间。
/// 直接 `from_utf8_lossy` 会把那半个字符变成替换字符（乱码），并且再也补不回来 ——
/// 所以末尾没凑齐的多字节序列要留在缓冲区，等下一次读取补齐。
/// 只有确实非法的字节（不是"还没读完"）才按 U+FFFD 丢掉，否则会永远卡住。
pub fn take_decodable_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                out.push_str(text);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(&String::from_utf8_lossy(&pending[..valid]));
                match e.error_len() {
                    // 末尾是未完成的多字节序列：留到下次补齐
                    None => {
                        pending.drain(..valid);
                        // 留超过 3 字节说明根本不是 UTF-8，别再等下去
                        if pending.len() > 3 {
                            out.push('\u{FFFD}');
                            pending.clear();
                        }
                        return out;
                    }
                    // 真正的非法字节：替换掉并跳过，继续后面的内容
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + bad);
                    }
                }
            }
        }
    }
}

/// 跟着日志文件读新增内容，按行推进日志缓冲并广播给界面。
///
/// 用轮询而不是文件监听：ComfyUI 的输出是持续追加的，600ms 的粒度看日志完全够，
/// 换来的是不需要额外的文件监听依赖。
fn spawn_log_tailer(
    app: AppHandle,
    root: PathBuf,
    logs: Arc<Mutex<Vec<String>>>,
    gen_flag: Arc<std::sync::atomic::AtomicU64>,
    my_gen: u64,
) {
    tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let path = console_log_path(&root);
        // 文件里已经读掉的字节数。只按**实际读到的字节**推进，不预先跳到文件末尾
        let mut pos: u64 = 0;
        // 还没凑成完整 UTF-8 的尾巴，等后续字节补齐
        let mut pending_bytes: Vec<u8> = Vec::new();
        // 还没遇到换行的最后一行，等补齐再算一行
        let mut pending_line = String::new();

        loop {
            if gen_flag.load(Ordering::SeqCst) != my_gen {
                return; // 有新的启动任务接管了
            }
            tokio::time::sleep(Duration::from_millis(600)).await;

            let Ok(mut f) = tokio::fs::File::open(&path).await else {
                continue;
            };
            let len = match f.metadata().await {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if len < pos {
                // 文件被清空或轮转了，从头再来
                pos = 0;
                pending_bytes.clear();
                pending_line.clear();
            }
            if len == pos {
                continue;
            }
            if f.seek(std::io::SeekFrom::Start(pos)).await.is_err() {
                continue;
            }
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).await.is_err() {
                continue;
            }
            pos += buf.len() as u64;

            pending_bytes.extend_from_slice(&buf);
            pending_line.push_str(&take_decodable_utf8(&mut pending_bytes));
            let lines = take_complete_lines(&mut pending_line);
            if lines.is_empty() {
                continue;
            }
            {
                let mut l = logs.lock().unwrap();
                for line in &lines {
                    l.push(line.clone());
                }
                let n = l.len();
                if n > 400 {
                    l.drain(0..n - 400);
                }
            }
            for line in &lines {
                let _ = app.emit("comfy://log", line);
            }
        }
    });
}

// ---------------------------------------------------------------- 探测

/// 探测端口是否有服务在监听。超时很短，因为只连回环地址。
pub async fn port_open(port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            TcpStream::connect(("127.0.0.1", port))
        )
        .await,
        Ok(Ok(_))
    )
}

/// 通过 netstat 反查监听指定端口的进程号（用于关闭外部启动的 ComfyUI）。
async fn pid_on_port(port: u16) -> Option<u32> {
    let out = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!(":{}", port);
    for line in text.lines() {
        if !line.contains("LISTENING") || !line.contains(&needle) {
            continue;
        }
        let mut it = line.split_whitespace();
        let _proto = it.next();
        let local = it.next()?;
        // 端口要精确匹配，避免 :81880 之类被误命中
        if !local.ends_with(&needle) {
            continue;
        }
        if let Some(pid) = it.last().and_then(|s| s.parse::<u32>().ok()) {
            return Some(pid);
        }
    }
    None
}

/// 组装当前状态。抽出来是为了让 `comfy_start` 在持有启动锁时也能复用（不能把 State 移走）。
pub async fn status_of(state: &ComfyState) -> ComfyStatus {
    let running = port_open(PORT).await;
    let owned_pid = state.live_child_pid();
    let managed = owned_pid.is_some();
    let pid = match owned_pid {
        Some(p) => Some(p),
        None if running => pid_on_port(PORT).await,
        None => None,
    };
    ComfyStatus {
        running,
        managed,
        pid,
        port: PORT,
        root: state.root().to_string_lossy().to_string(),
        python_ok: state.python_exe().exists(),
    }
}

#[tauri::command]
pub async fn comfy_status(state: tauri::State<'_, ComfyState>) -> Result<ComfyStatus, String> {
    Ok(status_of(&state).await)
}

// ---------------------------------------------------------------- 启停

#[tauri::command]
pub async fn comfy_start(
    app: AppHandle,
    state: tauri::State<'_, ComfyState>,
) -> Result<ComfyStatus, String> {
    // 串行化：第二个调用者等第一次启动结束，然后看到已经就绪的状态，
    // 而不是在后端还没监听 8188 时被告知"启动完成"。
    let _guard = state.start_lock.lock().await;

    if port_open(PORT).await {
        return Ok(status_of(&state).await);
    }

    let root = state.root();
    // 已经有一个由画境拉起的进程时，等它，而不是再拉一个：
    // 重复启动会互相抢显存，而且 state.child 被覆盖之后前一个就再也管不住了。
    let managed_pid: Option<u32> = match state.live_child_pid() {
        Some(pid) => {
            state.push_log(format!("[画境] 已有画境启动的 ComfyUI 进程（PID {pid}），继续等待它就绪"));
            Some(pid)
        }
        None => {
            state.push_log(format!(
                "[画境] 启动 ComfyUI：{}",
                launch_command_preview(&root)
            ));
            let child = build_launch_command(&root)?
                .spawn()
                .map_err(|e| format!("启动失败：{e}"))?;
            let pid = child.id();

            // 跟随日志文件把输出喂给界面。ComfyUI 的输出是重定向到文件的（不是管道），
            // 所以这里只是读文件，读得慢或读不到都不影响它继续跑。
            let gen = state
                .log_gen
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1);
            spawn_log_tailer(app.clone(), root.clone(), state.logs.clone(), state.log_gen.clone(), gen);

            *state.child.lock().unwrap() = Some(child);
            pid
        }
    };
    let pid_text = managed_pid.map(|p| p.to_string()).unwrap_or_else(|| "未知".to_string());

    // 等待服务起来。ComfyUI 冷启动要几十秒，这里最多等 180 秒。
    for i in 0..360 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if port_open(PORT).await {
            let _ = app.emit("comfy://log", "[画境] ComfyUI 已就绪");
            return Ok(ComfyStatus {
                running: true,
                managed: true,
                pid: managed_pid,
                port: PORT,
                root: root.to_string_lossy().to_string(),
                python_ok: true,
            });
        }
        // 轮询期间看一眼子进程：启动失败（模型路径写错、显存不足、端口被占）会表现成
        // 一直"仍在等待后端"，其实进程早就退出了 —— 立即把日志里的原因带回去。
        let child_state = {
            let mut guard = state.child.lock().unwrap();
            match guard.as_mut() {
                None => 0,
                Some(child) => match child.try_wait() {
                    Ok(None) => 1,
                    _ => 2,
                },
            }
        };
        match child_state {
            2 => {
                *state.child.lock().unwrap() = None;
                let tail = read_log_tail(&root, 30).join("\n");
                return Err(format!(
                    "ComfyUI 启动后很快退出了（PID {pid_text}），请按日志排查。\n日志最后几行：\n{tail}"
                ));
            }
            0 => return Err("启动已被中止：ComfyUI 进程已被停止。".into()),
            _ => {}
        }
        if i % 20 == 19 {
            let _ = app.emit(
                "comfy://log",
                format!("[画境] 仍在等待后端就绪…（已 {}s）", (i + 1) / 2),
            );
        }
    }
    // 超时不杀进程：它可能只是冷启动特别慢，杀掉反而要用户重来一次。
    // 进程留在受管状态里，下一次启动会继续等它（见上面的 live_child_pid 分支）。
    let tail = read_log_tail(&root, 30).join("\n");
    Err(format!(
        "ComfyUI 启动超时（180 秒内未监听 8188），进程仍在运行（PID {pid_text}）。\n日志最后几行：\n{tail}"
    ))
}

#[tauri::command]
pub async fn comfy_stop(
    app: AppHandle,
    state: tauri::State<'_, ComfyState>,
) -> Result<(), String> {
    // 先尝试停掉自己拉起的进程
    let owned_pid = {
        let mut guard = state.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => {
                // id() 在 kill 之后就取不到了，必须先拿
                let pid = child.id();
                let _ = child.start_kill();
                *guard = None;
                pid
            }
            None => None,
        }
    };
    if let Some(pid) = owned_pid {
        // python 会派生子进程，用 taskkill /T 整棵树一起收掉
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await;
    }

    tokio::time::sleep(Duration::from_millis(800)).await;

    // 端口还占着，说明是外部启动的实例，按端口找进程杀
    if port_open(PORT).await {
        if let Some(pid) = pid_on_port(PORT).await {
            state.push_log(format!("[画境] 结束外部 ComfyUI 进程 PID {pid}"));
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .await;
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    }

    if port_open(PORT).await {
        return Err("端口 8188 仍被占用，可能有残留进程。".into());
    }
    let _ = app.emit("comfy://log", "[画境] ComfyUI 已关闭");
    Ok(())
}

/// 读日志。内存缓冲为空时回退去读日志文件尾部 —— 这样即使应用重启过
/// （内存缓冲没了），只要 ComfyUI 还在跑，日志面板依然有内容。
#[tauri::command]
pub fn comfy_logs(state: tauri::State<'_, ComfyState>) -> Vec<String> {
    let buf = state.logs.lock().unwrap().clone();
    if !buf.is_empty() {
        return buf;
    }
    read_log_tail(&state.root(), 400)
}

/// 读日志文件最后 n 行。读不到就返回空，不报错。
///
/// 按字节读再宽松解码，而不是 `read_to_string`：日志里可能混着非 UTF-8 字节
/// （旧版本启动的 ComfyUI 按本地代码页写 GBK 的进度块），严格解码会**整份失败**，
/// 日志面板于是什么都显示不出来。这里宁可让个别字符变成替换符，也不能丢掉整段日志。
pub fn read_log_tail(root: &Path, n: usize) -> Vec<String> {
    let path = console_log_path(root);
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(n);
    all[start..].iter().map(|s| s.to_string()).collect()
}

// ---------------------------------------------------------------- HTTP 命令
//
// 都是薄包装：真正的实现在上面的「可独立测试的 HTTP 层」里。

#[tauri::command]
pub async fn comfy_upload_image(
    state: tauri::State<'_, ComfyState>,
    path: String,
) -> Result<UploadedImage, String> {
    upload_image_to(&state.http, Path::new(&path)).await
}

#[tauri::command]
pub async fn comfy_queue_prompt(
    state: tauri::State<'_, ComfyState>,
    graph: Value,
    client_id: Option<String>,
) -> Result<QueuedPrompt, String> {
    let cid = client_id.unwrap_or_else(|| state.client_id.clone());
    queue_prompt_to(&state.http, &graph, &cid).await
}

#[tauri::command]
pub async fn comfy_history(
    state: tauri::State<'_, ComfyState>,
    prompt_id: String,
) -> Result<Option<Value>, String> {
    history_of(&state.http, &prompt_id).await
}

/// 队列状态，用于显示前面还有几个任务。
#[tauri::command]
pub async fn comfy_queue(state: tauri::State<'_, ComfyState>) -> Result<Value, String> {
    let resp = state
        .http
        .get(format!("{}/queue", base_url()))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(http_err)?;
    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn comfy_fetch_image(
    state: tauri::State<'_, ComfyState>,
    filename: String,
    subfolder: String,
    kind: String,
    dest_path: String,
) -> Result<String, String> {
    fetch_image_to(
        &state.http,
        &filename,
        &subfolder,
        &kind,
        Path::new(&dest_path),
    )
    .await
}

/// 列出某个模型目录下的文件（用于设置页自检）。
#[tauri::command]
pub async fn comfy_models(
    state: tauri::State<'_, ComfyState>,
    folder: String,
) -> Result<Vec<String>, String> {
    let resp = state
        .http
        .get(format!("{}/models/{folder}", base_url()))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(http_err)?;
    if !resp.status().is_success() {
        return Err(format!("读取模型列表失败：HTTP {}", resp.status()));
    }
    resp.json::<Vec<String>>().await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- WebSocket 进度

/// 确保 websocket 监听循环在跑。ComfyUI 的进度只走 websocket，没有 HTTP 接口，
/// 所以这里手写一个最小客户端：只要握手 + 读文本帧，不需要额外依赖。
pub async fn ensure_ws(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ComfyState>();
    if state
        .ws_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(()); // 已经在跑了
    }
    let client_id = state.client_id.clone();
    let logs = state.logs.clone();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            if !port_open(PORT).await {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            match ws_session(&app, &client_id).await {
                Ok(()) => {
                    let _ = app.emit("comfy://log", "[画境] 进度通道已断开，重连中…");
                }
                Err(e) => {
                    logs.lock()
                        .unwrap()
                        .push(format!("[画境] 进度通道异常：{e}"));
                }
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn comfy_ws_ensure(app: AppHandle) -> Result<(), String> {
    ensure_ws(&app).await
}

/// 设置页改 ComfyUI 根目录后调用。
#[tauri::command]
pub fn comfy_set_root(state: tauri::State<'_, ComfyState>, root: String) {
    state.set_root(PathBuf::from(root));
}

/// 本应用的 client id，前端提交任务时回传，保证能收到对应的进度。
#[tauri::command]
pub fn comfy_client_id(state: tauri::State<'_, ComfyState>) -> String {
    state.client_id.clone()
}

async fn ws_session(app: &AppHandle, client_id: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", PORT))
        .await
        .map_err(|e| e.to_string())?;

    let key = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(uuid::Uuid::new_v4().as_bytes())
    };
    let handshake = format!(
        "GET /ws?clientId={client_id} HTTP/1.1\r\n\
         Host: 127.0.0.1:{PORT}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    stream
        .write_all(handshake.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    // 读到空行结束，说明响应头收完了
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let mut b = [0u8; 1];
        let n = tokio::io::AsyncReadExt::read(&mut stream, &mut b)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("握手期间连接被关闭".into());
        }
        buf.push(b[0]);
        if buf.len() >= 4 && &buf[buf.len() - 4..] == b"\r\n\r\n" {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err("响应头异常过长".into());
        }
    }
    let head = String::from_utf8_lossy(&buf);
    if !head.starts_with("HTTP/1.1 101") {
        return Err(format!(
            "握手被拒绝：{}",
            head.lines().next().unwrap_or("(空响应)")
        ));
    }
    let _ = app.emit("comfy://log", "[画境] 进度通道已连接");

    // 读帧循环
    loop {
        let opcode = read_frame(&mut stream, app).await?;
        match opcode {
            Opcode::Close => return Ok(()),
            Opcode::Ping => { /* 忽略：ComfyUI 不要求客户端回 pong */ }
            _ => {}
        }
    }
}

enum Opcode {
    Text,
    Binary,
    Close,
    Ping,
    Pong,
    Other,
}

/// 读一帧。文本帧解析成 JSON 后通过事件推给前端，其余帧直接丢弃。
async fn read_frame(stream: &mut TcpStream, app: &AppHandle) -> Result<Opcode, String> {
    use tokio::io::AsyncReadExt;

    let mut hdr = [0u8; 2];
    stream.read_exact(&mut hdr).await.map_err(|e| e.to_string())?;
    let fin = hdr[0] & 0x80 != 0;
    let opcode = match hdr[0] & 0x0f {
        0x0 => Opcode::Other,
        0x1 => Opcode::Text,
        0x2 => Opcode::Binary,
        0x8 => Opcode::Close,
        0x9 => Opcode::Ping,
        0xa => Opcode::Pong,
        _ => Opcode::Other,
    };
    let masked = hdr[1] & 0x80 != 0;
    let mut len = (hdr[1] & 0x7f) as u64;
    if len == 126 {
        let mut b = [0u8; 2];
        stream.read_exact(&mut b).await.map_err(|e| e.to_string())?;
        len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
        let mut b = [0u8; 8];
        stream.read_exact(&mut b).await.map_err(|e| e.to_string())?;
        len = u64::from_be_bytes(b);
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask).await.map_err(|e| e.to_string())?;
    }

    // 只处理文本帧；二进制帧（预览图等）读掉丢弃，避免流错位
    if !matches!(opcode, Opcode::Text) {
        let mut sink = vec![0u8; len.min(8 * 1024 * 1024) as usize];
        if len > 0 {
            stream
                .read_exact(&mut sink)
                .await
                .map_err(|e| e.to_string())?;
        }
        return Ok(opcode);
    }
    if len > 4 * 1024 * 1024 {
        return Err("文本帧过大".into());
    }

    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .await
        .map_err(|e| e.to_string())?;
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    if !fin {
        // ComfyUI 的消息都很短，不会分片；真遇到分片就忽略
        return Ok(Opcode::Other);
    }

    if let Ok(v) = serde_json::from_slice::<Value>(&payload) {
        let _ = app.emit("comfy://progress", v);
    }
    Ok(Opcode::Text)
}

// ---------------------------------------------------------------- 杂项

/// 打开文件/文件夹（用系统默认程序）。
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("打开失败：{e}"))
}

/// 在资源管理器中定位到文件。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    Command::new("explorer")
        .arg(format!("/select,{}", p.display()))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("打开资源管理器失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 目录选择对话框。
#[tauri::command]
pub async fn pick_directory(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let t = title.unwrap_or_else(|| "选择文件夹".into());
    let res = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(t)
            .blocking_pick_folder()
            .map(|f| f.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res)
}

/// 多选图片文件。
#[tauri::command]
pub async fn pick_images(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let res = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "webp", "bmp"])
            .blocking_pick_files()
            .map(|fs| fs.into_iter().map(|f| f.to_string()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res.unwrap_or_default())
}

/// 应用数据目录，用于放设置、历史、图库索引。
pub fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| dirs::data_dir().unwrap_or_default().join("huajing"))
}

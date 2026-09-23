//! DeepSeek 提示词优化。
//!
//! 模型名不写死 —— 通过 `/v1/models` 实时探测，因为 DeepSeek 的模型命名会变
//! （用户明确要求支持探测）。界面上的下拉框直接来自这个接口。
//!
//! 提示词规范随二进制一起打包（`prompts/qwen-guide.md`，是本地 skill 的副本），
//! 所以优化功能不依赖外部 skill 目录是否存在。

use std::time::Duration;

use serde::{Deserialize, Serialize};

const BASE: &str = "https://api.deepseek.com";

/// 随应用打包的 Qwen-Image 2.1 提示词规范
const GUIDE: &str = include_str!("../prompts/qwen-guide.md");

/// DeepSeek 调用要能走 HTTPS，所以单独建一个客户端。
/// 注意这里**不**设 no_proxy —— 用户如果配了系统代理，应该让它生效。
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .user_agent("huajing/1.0")
        .build()
        .map_err(|e| format!("构建网络客户端失败：{e}"))
}

/// 把 HTTP 层的失败翻译成用户能照着处理的话
fn friendly(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| v["message"].as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| body.chars().take(200).collect());

    match status {
        401 => "API Key 无效或已过期，请到「设置」里重新填写。".into(),
        402 => format!("DeepSeek 账户余额不足。{detail}"),
        403 => "API Key 没有访问该模型的权限。".into(),
        429 => "请求过于频繁，稍等一下再试。".into(),
        500..=599 => format!("DeepSeek 服务端出错（HTTP {status}）。{detail}"),
        _ => format!("请求失败（HTTP {status}）：{detail}"),
    }
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "连接 DeepSeek 超时。如果开了代理，检查一下代理是否正常。".into()
    } else if e.is_connect() {
        "连接不上 DeepSeek。检查网络，或到「设置」里确认代理配置。".into()
    } else {
        format!("网络请求失败：{e}")
    }
}

/// 取 API Key。环境变量优先于设置页里存的 —— 这样不想把 Key 落盘的人
/// 可以设 DEEPSEEK_API_KEY，然后把设置里的清空。
fn key_or_err(api_key: &str) -> Result<String, String> {
    let from_env = std::env::var("DEEPSEEK_API_KEY").unwrap_or_default();
    let k = if from_env.trim().is_empty() {
        api_key.trim().to_string()
    } else {
        from_env.trim().to_string()
    };
    if k.is_empty() {
        return Err(
            "还没有配置 DeepSeek API Key。请到「设置 → DeepSeek」里填写，             或设置环境变量 DEEPSEEK_API_KEY。"
                .into(),
        );
    }
    Ok(k)
}

// ---------------------------------------------------------------- 模型探测

#[derive(Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub owned_by: String,
}

#[derive(Deserialize)]
struct ModelsResp {
    #[serde(default)]
    data: Vec<ModelInfo>,
}

/// 列出可用模型。界面上的下拉框直接用它，所以模型改名不用改代码。
#[tauri::command]
pub async fn deepseek_models(api_key: String) -> Result<Vec<ModelInfo>, String> {
    let key = key_or_err(&api_key)?;
    let resp = client()?
        .get(format!("{BASE}/v1/models"))
        .bearer_auth(&key)
        .send()
        .await
        .map_err(net_err)?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(friendly(status.as_u16(), &text));
    }
    let parsed: ModelsResp =
        serde_json::from_str(&text).map_err(|e| format!("模型列表解析失败：{e}"))?;

    let mut list = parsed.data;
    // 稳定的展示顺序
    list.sort_by(|a, b| a.id.cmp(&b.id));
    if list.is_empty() {
        return Err("DeepSeek 返回的模型列表是空的。".into());
    }
    Ok(list)
}

// ---------------------------------------------------------------- 提示词优化

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}
#[derive(Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: String,
}
#[derive(Deserialize)]
struct ChatResp {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

/// 按模式拼系统提示词。把规范全文 + 该模式的具体任务一起给模型。
pub fn system_prompt(mode: &str, ref_count: usize) -> String {
    let task = match mode {
        "txt2img" => "任务：把用户的想法改写成**一条** Qwen-Image 2.1 文生图提示词。\n\
            按「主体 → 动作姿态 → 环境场景 → 光线氛围 → 画风质感」的顺序写成完整句子，\
            不要堆砌关键词。用户没提到的内容不要凭空添加，可以合理补充光线、材质、画风这类修饰，\
            但不要改变主体和场景。"
            .to_string(),
        "edit" => "任务：把用户的要求改写成**一条** Qwen-Image 2.1 图编辑提示词。\n\
            必须套用公式：改什么 + 改成什么 + 什么保持不变。\n\
            「什么保持不变」这一句不能省 —— 否则模型会顺手改掉别的地方。"
            .to_string(),
        "multiref" | "multiref2k" => format!(
            "任务：把用户的要求改写成**一条** Qwen-Image 2.1 多参考图提示词。\n\
             当前有 {ref_count} 张参考图，提示词里用 <image1>…<image{ref_count}> 引用它们。\n\
             写清每张图各自负责什么（例如：保持<image1>的人物与姿势，穿上<image2>的服装，\
             背景换成<image3>的场景），并明确哪些要保持不变。"
        ),
        "upscale" => "任务：把用户的要求改写成**一条**用于放大后精修的提示词。\n\
            这种提示词应该简短，主要描述画质与细节方向（例如 masterpiece, 8k, highly detailed, \
            sharp focus, fine texture），不要引入新的画面内容 —— 精修阶段的降噪很低，\
            写进去的新内容只会造成画面走形。"
            .to_string(),
        _ => "任务：把用户的要求改写成一条规范的 Qwen-Image 2.1 提示词。".to_string(),
    };

    format!(
        "你是 Qwen-Image 2.1 的提示词工程师。下面是你必须遵守的规范：\n\n\
         {GUIDE}\n\n\
         ---\n\n{task}\n\n\
         ## 输出要求\n\
         - 只输出改写后的提示词本身。不要解释、不要加引号、不要用 Markdown 代码块、不要写「优化后：」之类的前缀。\n\
         - 用户用中文你就用中文，用英文你就用英文。\n\
         - 用户已经写了 <imageN> 标签的，原样保留，不要改写标签里的数字。\n\
         - 如果用户的原话已经很规范，就只做小幅润色，不要为了显得做了事而大改。"
    )
}

#[derive(Serialize)]
struct ChatBody {
    model: String,
    messages: Vec<serde_json::Value>,
    temperature: f32,
    max_tokens: u32,
    stream: bool,
}

/// 调用 DeepSeek 改写提示词，返回改写结果。
#[tauri::command]
pub async fn deepseek_optimize(
    api_key: String,
    model: String,
    mode: String,
    prompt: String,
    ref_count: usize,
    extra: String,
) -> Result<String, String> {
    let key = key_or_err(&api_key)?;
    if model.trim().is_empty() {
        return Err("还没有选择模型。到「设置 → DeepSeek」点一下「获取模型列表」。".into());
    }
    if prompt.trim().is_empty() {
        return Err("提示词是空的，先写点东西再优化。".into());
    }

    let mut user = prompt.clone();
    if !extra.trim().is_empty() {
        // 额外要求（例如用户标注了区域）作为补充信息给模型
        user = format!("{prompt}\n\n补充信息：{extra}");
    }

    let body = ChatBody {
        model: model.trim().to_string(),
        messages: vec![
            serde_json::json!({ "role": "system", "content": system_prompt(&mode, ref_count) }),
            serde_json::json!({ "role": "user", "content": user }),
        ],
        // 改写任务要稳，不要发挥
        temperature: 0.3,
        max_tokens: 1200,
        stream: false,
    };

    let resp = client()?
        .post(format!("{BASE}/v1/chat/completions"))
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
        .map_err(net_err)?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(friendly(status.as_u16(), &text));
    }

    let parsed: ChatResp =
        serde_json::from_str(&text).map_err(|e| format!("响应解析失败：{e}"))?;
    let out = parsed
        .choices
        .first()
        .map(|c| c.message.content.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "DeepSeek 返回了空内容，换个模型再试试。".to_string())?;

    // 有些模型会不听话地包一层代码块，这里兜底剥掉
    let cleaned = strip_wrapper(&out);
    Ok(cleaned)
}

/// 剥掉模型偶尔自作主张加上的包装（代码块、引号、「优化后：」前缀）。
pub fn strip_wrapper(s: &str) -> String {
    let mut t = s.trim().to_string();
    if t.starts_with("```") {
        // 去掉首行的 ```xxx 和结尾的 ```
        if let Some(nl) = t.find('\n') {
            t = t[nl + 1..].to_string();
        }
        if let Some(i) = t.rfind("```") {
            t = t[..i].to_string();
        }
        t = t.trim().to_string();
    }
    for prefix in ["优化后：", "优化后:", "改写后：", "改写后:", "提示词：", "提示词:"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim().to_string();
        }
    }
    // 整段被引号包住的情况
    if t.len() >= 2 {
        let first = t.chars().next().unwrap();
        let last = t.chars().last().unwrap();
        if (first == '"' && last == '"') || (first == '「' && last == '」') {
            let inner: String = t.chars().skip(1).take(t.chars().count() - 2).collect();
            t = inner.trim().to_string();
        }
    }
    t
}

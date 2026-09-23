import type { Graph } from "./graphs";
import type { VideoCapabilities } from "./tauri";

export interface VideoOptions {
  length: number;
  capabilities: VideoCapabilities;
}

/**
 * 把视频参数复制成只含普通值的对象。
 *
 * 界面上的 `videoCapability` 是 `ref` 包出来的对象，取 `.value` 拿到的是 Vue 的
 * 响应式 Proxy。Proxy 不能交给 `structuredClone()`（会抛 DataCloneError），
 * 也不能直接塞进要序列化给 Rust 的请求里，所以进任务引擎前先摊平成显式快照。
 */
export function snapshotVideoOptions(video: VideoOptions): VideoOptions {
  const c = video.capabilities;
  const models = c?.models;
  return {
    length: Number(video.length),
    capabilities: {
      ready: c?.ready === true,
      missing_nodes: [...(c?.missing_nodes ?? [])],
      missing_models: [...(c?.missing_models ?? [])],
      models: {
        unet: String(models?.unet ?? ""),
        clip: String(models?.clip ?? ""),
        video_vae: String(models?.video_vae ?? ""),
        audio_vae: String(models?.audio_vae ?? ""),
        lora: String(models?.lora ?? ""),
      },
      // 缺字段时按「不支持」处理：宁可拦住也不要发一个会被后端拒绝的图
      supports_last_frame: c?.supports_last_frame === true,
      save_video_dynamic: c?.save_video_dynamic === true,
      message: String(c?.message ?? ""),
    },
  };
}

/** 与本机 H3 Turbo 12 步工作流、当前节点 schema 对齐。 */
export function buildVideo(o: {
  prompt: string; refs: string[]; width: number; height: number; seed: number;
  filenamePrefix: string; video: VideoOptions;
}): Graph {
  if (!o.refs[0]) throw new Error("请选择视频首帧。");
  if (!o.video.capabilities.ready) throw new Error(o.video.capabilities.message);
  if (o.refs[1] && !o.video.capabilities.supports_last_frame) throw new Error("当前 H3 节点不支持尾帧，请更新 ComfyUI。");
  if (![124, 243, 362].includes(o.video.length)) throw new Error("请选择支持的视频时长。");
  if (![[864, 480], [480, 864], [640, 640]].some(([w, h]) => w === o.width && h === o.height)) {
    throw new Error("请选择支持的视频尺寸。");
  }
  const m = o.video.capabilities.models;
  const g: Graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: m.unet, weight_dtype: "fp8_e4m3fn_fast" } },
    "2": { class_type: "MiniMaxH3TurboLoRA", inputs: { model: ["1", 0], lora_name: m.lora, strength: 1 } },
    "3": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["2", 0], shift_video: 12, shift_audio: 3 } },
    "4": { class_type: "CLIPLoader", inputs: { clip_name: m.clip, type: "minimax", device: "cpu" } },
    "5": { class_type: "VAELoader", inputs: { vae_name: m.video_vae } },
    "6": { class_type: "VAELoader", inputs: { vae_name: m.audio_vae } },
    "7": { class_type: "LoadImage", inputs: { image: o.refs[0] } },
    "8": { class_type: "ImageScale", inputs: { image: ["7", 0], upscale_method: "lanczos", width: o.width, height: o.height, crop: "center" } },
    "9": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["4", 0], vae: ["5", 0], prompt: o.prompt, width: o.width, height: o.height, length: o.video.length, first_frame: ["8", 0] } },
    "10": { class_type: "BasicGuider", inputs: { model: ["3", 0], conditioning: ["9", 0] } },
    "11": { class_type: "MiniMaxH3TurboSampler", inputs: {} },
    "12": { class_type: "BasicScheduler", inputs: { model: ["3", 0], scheduler: "simple", steps: 12, denoise: 1 } },
    "13": { class_type: "RandomNoise", inputs: { noise_seed: o.seed } },
    "14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["10", 0], sampler: ["11", 0], sigmas: ["12", 0], latent_image: ["9", 1] } },
    "15": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["5", 0] } },
    "16": { class_type: "VAEDecodeAudio", inputs: { samples: ["14", 0], vae: ["6", 0] } },
    "17": { class_type: "CreateVideo", inputs: { images: ["15", 0], fps: 24, audio: ["16", 0] } },
    "18": { class_type: "SaveVideo", inputs: { video: ["17", 0], filename_prefix: o.filenamePrefix, format: "mp4", ...(o.video.capabilities.save_video_dynamic ? { "format.codec": "h264", "format.codec.encoding": "auto" } : { codec: "h264" }) } },
  };
  if (o.refs[1]) {
    g["19"] = { class_type: "LoadImage", inputs: { image: o.refs[1] } };
    // 首尾帧必须使用相同的目标尺寸，否则 H3 会在尾帧阶段产生拉伸或跳变。
    g["20"] = { class_type: "ImageScale", inputs: { image: ["19", 0], upscale_method: "lanczos", width: o.width, height: o.height, crop: "center" } };
    g["9"].inputs.last_frame = ["20", 0];
  }
  return g;
}

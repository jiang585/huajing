/**
 * `src/api/tauri` 的替身。
 *
 * 每个函数都先记录调用（`calls`），再交给用例设定的 `handlers`（没设就用默认实现）。
 * 这样回归用例既可以断言"到底调了几次、参数是什么"，也可以人为控制时序
 * （比如让启动请求挂住不返回，制造并发窗口）。
 */

import type { ComfyStatus, ImageInfo, UploadedImage, VideoCapabilities } from "../../../src/api/tauri";

export const calls: Record<string, unknown[][]> = {};
export const handlers: Record<string, (...args: never[]) => unknown> = {};

export function resetFakes() {
  for (const key of Object.keys(calls)) delete calls[key];
  for (const key of Object.keys(handlers)) delete handlers[key];
}

export function count(name: string): number {
  return calls[name]?.length ?? 0;
}

export function last(name: string): unknown[] | undefined {
  const list = calls[name];
  return list?.[list.length - 1];
}

function stub<F extends (...args: never[]) => unknown>(name: string, fallback: F): F {
  const wrapped = ((...args: never[]) => {
    (calls[name] ??= []).push(args);
    const handler = handlers[name];
    return handler ? handler(...args) : fallback(...args);
  }) as F;
  return wrapped;
}

export function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 立刻挂起的 Promise，用来表示"这个请求还没回来" */
export const never = () => new Promise<never>(() => undefined);

// ---------------------------------------------------------------- 固定件

export const STATUS: ComfyStatus = {
  running: true,
  managed: true,
  pid: 4242,
  port: 8188,
  root: "E:\\ComfyUI",
  python_ok: true,
};

export const CAPS: VideoCapabilities = {
  ready: true,
  missing_nodes: [],
  missing_models: [],
  models: {
    unet: "H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    video_vae: "minimax_h3_video_vae_fp16.safetensors",
    audio_vae: "minimax_h3_audio_vae_fp32.safetensors",
    lora: "minimax_h3_turbo_4step_ckpt500.safetensors",
  },
  supports_last_frame: true,
  save_video_dynamic: true,
  message: "本机 MiniMax H3 Turbo 已就绪，使用本地模型生成视频。",
};

export const IMAGE_INFO: ImageInfo = {
  path: "",
  exists: true,
  width: 1024,
  height: 1024,
  bytes: 1024,
  thumb: null,
};

/** ComfyUI /history 里"跑完了"的记录，图片与视频各一份 */
export function completedRecord(kind: "image" | "video" = "image") {
  const filename = kind === "video" ? "huajing_00001.mp4" : "huajing_00001_.png";
  const field = kind === "video" ? "videos" : "images";
  return {
    status: { completed: true, status_str: "success" },
    outputs: {
      9: { [field]: [{ filename, subfolder: "画境/文生图", type: "output" }] },
    },
  };
}

export function interruptedRecord() {
  return {
    status: {
      completed: false,
      status_str: "error",
      messages: [["execution_interrupted", {}]],
    },
    outputs: {},
  };
}

// ---------------------------------------------------------------- 后端

export const comfyStatus = stub("comfyStatus", async () => ({ ...STATUS }));
export const comfyStart = stub("comfyStart", async () => ({ ...STATUS }));
export const comfyStop = stub("comfyStop", async () => undefined);
export const comfyLogs = stub("comfyLogs", async () => [] as string[]);
export const comfySetRoot = stub("comfySetRoot", async () => undefined);
export const comfyClientId = stub("comfyClientId", async () => "client-test");
export const comfyWsEnsure = stub("comfyWsEnsure", async () => undefined);
export const comfyModels = stub("comfyModels", async () => [] as string[]);
export const comfyCancelPrompt = stub("comfyCancelPrompt", async () => "interrupted");
export const comfyQueue = stub("comfyQueue", async () => ({ queue_running: [], queue_pending: [] }));

// ---------------------------------------------------------------- 任务

export const uploadImage = stub(
  "uploadImage",
  async () => ({ name: "huajing_ref.png", subfolder: "huajing", kind: "input" }) as UploadedImage,
);

export const queuePrompt = stub(
  "queuePrompt",
  async () => ({ prompt_id: "prompt-test", number: 1 }),
);

export const fetchHistory = stub("fetchHistory", async () => null);

export const fetchImage = stub("fetchImage", async (...args: never[]) => String(args[3]));
export const fetchVideo = stub("fetchVideo", async (...args: never[]) => String(args[3]));

export const comfyVideoCapabilities = stub("comfyVideoCapabilities", async () => ({ ...CAPS }));

// ---------------------------------------------------------------- 文件

export const imageInfo = stub("imageInfo", async (path: never) => ({ ...IMAGE_INFO, path: String(path) }));
export const imageInfos = stub("imageInfos", async (paths: never) =>
  (paths as unknown as string[]).map((path) => ({ ...IMAGE_INFO, path })),
);
export const buildOutputPath = stub(
  "buildOutputPath",
  async (...args: never[]) => `G:\\画境输出\\${String(args[1])}\\out-${count("buildOutputPath")}.png`,
);
export const copyFile = stub("copyFile", async () => "G:\\画境输出\\copy.png");
export const deleteFile = stub("deleteFile", async () => undefined);
export const dirStats = stub("dirStats", async () => [0, 0] as [number, number]);
export const openPath = stub("openPath", async () => undefined);
export const revealPath = stub("revealPath", async () => undefined);
export const pathExists = stub("pathExists", async () => true);
export const pickDirectory = stub("pickDirectory", async () => null);
export const pickImages = stub("pickImages", async () => [] as string[]);
export const saveDataUrl = stub("saveDataUrl", async () => "G:\\annotated.png");
export const pruneDir = stub("pruneDir", async () => 0);

// ---------------------------------------------------------------- DeepSeek

export const deepseekModels = stub("deepseekModels", async () => []);
export const deepseekOptimize = stub("deepseekOptimize", async () => "");

// ---------------------------------------------------------------- 隐私空间

export const vaultStatus = stub("vaultStatus", async () => ({
  enabled: true,
  unlocked: true,
  count: 0,
  hint: null,
  iterations: 1,
}));
export const vaultEnable = stub("vaultEnable", async () => ({
  enabled: true,
  unlocked: true,
  count: 0,
  hint: null,
  iterations: 1,
}));
export const vaultUnlock = stub("vaultUnlock", async () => true);
export const vaultLock = stub("vaultLock", async () => undefined);
export const vaultChangePassword = stub("vaultChangePassword", async () => undefined);
export const vaultDisable = stub("vaultDisable", async () => undefined);
export const vaultList = stub("vaultList", async () => []);
export const vaultImport = stub("vaultImport", async () => []);
export const vaultExport = stub("vaultExport", async () => []);
export const vaultDelete = stub("vaultDelete", async () => 0);
export const vaultThumb = stub("vaultThumb", async () => "");
export const vaultPreview = stub("vaultPreview", async () => "");
export const vaultSaveAs = stub("vaultSaveAs", async () => "");

// ---------------------------------------------------------------- 持久化

export const storeLoad = stub("storeLoad", async () => null);
export const storeSave = stub("storeSave", async () => undefined);
export const storeDirPath = stub("storeDirPath", async () => "C:\\data\\huajing");
export const appPaths = stub("appPaths", async () => ({
  data_dir: "C:\\data\\huajing",
  thumb_dir: "C:\\data\\huajing\\thumbs",
  version: "1.1.1",
}));

// ---------------------------------------------------------------- 事件与地址

export const onProgress = stub("onProgress", async () => () => undefined);
export const onLog = stub("onLog", async () => () => undefined);

export function fileUrl(path: string | null | undefined): string {
  return path ? `asset://${path}` : "";
}

export function thumbUrl(info: { path?: string; thumb?: string | null } | null | undefined, fallbackPath?: string | null): string {
  if (info?.thumb) return `asset://${info.thumb}`;
  if (info?.path) return `asset://${info.path}`;
  return fallbackPath ? `asset://${fallbackPath}` : "";
}

export function formatBytes(n: number): string {
  return `${n} B`;
}

export function formatDuration(ms: number): string {
  return `${Math.round(ms / 1000)} 秒`;
}

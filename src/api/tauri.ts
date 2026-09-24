/**
 * Rust 侧命令的类型化封装。
 *
 * 前端不直接 fetch ComfyUI（会被 CORS 拦），所有网络与文件操作都通过这里的 invoke。
 */

import { invoke as tauriInvoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Graph } from "./graphs";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

function browserFallback<T>(cmd: string, args?: Record<string, unknown>): T {
  if (cmd === "comfy_status") {
    return {
      running: true,
      managed: false,
      pid: 8188,
      port: 8188,
      root: "E:\\ComfyUI",
      python_ok: true,
    } as T;
  }
  if (cmd === "store_load") {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(`hj_store_${args?.name}`) : null;
    return (raw ? JSON.parse(raw) : null) as T;
  }
  if (cmd === "store_save") {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`hj_store_${args?.name}`, JSON.stringify(args?.data));
    }
    return undefined as T;
  }
  if (cmd === "app_paths") {
    return { data_dir: "G:\\huajing", thumb_dir: "G:\\huajing\\thumbs", version: "1.1.1 (Studio 2.0)" } as T;
  }
  if (cmd === "store_dir_path") {
    return "G:\\huajing" as T;
  }
  if (cmd === "vault_status") {
    return { enabled: false, unlocked: false, count: 0, hint: "" } as T;
  }
  if (cmd === "comfy_video_capabilities") {
    return {
      ready: true,
      missing_nodes: [],
      missing_models: [],
      models: { unet: "minimax_h3", clip: "qwen", video_vae: "vae", audio_vae: "audio", lora: "lora" },
      supports_last_frame: true,
      save_video_dynamic: true,
      message: "工作流已就绪",
    } as T;
  }
  if (cmd === "image_info") {
    return { path: args?.path as string, exists: true, width: 1024, height: 1024, bytes: 1024000, thumb: null } as T;
  }
  if (cmd === "image_infos") {
    const paths = (args?.paths as string[]) ?? [];
    return paths.map((p) => ({ path: p, exists: true, width: 1024, height: 1024, bytes: 1024000, thumb: null })) as T;
  }
  if (cmd === "comfy_logs") {
    return ["ComfyUI 2.0 Studio Preview Engine Initialized."] as T;
  }
  return undefined as T;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    return tauriInvoke<T>(cmd, args);
  }
  return Promise.resolve(browserFallback<T>(cmd, args));
}

// ---------------------------------------------------------------- 类型

export interface ComfyStatus {
  running: boolean;
  managed: boolean;
  pid: number | null;
  port: number;
  root: string;
  python_ok: boolean;
}

export interface UploadedImage {
  name: string;
  subfolder: string;
  kind: string;
}

export interface QueuedPrompt {
  prompt_id: string;
  number: number | null;
}

export interface OutputImage {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ImageInfo {
  path: string;
  exists: boolean;
  width: number;
  height: number;
  bytes: number;
  thumb: string | null;
}

export interface AppPaths {
  data_dir: string;
  thumb_dir: string;
  version: string;
}

/** ComfyUI websocket 推来的消息 */
export interface WsMessage {
  type: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------- 后端管理

export const comfyStatus = () => invoke<ComfyStatus>("comfy_status");
export const comfyStart = () => invoke<ComfyStatus>("comfy_start");
export const comfyStop = () => invoke<void>("comfy_stop");
export const comfyLogs = () => invoke<string[]>("comfy_logs");
export const comfySetRoot = (root: string) => invoke<void>("comfy_set_root", { root });
export const comfyClientId = () => invoke<string>("comfy_client_id");
export const comfyWsEnsure = () => invoke<void>("comfy_ws_ensure");
export const comfyModels = (folder: string) => invoke<string[]>("comfy_models", { folder });

export const comfyCancelPrompt = (promptId: string) => invoke<string>("comfy_cancel_prompt", { promptId });
export const comfyQueue = () =>
  invoke<{ queue_running: unknown[]; queue_pending: unknown[] }>("comfy_queue");

// ---------------------------------------------------------------- RolePlayChat LAN bridge

export const lanPairingCode = () => invoke<string>("lan_pairing_code");
export const lanDevices = () => invoke<Array<{ deviceId: string; deviceName: string; appInstanceId: string; createdAt: number; lastSeenAt: number }>>("lan_devices");
export interface LanJob {
  jobId: string;
  clientJobId: string;
  status: string;
  stage: string;
  progress: number;
  resultAssetId: string | null;
  errorCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}
export const lanJobs = () => invoke<LanJob[]>("lan_jobs");
export const lanRevokeDevice = (deviceId: string) => invoke<boolean>("lan_revoke_device", { deviceId });

// ---------------------------------------------------------------- 任务

export const uploadImage = (path: string) =>
  invoke<UploadedImage>("comfy_upload_image", { path });

export const queuePrompt = (graph: Graph, clientId?: string) =>
  invoke<QueuedPrompt>("comfy_queue_prompt", { graph, clientId: clientId ?? null });

export const fetchHistory = (promptId: string) =>
  invoke<Record<string, unknown> | null>("comfy_history", { promptId });

export const fetchImage = (
  filename: string,
  subfolder: string,
  kind: string,
  destPath: string,
) => invoke<string>("comfy_fetch_image", { filename, subfolder, kind, destPath });

export const fetchVideo = (filename: string, subfolder: string, kind: string, destPath: string) =>
  invoke<string>("comfy_fetch_video", { filename, subfolder, kind, destPath });

export interface VideoCapabilities {
  ready: boolean;
  missing_nodes: string[];
  missing_models: string[];
  models: { unet: string; clip: string; video_vae: string; audio_vae: string; lora: string };
  supports_last_frame: boolean;
  save_video_dynamic: boolean;
  message: string;
}
export const comfyVideoCapabilities = () => invoke<VideoCapabilities>("comfy_video_capabilities");

// ---------------------------------------------------------------- 文件

export const imageInfo = (path: string) => invoke<ImageInfo>("image_info", { path });
export const imageInfos = (paths: string[]) => invoke<ImageInfo[]>("image_infos", { paths });
export const buildOutputPath = (
  baseDir: string,
  subfolder: string,
  prefix: string,
  ext: string,
) => invoke<string>("build_output_path", { baseDir, subfolder, prefix, ext });
export const copyFile = (src: string, destDir: string) =>
  invoke<string>("copy_file", { src, destDir });
export const deleteFile = (path: string) => invoke<void>("delete_file", { path });
export const dirStats = (path: string) => invoke<[number, number]>("dir_stats", { path });

export const openPath = (path: string) => invoke<void>("open_path", { path });
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });
export const pickDirectory = (title?: string) =>
  invoke<string | null>("pick_directory", { title: title ?? null });
export const pickImages = () => invoke<string[]>("pick_images");

/** 把 canvas 导出的 data URL 落成图片（画面标注用） */
export const saveDataUrl = (dataUrl: string, destPath: string) =>
  invoke<string>("save_data_url", { dataUrl, destPath });

/** 清理目录下超出保留数量的旧文件 */
export const pruneDir = (path: string, keep: number) =>
  invoke<number>("prune_dir", { path, keep });

// ---------------------------------------------------------------- DeepSeek

export interface DeepSeekModel {
  id: string;
  owned_by: string;
}

/** 探测可用模型。模型命名会变，所以不写死，从接口实时拉。 */
export const deepseekModels = (apiKey: string) =>
  invoke<DeepSeekModel[]>("deepseek_models", { apiKey });

export const deepseekOptimize = (opts: {
  apiKey: string;
  model: string;
  mode: string;
  prompt: string;
  refCount: number;
  extra?: string;
}) =>
  invoke<string>("deepseek_optimize", {
    apiKey: opts.apiKey,
    model: opts.model,
    mode: opts.mode,
    prompt: opts.prompt,
    refCount: opts.refCount,
    extra: opts.extra ?? "",
  });

// ---------------------------------------------------------------- 隐私空间

export interface VaultStatus {
  enabled: boolean;
  unlocked: boolean;
  /** 只有解锁后才给数量，锁定时连张数都不透露 */
  count: number | null;
  hint: string | null;
  iterations: number;
}

export interface VaultEntry {
  id: string;
  name: string;
  added_at: number;
  width: number;
  height: number;
  bytes: number;
  from: string;
  prompt: string;
  params: Record<string, unknown>;
}

export interface VaultImportItem {
  path: string;
  from?: string;
  prompt?: string;
  params?: Record<string, unknown>;
}

/** 移出结果：条目元数据 + 实际落盘路径（文件名由 Rust 生成，前端猜不到） */
export interface VaultExported {
  entry: VaultEntry;
  path: string;
}

export const vaultStatus = () => invoke<VaultStatus>("vault_status");
export const vaultEnable = (password: string, hint: string) =>
  invoke<VaultStatus>("vault_enable", { password, hint });
export const vaultUnlock = (password: string) =>
  invoke<boolean>("vault_unlock", { password });
export const vaultLock = () => invoke<void>("vault_lock");
export const vaultChangePassword = (oldPassword: string, newPassword: string) =>
  invoke<void>("vault_change_password", { oldPassword, newPassword });
export const vaultDisable = (password: string) => invoke<void>("vault_disable", { password });
export const vaultList = () => invoke<VaultEntry[]>("vault_list");
export const vaultImport = (items: VaultImportItem[]) =>
  invoke<VaultEntry[]>("vault_import", { items });
export const vaultExport = (ids: string[], destDir: string) =>
  invoke<VaultExported[]>("vault_export", { ids, destDir });
export const vaultDelete = (ids: string[]) => invoke<number>("vault_delete", { ids });
/** 缩略图：解密后在内存里转 base64，不落明文到磁盘 */
export const vaultThumb = (id: string) => invoke<string>("vault_thumb", { id });
export const vaultPreview = (id: string) => invoke<string>("vault_preview", { id });
export const vaultSaveAs = (id: string, destPath: string) =>
  invoke<string>("vault_save_as", { id, destPath });

// ---------------------------------------------------------------- 持久化

export const storeLoad = <T>(name: string) => invoke<T | null>("store_load", { name });
export const storeSave = (name: string, data: unknown) =>
  invoke<void>("store_save", { name, data });
export const storeDirPath = () => invoke<string>("store_dir_path");
export const appPaths = () => invoke<AppPaths>("app_paths");

// ---------------------------------------------------------------- 事件

export const onProgress = (cb: (m: WsMessage) => void): Promise<UnlistenFn> => {
  if (isTauri) return listen<WsMessage>("comfy://progress", (e) => cb(e.payload));
  return Promise.resolve(() => {});
};

export const onLog = (cb: (line: string) => void): Promise<UnlistenFn> => {
  if (isTauri) return listen<string>("comfy://log", (e) => cb(e.payload));
  return Promise.resolve(() => {});
};

// ---------------------------------------------------------------- 图片地址

/** 把本地绝对路径转成 WebView 能加载的 URL（走 Tauri 的 asset 协议）。 */
export function fileUrl(path: string | null | undefined): string {
  if (!path) return "";
  try {
    if (isTauri) return convertFileSrc(path);
    return path;
  } catch {
    return path;
  }
}

/**
 * 优先用缩略图，没有就退回原图。
 *
 * `fallbackPath` 是关键：`image_infos` 是异步的（要给新图解码、生成缩略图，
 * 2K 图要好几秒），在那个窗口期里 `infos[p]` 还是 undefined。此时如果不给兜底，
 * `<img>` 的 src 会是空字符串 —— 浏览器会把图**清空**，面板先是一片空白再跳一下，
 * 看起来就像「刚生成的结果没出来」。用原图路径兜底，新图立刻就能显示。
 */
export function thumbUrl(
  info: Pick<ImageInfo, "path" | "thumb"> | null | undefined,
  fallbackPath?: string | null,
): string {
  if (info?.thumb) return fileUrl(info.thumb);
  if (info?.path) return fileUrl(info.path);
  return fileUrl(fallbackPath ?? "");
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
}

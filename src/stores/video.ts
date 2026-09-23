import { reactive, ref, toRef, watch } from "vue";
import { comfyVideoCapabilities, storeLoad, storeSave, type VideoCapabilities } from "../api/tauri";
import { backend, startBackend } from "./backend";
import { beginJobPrepare, generate, job, randomSeed } from "./job";
import { lastResults } from "./results";
import type { HistoryEntry } from "./history";

export interface VideoFormState {
  prompt: string;
  firstFrame: string | null;
  lastFrame: string | null;
  size: "864x480" | "480x864" | "640x640";
  length: 124 | 243 | 362;
  seed: number;
  randomSeed: boolean;
}

const DEFAULT_FORM: VideoFormState = {
  prompt: "",
  firstFrame: null,
  lastFrame: null,
  size: "864x480",
  length: 124,
  seed: randomSeed(),
  randomSeed: true,
};

export const videoForm = reactive<VideoFormState>({ ...DEFAULT_FORM });
export const videoCapability = ref<VideoCapabilities | null>(null);
export const videoChecking = ref(false);
export const videoError = ref("");
/** 视频结果与图片结果存在同一张表里：谁先落盘谁写，界面按模式读。 */
export const videoResults = toRef(lastResults, "video");

let loaded = false;
let saveTimer: number | null = null;

export async function initVideoStore() {
  if (loaded) return;
  loaded = true;
  const saved = await storeLoad<Partial<VideoFormState> & { results?: string[] }>("video_form");
  if (saved) {
    if (typeof saved.prompt === "string") videoForm.prompt = saved.prompt;
    if (typeof saved.firstFrame === "string") videoForm.firstFrame = saved.firstFrame;
    if (typeof saved.lastFrame === "string") videoForm.lastFrame = saved.lastFrame;
    if (["864x480", "480x864", "640x640"].includes(saved.size ?? "")) videoForm.size = saved.size as VideoFormState["size"];
    if ([124, 243, 362].includes(saved.length ?? 0)) videoForm.length = saved.length as VideoFormState["length"];
    if (Number.isSafeInteger(saved.seed) && Number(saved.seed) >= 0) videoForm.seed = Number(saved.seed);
    if (typeof saved.randomSeed === "boolean") videoForm.randomSeed = saved.randomSeed;
    if (Array.isArray(saved.results)) videoResults.value = saved.results.filter((path): path is string => typeof path === "string");
  }
  watch(
    () => JSON.stringify({ ...videoForm, results: videoResults.value }),
    () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        storeSave("video_form", { ...videoForm, results: videoResults.value }).catch(() => undefined);
      }, 700);
    },
  );
}

let capabilityTask: Promise<VideoCapabilities | null> | null = null;

/**
 * 检测本机视频工作流。
 *
 * 并发的调用共享同一次检测：视频页监听到后端启动会自动检测，用户点生成时又会要求
 * 检测一次。旧实现在「已有检测进行中」时直接返回，生成流程因此可能拿到空能力值，
 * 报出「工作流未就绪」——其实只是没等那次检测做完。现在所有调用者等同一个实际检测。
 */
export function refreshVideoCapability(): Promise<VideoCapabilities | null> {
  if (capabilityTask) return capabilityTask;
  videoChecking.value = true;
  videoError.value = "";
  capabilityTask = (async () => {
    try {
      if (!backend.running) throw new Error("ComfyUI 尚未运行；开始生成时会自动启动，也可以先在右上角启动后再检查。");
      const caps = await comfyVideoCapabilities();
      videoCapability.value = caps;
      if (!caps.ready) videoError.value = caps.message;
      return caps;
    } catch (e) {
      videoCapability.value = null;
      videoError.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      videoChecking.value = false;
      capabilityTask = null;
    }
  })();
  return capabilityTask;
}

/** 生成前调用：先把后端拉起来，再拿到一次真实的检测结果。 */
export async function ensureVideoCapability(): Promise<VideoCapabilities | null> {
  if (!backend.running) await startBackend();
  return refreshVideoCapability();
}

export async function runVideo(): Promise<void> {
  videoError.value = "";
  if (job.running) throw new Error("已有任务正在运行，请等待或先取消。");
  if (job.preparing) throw new Error("视频任务正在准备中，请稍候。");

  // 准备阶段也占用引擎：这期间用户切走页面，组件卸载、组件内的锁一起消失，
  // 但 store 上的这把锁还在，回来再点一次不会又起一个任务。
  const release = beginJobPrepare();
  try {
    if (!videoForm.firstFrame) throw new Error("请选择视频首帧。");
    if (!videoForm.prompt.trim()) throw new Error("请描述希望画面如何动起来。");
    const capability = await ensureVideoCapability();
    if (!capability?.ready) throw new Error(capability?.message || videoError.value || "MiniMax H3 工作流尚未就绪。");

    const seed = videoForm.randomSeed ? randomSeed() : videoForm.seed;
    videoForm.seed = seed;
    const result = await generate({
      mode: "video",
      prompt: videoForm.prompt.trim(),
      negative: "",
      refPaths: [videoForm.firstFrame, videoForm.lastFrame].filter((path): path is string => !!path),
      model: "qwen",
      size: videoForm.size,
      resolution: 0,
      steps: 12,
      cfg: 1,
      seed,
      sampler: "minimax_h3_turbo",
      scheduler: "simple",
      video: { length: videoForm.length, capabilities: capability },
    });
    if (!result.ok) {
      videoError.value = result.error || "视频生成失败。";
      return;
    }
    videoResults.value = result.images;
  } finally {
    release();
  }
}

export function swapVideoFrames() {
  [videoForm.firstFrame, videoForm.lastFrame] = [videoForm.lastFrame, videoForm.firstFrame];
}

export function setVideoFirstFrame(path: string) {
  videoForm.firstFrame = path;
}

export function restoreVideoFromHistory(entry: HistoryEntry) {
  if (entry.mode !== "video") return;
  const params = entry.params;
  videoForm.prompt = entry.prompt;
  const paths = Array.isArray(params.refPaths)
    ? params.refPaths.filter((value): value is string => typeof value === "string")
    : [];
  videoForm.firstFrame = paths[0] ?? null;
  videoForm.lastFrame = paths[1] ?? null;
  if (["864x480", "480x864", "640x640"].includes(String(params.size))) {
    videoForm.size = params.size as VideoFormState["size"];
  }
  if ([124, 243, 362].includes(Number(params.length))) {
    videoForm.length = Number(params.length) as VideoFormState["length"];
  }
  if (Number.isSafeInteger(params.seed) && Number(params.seed) >= 0) {
    videoForm.seed = Number(params.seed);
    videoForm.randomSeed = false;
  }
  if (entry.images.length) videoResults.value = [...entry.images];
}

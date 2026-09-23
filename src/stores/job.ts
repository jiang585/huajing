/** 图片与视频共用执行引擎。任务结束前持有执行锁，取消只针对本次 prompt。 */
import { reactive } from "vue";
import {
  uploadImage, queuePrompt, fetchHistory, fetchImage, fetchVideo, buildOutputPath,
  comfyCancelPrompt, pathExists,
} from "../api/tauri";
import {
  buildTxt2Img, buildEdit, buildUpscale, MODES, QWEN_DEFAULTS, ZIMAGE_DEFAULTS,
  UPSCALE_DEFAULTS, type Graph, type ModeId,
} from "../api/graphs";
import { buildVideo, snapshotVideoOptions, type VideoOptions } from "../api/video";
import { CANCELED, parseSize, extractOutputs, extractError, recordComplete } from "../api/jobCore";
import { backend, clientId, ensureProgressChannel, onComfyMessage } from "./backend";
import { settings } from "./settings";
import { pushHistory, newId } from "./history";
import { setLastResults } from "./results";

export const job = reactive({
  running: false,
  /** 提交前的准备阶段（启动后端、检查能力）。和 running 一起构成「引擎被占用」。 */
  preparing: false,
  canceling: false,
  mode: null as ModeId | null,
  stage: "",
  progress: null as { value: number; max: number } | null,
  queueRemaining: 0,
  startedAt: 0,
  elapsedMs: 0,
  images: [] as string[],
  error: null as string | null,
  warning: "",
  promptId: null as string | null,
});

export interface GenerateRequest {
  mode: ModeId;
  prompt: string;
  negative: string;
  refPaths: string[];
  model: "qwen" | "zimage";
  size: string;
  resolution: number;
  steps: number;
  cfg: number;
  seed: number;
  sampler: string;
  scheduler: string;
  upscaleOverride?: { prompt: string; steps: number; denoise: number } | null;
  video?: VideoOptions;
}

export interface GenerateResult {
  ok: boolean;
  images: string[];
  error?: string;
  durationMs: number;
}

const STAGES: Record<string, string> = {
  UNETLoader: "加载主模型",
  CLIPLoader: "加载文本编码器",
  VAELoader: "加载解码模型",
  LoadImage: "读取参考图",
  TextEncodeQwenImage21: "理解提示词与参考图",
  CLIPTextEncode: "理解提示词",
  KSampler: "采样生成",
  VAEDecode: "解码画面",
  VAEDecodeAudio: "解码声音",
  VAEEncode: "准备画面",
  SaveImage: "保存图片",
  ImageUpscaleWithModel: "放大并补充细节",
  UpscaleModelLoader: "加载放大模型",
  ImageScaleBy: "调整尺寸",
  MiniMaxH3TurboLoRA: "加载 H3 Turbo 加速模型",
  MiniMaxH3SigmaShift: "准备视频采样",
  MiniMaxH3ImageToVideo: "理解首尾帧与动作描述",
  SamplerCustomAdvanced: "生成视频与声音",
  CreateVideo: "合成视频与音轨",
  SaveVideo: "编码 MP4 视频",
  ImageScale: "适配视频画幅",
  RandomNoise: "准备生成",
  BasicGuider: "准备生成",
  BasicScheduler: "准备采样",
  MiniMaxH3TurboSampler: "准备加速采样",
};

let canceled = false;
let cancelPromise: Promise<void> | null = null;

/**
 * 占用引擎的「准备阶段」。
 *
 * 视频的启动后端、检查工作流、上传首尾帧都在 `job.running` 置位之前发生，
 * 而这期间用户可能切走页面 —— 组件级锁会随组件卸载一起消失，回来后又能点一次生成。
 * 所以准备阶段也记在 store 上，由 store 持有到提交或失败为止。
 */
let prepareDepth = 0;

export function beginJobPrepare(): () => void {
  prepareDepth += 1;
  job.preparing = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    prepareDepth = Math.max(0, prepareDepth - 1);
    if (prepareDepth === 0) job.preparing = false;
  };
}

export function engineBusy(): boolean {
  return job.running || job.preparing;
}

async function cancelSubmitted(): Promise<void> {
  if (!job.promptId) return;
  const promptId = job.promptId;
  try {
    // Rust 侧确认任务真的离开队列（或已中断）之后才返回，所以拿到返回值就说明可以解锁了。
    const state = await comfyCancelPrompt(promptId);
    job.stage = state === "finished" ? "任务已结束" : "正在取消当前任务…";
  } catch (e) {
    // 没确认成功就不能解锁：继续跟踪原任务，避免用户以为停了又提交一次。
    canceled = false;
    job.canceling = false;
    job.warning = `取消未确认，仍在跟踪任务：${String(e)}`;
  }
}

/** 上传阶段只标记取消；提交拿到 ID 后定向从队列删除或中断。 */
export async function cancelJob() {
  if (!job.running || job.canceling) return;
  canceled = true;
  job.canceling = true;
  job.stage = "正在取消当前任务…";
  cancelPromise = cancelSubmitted();
  await cancelPromise;
}

async function checkCanceled() {
  if (cancelPromise) await cancelPromise;
  if (canceled) throw new Error(CANCELED);
}

function graphFor(req: GenerateRequest, names: string[]): Graph {
  const common = {
    prompt: req.prompt,
    negative: req.negative,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    sampler: req.sampler,
    scheduler: req.scheduler,
    filenamePrefix: `画境/${MODES[req.mode].outputSubfolder}`,
  };
  const override = req.upscaleOverride ?? {
    prompt: settings.upscalePrompt,
    steps: settings.upscaleSteps,
    denoise: settings.upscaleDenoise,
  };
  const upscale = { ...UPSCALE_DEFAULTS, ...override, seed: req.seed };
  switch (req.mode) {
    case "txt2img":
      return buildTxt2Img({ ...common, model: req.model, ...parseSize(req.size) });
    case "edit":
      return buildEdit({ ...common, refs: names, resolution: req.resolution });
    case "multiref":
      return buildEdit({ ...common, refs: names, resolution: req.resolution, cache: names.length > 1 });
    case "multiref2k":
      return buildEdit({ ...common, refs: names, resolution: req.resolution, cache: names.length > 1, upscale });
    case "upscale":
      return buildUpscale({
        input: names[0], filenamePrefix: common.filenamePrefix,
        upscale: { ...upscale, prompt: req.prompt || upscale.prompt, steps: req.steps },
      });
    case "video":
      if (!req.video) throw new Error("请先检查视频工作流。");
      return buildVideo({ ...common, refs: names, ...parseSize(req.size), video: req.video });
  }
}

function snapshotParams(req: GenerateRequest): Record<string, unknown> {
  if (req.mode === "video") {
    return {
      model: "MiniMax H3 Turbo",
      size: req.size,
      seed: req.seed,
      length: req.video?.length,
      durationSeconds: req.video ? Number((req.video.length / 24).toFixed(2)) : undefined,
      fps: 24,
      steps: 12,
      refPaths: [...req.refPaths],
    };
  }
  return {
    model: req.model,
    size: req.size,
    resolution: req.resolution,
    steps: req.steps,
    cfg: req.cfg,
    seed: req.seed,
    sampler: req.sampler,
    scheduler: req.scheduler,
    refCount: req.refPaths.length,
    refPaths: [...req.refPaths],
    ...(["upscale", "multiref2k"].includes(req.mode)
      ? { upscale: req.upscaleOverride ?? { prompt: settings.upscalePrompt, steps: settings.upscaleSteps, denoise: settings.upscaleDenoise } }
      : {}),
  };
}

/**
 * 把界面传来的请求复制成只含普通字符串、数字、布尔值的对象。
 *
 * 不能用 `structuredClone()`：表单里放的是 Vue 的响应式对象（`videoCapability.value`、
 * 历史恢复出来的 `upscaleOverride` 都是 Proxy），克隆会直接抛
 * `DataCloneError: #<Object> could not be cloned.`，首次生成就失败。
 * 这里逐个字段显式取值，顺带把嵌套对象也摊平 —— 快照之后用户改设置或改表单，
 * 都不会影响已经提交的这次任务。
 */
export function snapshotRequest(request: GenerateRequest): GenerateRequest {
  const req: GenerateRequest = {
    mode: request.mode,
    prompt: String(request.prompt ?? ""),
    negative: String(request.negative ?? ""),
    refPaths: (request.refPaths ?? []).map((path) => String(path)),
    model: request.model === "zimage" ? "zimage" : "qwen",
    size: String(request.size ?? ""),
    resolution: Number(request.resolution),
    steps: Number(request.steps),
    cfg: Number(request.cfg),
    seed: Number(request.seed),
    sampler: String(request.sampler ?? ""),
    scheduler: String(request.scheduler ?? ""),
  };
  if (request.upscaleOverride) {
    req.upscaleOverride = {
      prompt: String(request.upscaleOverride.prompt ?? ""),
      steps: Number(request.upscaleOverride.steps),
      denoise: Number(request.upscaleOverride.denoise),
    };
  } else if (request.upscaleOverride === null) {
    req.upscaleOverride = null;
  }
  if (request.video) req.video = snapshotVideoOptions(request.video);
  return req;
}

export async function generate(request: GenerateRequest): Promise<GenerateResult> {
  if (job.running) throw new Error("已有任务在执行，请等它结束或取消完成。");
  if (!backend.running) throw new Error("ComfyUI 尚未运行，请先启动后端。");

  // 固定本次任务的配置，运行途中改设置不会改变本次输出或历史记录。
  const req = snapshotRequest(request);
  const outputDir = settings.outputDir;
  const spec = MODES[req.mode];
  if (req.refPaths.length < spec.slots.filter((s) => s.required).length) throw new Error("请补充所需的参考图。");
  if (req.mode !== "upscale" && !req.prompt.trim()) throw new Error("请填写提示词。");
  if (!Number.isSafeInteger(req.seed) || req.seed < 0) throw new Error("种子需为非负整数。");
  if (req.mode !== "video" && (
    !Number.isInteger(req.steps) || req.steps < 1 || req.steps > 100 ||
    !Number.isFinite(req.cfg) || req.cfg < 0 || req.cfg > 20
  )) throw new Error("请检查步数（1–100）与 CFG（0–20）。");
  if (["edit", "multiref", "multiref2k"].includes(req.mode) && (
    !Number.isFinite(req.resolution) || req.resolution < 256 || req.resolution > 4096
  )) throw new Error("请检查参考图精度（256–4096 px）。");
  // 先校验图结构，再上传，避免无效请求留下输入文件。
  graphFor(req, req.refPaths);

  Object.assign(job, {
    running: true, canceling: false, mode: req.mode, stage: "准备中", progress: null,
    queueRemaining: 0, images: [], error: null, warning: "", promptId: null,
    startedAt: Date.now(), elapsedMs: 0,
  });
  canceled = false;
  cancelPromise = null;
  const historyId = newId();
  const startedAt = job.startedAt;
  const saved: string[] = [];
  let unsubscribe: (() => void) | undefined;
  const timer = window.setInterval(() => { job.elapsedMs = Date.now() - startedAt; }, 500);
  let result: GenerateResult;

  try {
    await ensureProgressChannel();
    await checkCanceled();
    const names: string[] = [];
    for (const path of req.refPaths) {
      if (!(await pathExists(path))) throw new Error(`参考图文件已不存在，请重新选择：${path}`);
      await checkCanceled();
      job.stage = `上传参考图 ${names.length + 1} / ${req.refPaths.length}`;
      const uploaded = await uploadImage(path);
      names.push(uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name);
      await checkCanceled();
    }

    const graph = graphFor(req, names);
    job.stage = "提交任务";
    const queued = await queuePrompt(graph, clientId.value || undefined);
    job.promptId = queued.prompt_id;
    if (canceled) {
      cancelPromise = cancelSubmitted();
      await checkCanceled();
    }
    job.stage = "已提交，等待执行";
    unsubscribe = onComfyMessage((message) => {
      const data = message.data ?? {};
      if (data.prompt_id !== job.promptId || job.canceling) return;
      if (message.type === "progress") {
        const value = Number(data.value);
        const max = Number(data.max);
        job.progress = max > 0 ? { value, max } : null;
        job.stage = STAGES[graph[String(data.node)]?.class_type] ?? "生成中";
      } else if (message.type === "executing") {
        job.progress = null;
        job.stage = data.node == null ? "正在收尾" : STAGES[graph[String(data.node)]?.class_type] ?? "准备生成";
      } else if (message.type === "status") {
        const status = data.status as { exec_info?: { queue_remaining?: number } } | undefined;
        job.queueRemaining = status?.exec_info?.queue_remaining ?? 0;
      }
    });

    let record: Record<string, unknown> | null = null;
    let consecutiveErrors = 0;
    const deadline = Date.now() + (req.mode === "video" ? 6 : 1) * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      await checkCanceled();
      try {
        const history = await fetchHistory(queued.prompt_id);
        consecutiveErrors = 0;
        if (history && (extractError(history) || recordComplete(history))) {
          record = history;
          break;
        }
      } catch (e) {
        if (++consecutiveErrors >= 10) {
          throw new Error(`与后端的连接中断。任务可能仍在 ComfyUI 中执行，请勿重复提交。任务编号：${queued.prompt_id}。${String(e)}`);
        }
        job.stage = "连接暂时中断，正在重试…";
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }

    await checkCanceled();
    if (!record) throw new Error(`等待结果超时。任务可能仍在执行，请在 ComfyUI 检查任务 ${queued.prompt_id} 后再生成。`);
    const executionError = extractError(record);
    if (executionError) throw new Error(executionError);
    const outputs = extractOutputs(record, req.mode === "video");
    if (!outputs.length) throw new Error(`任务结束但没有可保存的${req.mode === "video" ? "视频" : "图片"}，请查看后端日志。`);

    job.stage = "保存到输出目录";
    job.progress = null;
    for (const output of outputs) {
      const extension = output.filename.split(".").pop()?.toLowerCase() || (req.mode === "video" ? "mp4" : "png");
      const destination = await buildOutputPath(outputDir, spec.outputSubfolder, "", extension);
      const fetcher = req.mode === "video" ? fetchVideo : fetchImage;
      saved.push(await fetcher(output.filename, output.subfolder, output.type, destination));
    }
    job.images = saved;
    job.stage = "完成";
    result = { ok: true, images: saved, durationMs: Date.now() - startedAt };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    job.error = error;
    job.images = saved;
    job.stage = error === CANCELED ? CANCELED : "生成未完成";
    result = { ok: false, images: saved, error, durationMs: Date.now() - startedAt };
  }

  // 历史写入失败不能把已经保存好的成果误报为生成失败，也不会重复创建记录。
  try {
    await pushHistory({
      id: historyId,
      mode: req.mode,
      prompt: req.prompt,
      negative: req.negative,
      params: { ...snapshotParams(req), promptId: job.promptId },
      images: saved,
      createdAt: startedAt,
      durationMs: result.durationMs,
      status: result.ok ? "done" : result.error === CANCELED ? "canceled" : "failed",
      error: result.error,
    });
  } catch (e) {
    job.warning = `历史记录未能保存：${String(e)}。已生成的文件仍在输出目录。`;
  } finally {
    job.elapsedMs = Date.now() - startedAt;
    window.clearInterval(timer);
    unsubscribe?.();
    // 结果直接写进 store：用户在任务运行期间切到图库或历史时，表单组件已经卸载，
    // 「完成事件」没有接收者，成果会只在磁盘上、结果面板里空着。
    setLastResults(req.mode, saved);
    job.running = false;
    job.canceling = false;
  }
  return result;
}

export function defaultsFor(mode: ModeId, model: "qwen" | "zimage") {
  if (mode === "upscale") {
    return {
      steps: settings.upscaleSteps,
      cfg: UPSCALE_DEFAULTS.cfg,
      sampler: UPSCALE_DEFAULTS.sampler,
      scheduler: UPSCALE_DEFAULTS.scheduler,
    };
  }
  if (mode === "txt2img" && model === "zimage") {
    return {
      steps: ZIMAGE_DEFAULTS.steps,
      cfg: ZIMAGE_DEFAULTS.cfg,
      sampler: ZIMAGE_DEFAULTS.sampler,
      scheduler: ZIMAGE_DEFAULTS.scheduler,
    };
  }
  return {
    steps: QWEN_DEFAULTS.steps,
    cfg: QWEN_DEFAULTS.cfg,
    sampler: QWEN_DEFAULTS.sampler,
    scheduler: QWEN_DEFAULTS.scheduler,
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

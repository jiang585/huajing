/**
 * 各功能页的表单状态。
 *
 * 每个模式一份独立状态，切页面不会把已经写好的提示词弄丢 —— 这在
 * 「文生图试提示词 → 换到多参考图继续调」这种来回切的使用习惯下很重要。
 */

import { reactive, watch } from "vue";
import { MODES, MODE_ORDER, QWEN_DEFAULTS, type ModeId } from "../api/graphs";
import { storeLoad, storeSave } from "../api/tauri";
import { settings } from "./settings";
import { defaultsFor, randomSeed } from "./job";

export interface ModeForm {
  prompt: string;
  negative: string;
  /** 与 spec.slots 一一对应，null 表示空槽 */
  refs: (string | null)[];
  /** 与 refs 平行：标注后的图片路径。画过标记才有值，生成时优先用它。 */
  marks: (string | null)[];
  model: "qwen" | "zimage";
  /** 文生图尺寸，形如 "1024x1024" */
  size: string;
  /** 编辑/多参考图：参考图缩放到的目标像素面积边长 */
  resolution: number;
  seed: number;
  /** 勾上就每次生成换随机种子 */
  randomSeed: boolean;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  showAdvanced: boolean;
  /** 优化提示词前的原文，用于一键撤销；null 表示没有可撤销的优化 */
  promptBefore: string | null;
  /** 历史复现时保留当次精修设置，不改动全局默认值。 */
  upscaleOverride: { prompt: string; steps: number; denoise: number } | null;
}

function makeForm(mode: ModeId): ModeForm {
  const spec = MODES[mode];
  const d = defaultsFor(mode, settings.defaultModel);
  return {
    prompt: spec.promptDefault,
    negative: "",
    refs: spec.slots.map(() => null),
    marks: spec.slots.map(() => null),
    model: settings.defaultModel,
    size: settings.defaultSize,
    resolution: 1024,
    seed: randomSeed(),
    randomSeed: true,
    steps: d.steps,
    cfg: d.cfg,
    sampler: d.sampler,
    scheduler: d.scheduler,
    showAdvanced: false,
    promptBefore: null,
    upscaleOverride: null,
  };
}

/**
 * 实际送进模型参考图路径：画过标注的用标注版，否则用原图。
 *
 * 注意顺序 —— ComfyUI 的 autogrow 输入要求 image_1..image_N 连续，
 * 所以中间的空槽会被跳过、后面的图往前顶。提示词里的 <imageN> 必须按这个
 * 压缩后的顺序来写，界面上的标签也是照这个顺序生成的。
 */
export function effectiveRefs(mode: ModeId): { slotIndex: number; path: string; annotated: boolean }[] {
  const f = forms[mode];
  const out: { slotIndex: number; path: string; annotated: boolean }[] = [];
  f.refs.forEach((p, i) => {
    const m = f.marks[i];
    const use = m ?? p;
    if (use) out.push({ slotIndex: i, path: use, annotated: !!m });
  });
  return out;
}

/** 清掉某个槽位的标注 */
export function clearMark(mode: ModeId, slotIndex: number) {
  forms[mode].marks[slotIndex] = null;
}

/**
 * 文件已经不在磁盘上的槽位（键是 ImageSlot 的 zoneKey，形如 `edit:ref1`）。
 *
 * 由 ImageSlot 在拿到图片信息后维护。用来在生成之前就拦住：
 * 参考图文件没了还硬生成的话，会在上传阶段报一句很难懂的错，
 * 不如提前告诉用户"这张图没了，请重选"。
 */
export const missingSlots = reactive(new Set<string>());

export function setSlotMissing(zoneKey: string, missing: boolean) {
  if (missing) missingSlots.add(zoneKey);
  else missingSlots.delete(zoneKey);
}

/** 当前模式下哪些槽位的文件丢了 */
export function missingSlotsOf(mode: ModeId): string[] {
  const spec = MODES[mode];
  return spec.slots
    .map((s, i) => ({ key: `${mode}:${s.key}`, label: s.label, i }))
    .filter((s) => missingSlots.has(s.key))
    .map((s) => s.label);
}

export const forms = reactive(
  Object.fromEntries(MODE_ORDER.map((m) => [m, makeForm(m)])) as Record<ModeId, ModeForm>,
);

/** 把某个模式的采样参数复位成官方默认 */
export function resetSampler(mode: ModeId) {
  const f = forms[mode];
  const d = defaultsFor(mode, f.model);
  f.steps = d.steps;
  f.cfg = d.cfg;
  f.sampler = d.sampler;
  f.scheduler = d.scheduler;
}

/** 切到 Z-Image 时把参数换成它该用的（两者采样器完全不同） */
export function onModelChange(mode: ModeId) {
  const f = forms[mode];
  const d = defaultsFor(mode, f.model);
  f.steps = d.steps;
  f.cfg = d.cfg;
  f.sampler = d.sampler;
  f.scheduler = d.scheduler;
}

/** 把结果图塞进某个模式的参考图槽 */
export function sendToMode(mode: ModeId, path: string, slotIndex = 0) {
  const f = forms[mode];
  if (!f || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= f.refs.length) return;
  f.refs[slotIndex] = path;
  // 跨页面送图也属于换图：旧图的标注不能继续覆盖新图。
  f.marks[slotIndex] = null;
  setSlotMissing(`${mode}:${MODES[mode].slots[slotIndex].key}`, false);
}

/** 找出第一个空槽，没有就返回 0 */
export function firstEmptySlot(mode: ModeId): number {
  const f = forms[mode];
  const i = f.refs.findIndex((r) => !r);
  return i < 0 ? 0 : i;
}

export { QWEN_DEFAULTS };

/**
 * 每个模式最近一次的结果图，切页回来还能看到，不用重新生成。
 * 实现在 results.ts：任务引擎也要写它，放在这里会让 job.ts 与 creator.ts 循环依赖。
 */
export { lastResults, setLastResults } from "./results";

// ---------------------------------------------------------------- 持久化
//
// 关掉应用再打开，写了一半的提示词还在。提示词是用户手打的东西，
// 丢一次就很烦，所以整份表单都存下来（标注路径也存，下次还能接着用）。

const STORE_KEY = "creator";
let saveTimer: number | null = null;

export async function loadForms() {
  const saved = await storeLoad<Partial<Record<ModeId, Partial<ModeForm>>>>(STORE_KEY);
  for (const mode of MODE_ORDER) {
    // 模块初始化早于 loadSettings；在这里应用用户已经保存的默认模型和尺寸。
    Object.assign(forms[mode], makeForm(mode));
    const s = saved?.[mode];
    if (!s) continue;
    const f = forms[mode];
    const slotCount = f.refs.length;

    if (typeof s.prompt === "string") f.prompt = s.prompt;
    if (typeof s.negative === "string") f.negative = s.negative;
    if (s.model === "qwen" || s.model === "zimage") f.model = s.model;
    if (typeof s.size === "string") f.size = s.size;
    if (typeof s.resolution === "number") f.resolution = s.resolution;
    if (typeof s.seed === "number") f.seed = s.seed;
    if (typeof s.randomSeed === "boolean") f.randomSeed = s.randomSeed;
    if (typeof s.steps === "number") f.steps = s.steps;
    if (typeof s.cfg === "number") f.cfg = s.cfg;
    if (typeof s.sampler === "string") f.sampler = s.sampler;
    if (typeof s.scheduler === "string") f.scheduler = s.scheduler;
    if (typeof s.showAdvanced === "boolean") f.showAdvanced = s.showAdvanced;
    if (s.upscaleOverride && typeof s.upscaleOverride.prompt === "string"
      && Number.isFinite(s.upscaleOverride.steps) && s.upscaleOverride.steps > 0
      && Number.isFinite(s.upscaleOverride.denoise) && s.upscaleOverride.denoise >= 0
      && s.upscaleOverride.denoise <= 1) {
      f.upscaleOverride = { ...s.upscaleOverride };
    }

    // 数组长度按当前槽位数对齐，防止版本变化后越界
    if (Array.isArray(s.refs)) {
      f.refs = Array.from({ length: slotCount }, (_, i) =>
        typeof s.refs?.[i] === "string" && s.refs[i] ? s.refs[i] : null);
    }
    if (Array.isArray(s.marks)) {
      f.marks = Array.from({ length: slotCount }, (_, i) =>
        f.refs[i] && typeof s.marks?.[i] === "string" && s.marks[i] ? s.marks[i] : null);
    }
  }
}

/** 挂上防抖保存。在 App 启动时调一次即可。 */
export function watchForms() {
  watch(
    () => JSON.stringify(forms),
    () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      // 打字过程中不要每敲一下就写盘
      saveTimer = window.setTimeout(() => {
        const snapshot = Object.fromEntries(
          MODE_ORDER.map((m) => {
            const { promptBefore, ...rest } = forms[m];
            void promptBefore;
            return [m, rest];
          }),
        );
        storeSave(STORE_KEY, snapshot).catch(() => undefined);
      }, 900);
    },
    { deep: false },
  );
}

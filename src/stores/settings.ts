/** 应用设置：持久化到应用数据目录的 settings.json */

import { reactive, ref } from "vue";
import { storeLoad, storeSave, appPaths, comfySetRoot } from "../api/tauri";
import { UPSCALE_DEFAULTS } from "../api/graphs";

export interface Settings {
  /** 生成结果默认落盘目录 */
  outputDir: string;
  /** ComfyUI 根目录，改完要同步给 Rust 侧 */
  comfyRoot: string;
  /** 生成完是否自动复制到 outputDir */
  autoSave: boolean;
  /** 文生图默认模型 */
  defaultModel: "qwen" | "zimage";
  /** 文生图默认尺寸，形如 "1024x1024" */
  defaultSize: string;
  /** 2K 放大时送进 Z-Image 的提示词 */
  upscalePrompt: string;
  /** 2K 放大的降噪强度 */
  upscaleDenoise: number;
  /** 2K 放大的采样步数 */
  upscaleSteps: number;
  /** 历史记录条数上限 */
  historyLimit: number;
  /** 上次停留的页面，下次打开直接回到那里 */
  lastPage: string;
  /** UI 视觉版本：v2 为灵境美学版 (Studio 2.0)，v1 为经典版 */
  themeEdition: "v2" | "v1";
  /** DeepSeek API Key（明文存在应用数据目录，也可用环境变量 DEEPSEEK_API_KEY 覆盖） */
  deepseekKey: string;
  /** 选中的模型 id，来自接口探测而非写死 */
  deepseekModel: string;
  /** 最近一次探测到的模型列表，避免每次进设置页都要重新拉 */
  deepseekModels: string[];
  /** 标注副本保留数量上限 */
  annotationKeep: number;
}

const DEFAULTS: Settings = {
  outputDir: "G:\\画境输出",
  comfyRoot: "E:\\ComfyUI",
  autoSave: true,
  defaultModel: "qwen",
  defaultSize: "1024x1024",
  upscalePrompt: "masterpiece, 8k, highly detailed",
  upscaleDenoise: UPSCALE_DEFAULTS.denoise,
  upscaleSteps: UPSCALE_DEFAULTS.steps,
  historyLimit: 500,
  lastPage: "txt2img",
  themeEdition: "v2",
  deepseekKey: "",
  deepseekModel: "",
  deepseekModels: [],
  annotationKeep: 60,
};

export const settings = reactive<Settings>({ ...DEFAULTS });
export const settingsReady = ref(false);
export const dataDir = ref("");

export async function loadSettings() {
  const saved = await storeLoad<Partial<Settings>>("settings");
  if (saved) {
    Object.assign(settings, { ...DEFAULTS, ...saved });
  }
  try {
    const p = await appPaths();
    dataDir.value = p.data_dir;
  } catch {
    /* 拿不到就用空值，不影响主流程 */
  }
  settingsReady.value = true;
}

export async function saveSettings() {
  await storeSave("settings", { ...settings });
  // 根目录改了要让 Rust 侧立刻生效，否则启动按钮还指向老路径
  try {
    await comfySetRoot(settings.comfyRoot);
  } catch {
    /* 后端没起来时忽略 */
  }
}

export async function resetSettings() {
  Object.assign(settings, DEFAULTS);
  await saveSettings();
}

/** 常用尺寸预设，文生图页用 */
export const SIZE_PRESETS: { label: string; value: string; hint: string }[] = [
  { label: "1:1 方图", value: "1024x1024", hint: "头像 / 通用" },
  { label: "3:4 竖图", value: "864x1152", hint: "人像" },
  { label: "2:3 竖图", value: "832x1248", hint: "全身 / 海报" },
  { label: "9:16 竖屏", value: "768x1344", hint: "手机壁纸" },
  { label: "4:3 横图", value: "1152x864", hint: "场景" },
  { label: "3:2 横图", value: "1248x832", hint: "风景" },
  { label: "16:9 横屏", value: "1344x768", hint: "壁纸 / 视频封面" },
];

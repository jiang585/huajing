<script setup lang="ts">
/**
 * 画境 2.0 灵境生成工作室 (Studio 2.0 Generator)
 * 顶级审美 AI 影像创作台：电影级光影设计、沉浸式视界画布、触感微动效与直觉化参数控制。
 */

import { computed, nextTick, ref, watch } from "vue";
import {
  Sparkles,
  Wand2,
  Undo2,
  Play,
  Loader2,
  Sliders,
  ChevronDown,
  Dices,
  RotateCcw,
  Maximize2,
  FolderOpen,
  Star,
  Copy,
  Check,
  Clapperboard,
  AlertTriangle,
  Flame,
  Film,
  Layers,
  Info,
} from "lucide-vue-next";
import ImageSlot from "../ImageSlot.vue";
import { MODES, type ModeId } from "../../api/graphs";
import { settings } from "../../stores/settings";
import {
  forms,
  resetSampler,
  onModelChange,
  effectiveRefs,
  missingSlotsOf,
} from "../../stores/creator";
import { job, generate, randomSeed, cancelJob } from "../../stores/job";
import { backend, startBackend } from "../../stores/backend";
import { lastResults } from "../../stores/results";
import { addMany } from "../../stores/library";
import {
  deepseekOptimize,
  imageInfos,
  revealPath,
  openPath,
  formatDuration,
  fileUrl,
  thumbUrl,
  type ImageInfo,
} from "../../api/tauri";

const props = defineProps<{ mode: ModeId }>();
const emit = defineEmits<{
  (e: "preview", paths: string[], index: number): void;
  (e: "go", page: string): void;
  (e: "toast", msg: string): void;
}>();

const spec = computed(() => MODES[props.mode]);
const form = computed(() => forms[props.mode]);
const results = computed(() => lastResults[props.mode]);

const selectedResultIndex = ref(0);
const currentResultPath = computed(() => {
  if (results.value.length === 0) return null;
  return results.value[selectedResultIndex.value] ?? results.value[0];
});

watch(
  () => results.value.join("|"),
  () => {
    if (results.value.length > 0) {
      selectedResultIndex.value = results.value.length - 1;
    } else {
      selectedResultIndex.value = 0;
    }
  },
);

// 文本域与提示词优化
const ta = ref<HTMLTextAreaElement | null>(null);
const optimizing = ref(false);
const optErr = ref("");
const hasDeepSeek = computed(() => !!settings.deepseekKey.trim());
const canUndoOptimize = computed(() => form.value.promptBefore !== null);
const copiedPrompt = ref(false);
const showAdvanced = ref(false);
const err = ref("");
const starting = ref(false);

// 风格预设库 (Curated Visual Style Presets)
const STYLE_PRESETS = [
  {
    name: "🎬 电影胶片",
    tag: ", 35mm film photography, cinematic lighting, shallow depth of field, Kodak Vision3 500T",
  },
  {
    name: "🌌 赛博霓虹",
    tag: ", cyberpunk aesthetic, vibrant neon lights, rain reflections, volumetric fog, moody dark atmosphere",
  },
  {
    name: "🌸 唯美动漫",
    tag: ", Makoto Shinkai anime style, ethereal clouds, vibrant sky, ray tracing, vivid colors, emotional lighting",
  },
  {
    name: "📸 真实摄影",
    tag: ", raw photo, 8k uhd, photorealistic, natural skin texture, professional studio lighting, Hasselblad",
  },
  {
    name: "🖌️ 东方水墨",
    tag: ", traditional Chinese ink wash painting, misty mountains, ethereal wuxia atmosphere, minimalist zen",
  },
  {
    name: "🏰 暗黑史诗",
    tag: ", dark fantasy concept art, epic scale, ominous dramatic lighting, Elden Ring atmosphere",
  },
  {
    name: "🧸 3D 黏土",
    tag: ", cute 3D claymation, soft isometric render, miniature diorama, pastel colors, blender 3d",
  },
  {
    name: "🎨 概念插画",
    tag: ", masterpiece concept art, dynamic composition, expressive brushwork, ArtStation trending",
  },
  {
    name: "🪟 丁达尔神光",
    tag: ", dramatic volumetric tyndall rays, golden hour sunlight through dust, ethereal glow",
  },
  {
    name: "🌌 银河星空",
    tag: ", cosmic nebula, brilliant starry night, celestial aura, milky way galaxy, astrophotography",
  },
];

// 画面画幅视觉卡片 (Visual Aspect Ratio Cards)
const ASPECT_PRESETS = [
  { label: "1:1 方形", size: "1024x1024", w: 22, h: 22, desc: "头像/通用" },
  { label: "16:9 宽屏", size: "1344x768", w: 32, h: 18, desc: "壁纸/横屏" },
  { label: "9:16 竖屏", size: "768x1344", w: 18, h: 32, desc: "手机/海报" },
  { label: "4:3 经典", size: "1152x864", w: 26, h: 20, desc: "标准场景" },
  { label: "3:4 肖像", size: "864x1152", w: 20, h: 26, desc: "人像立绘" },
  { label: "21:9 宽画幅", size: "1536x640", w: 36, h: 15, desc: "电影银幕" },
];

// 快捷负向提示词标签
const NEGATIVE_CHIPS = ["低画质", "肢体畸形", "重影模糊", "多余手指", "面部崩坏", "水印文字"];
const NEGATIVE_MAP: Record<string, string> = {
  低画质: "low quality, worst quality, blurry, pixelated",
  肢体畸形: "bad anatomy, deformed limbs, mutation, extra limbs",
  重影模糊: "out of focus, motion blur, double image",
  多余手指: "bad hands, missing fingers, extra digit, fewer digits",
  面部崩坏: "disfigured face, bad eyes, poorly drawn face",
  水印文字: "watermark, signature, text, username, logo",
};

// 灵感启动词 (Inspirational starter prompts for empty state)
const STARTER_PROMPTS = [
  "赛博朋克雨夜街道，霓虹倒影在湿润的沥青地面，撑透明雨伞的少女独行，电影级宽银幕光影",
  "悬浮在云海之上的中世纪蒸汽浮空城，巨大的黄铜齿轮与飞艇穿梭其间，晨曦金光穿透薄雾",
  "古典文艺复兴油画风格，柔和伦勃朗光打在侧颜的高雅贵族少女，细腻蕾丝华服与暗色背景",
  "深海幽邃秘境，巨大发光的梦幻蓝鲸游过古代沉没的神殿废墟，浮游生物散发荧光",
];

// 参考图标签管理
const refs = computed(() => effectiveRefs(props.mode));
const refThumbs = ref<Record<string, ImageInfo>>({});

async function refreshRefThumbs() {
  const paths = refs.value.map((r) => r.path);
  if (paths.length === 0) {
    refThumbs.value = {};
    return;
  }
  const list = await imageInfos(paths);
  const map: Record<string, ImageInfo> = {};
  list.forEach((i) => (map[i.path] = i));
  refThumbs.value = map;
}

watch(() => refs.value.map((r) => r.path).join("|"), refreshRefThumbs, { immediate: true });

function insertTag(tag: string) {
  const el = ta.value;
  const text = form.value.prompt;
  const start = el?.selectionStart ?? text.length;
  const end = el?.selectionEnd ?? start;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const pad = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const inserted = pad + tag;
  form.value.prompt = before + inserted + after;
  nextTick(() => {
    if (!el) return;
    el.focus();
    const pos = start + inserted.length;
    el.setSelectionRange(pos, pos);
  });
}

function applyStylePreset(tag: string) {
  if (form.value.prompt.includes(tag.trim())) return;
  form.value.prompt = form.value.prompt.trim() + tag;
  emit("toast", "已注入风格预设词");
}

function addNegativeTag(label: string) {
  const tag = NEGATIVE_MAP[label];
  if (!tag) return;
  const current = form.value.negative.trim();
  if (current.includes(tag)) return;
  form.value.negative = current ? `${current}, ${tag}` : tag;
  emit("toast", `已加入负向词：${label}`);
}

async function optimize() {
  optErr.value = "";
  if (!form.value.prompt.trim()) {
    optErr.value = "请先输入基础描述再使用 AI 优化";
    return;
  }
  if (!hasDeepSeek.value) {
    optErr.value = "尚未配置 DeepSeek API Key，请前往「系统设置」填写。";
    return;
  }
  optimizing.value = true;
  try {
    const marked = refs.value.some((r) => r.annotated);
    const extra = marked
      ? "用户在参考图上画了标记标出要修改的位置。提示词里请用方位描述来指代（例如「图中标记的区域」），不要臆测标记框住的具体内容是什么。"
      : "";

    const result = await deepseekOptimize({
      apiKey: settings.deepseekKey,
      model: settings.deepseekModel,
      mode: props.mode,
      prompt: form.value.prompt,
      refCount: refs.value.length,
      extra,
    });
    form.value.promptBefore = form.value.prompt;
    form.value.prompt = result;
    emit("toast", "✨ DeepSeek 已完成电影级提示词精修");
  } catch (e) {
    optErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    optimizing.value = false;
  }
}

function revertPrompt() {
  if (form.value.promptBefore === null) return;
  form.value.prompt = form.value.promptBefore;
  form.value.promptBefore = null;
  optErr.value = "";
  emit("toast", "已撤销 AI 优化，恢复原文");
}

// 尺寸与模式
const showSizePicker = computed(() => spec.value.size === "free");
const showResolution = computed(() => spec.value.size === "followsRef");
const showNegative = computed(
  () => !(props.mode === "txt2img" && form.value.model === "zimage"),
);

const missingRequired = computed(() => {
  const need = spec.value.slots.filter((s) => s.required).length;
  return refs.value.length < need;
});
const missingRefs = computed(() => missingSlotsOf(props.mode));

const canRun = computed(() => {
  if (job.running) return false;
  if (job.preparing) return false;
  if (missingRequired.value) return false;
  if (missingRefs.value.length > 0) return false;
  if (props.mode !== "upscale" && !form.value.prompt.trim()) return false;
  return true;
});

async function run() {
  err.value = "";
  if (job.preparing) {
    err.value = "视频或其他任务正在准备中，请稍候。";
    return;
  }
  if (!backend.running) {
    starting.value = true;
    try {
      await startBackend();
    } catch (e) {
      err.value = `ComfyUI 启动失败：${e instanceof Error ? e.message : String(e)}`;
      starting.value = false;
      return;
    }
    starting.value = false;
  }

  const seed = form.value.randomSeed ? randomSeed() : form.value.seed;
  if (form.value.randomSeed) form.value.seed = seed;

  try {
    const r = await generate({
      mode: props.mode,
      prompt: form.value.prompt,
      negative: form.value.negative,
      refPaths: refs.value.map((r) => r.path),
      model: form.value.model,
      size: form.value.size,
      resolution: form.value.resolution,
      steps: form.value.steps,
      cfg: form.value.cfg,
      seed,
      sampler: form.value.sampler,
      scheduler: form.value.scheduler,
      upscaleOverride: form.value.upscaleOverride,
    });
    if (!r.ok && r.error) err.value = r.error;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}

// 快捷键 Ctrl + Enter 生成
function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    if (canRun.value) void run();
  }
}

// 结果图操作
const resultInfos = ref<Record<string, ImageInfo>>({});
watch(
  () => results.value.join("|"),
  async () => {
    resultInfos.value = {};
    if (results.value.length === 0) return;
    try {
      const list = await imageInfos(results.value);
      const map: Record<string, ImageInfo> = {};
      list.forEach((i) => (map[i.path] = i));
      resultInfos.value = map;
    } catch (e) {
      console.error("[画境] 读取结果图信息失败：", e);
    }
  },
  { immediate: true },
);

const currentDims = computed(() => {
  if (!currentResultPath.value) return "";
  const info = resultInfos.value[currentResultPath.value];
  if (!info || !info.width) return "";
  return `${info.width} × ${info.height}`;
});

const progressPct = computed(() => {
  const p = job.progress;
  if (!p || p.max <= 0) return 0;
  return Math.min(100, Math.round((p.value / p.max) * 100));
});

const showProgress = computed(() => job.running && job.mode === props.mode);

async function copyPrompt() {
  if (!form.value.prompt.trim()) return;
  try {
    await navigator.clipboard.writeText(form.value.prompt);
    copiedPrompt.value = true;
    setTimeout(() => (copiedPrompt.value = false), 2000);
    emit("toast", "提示词已复制到剪贴板");
  } catch {
    emit("toast", "复制失败，请手动选取复制");
  }
}

async function saveToLibrary() {
  if (!currentResultPath.value) return;
  await addMany([currentResultPath.value], "generated");
  emit("toast", "已收藏至备用图库");
}

function sendToMode(target: ModeId) {
  if (!currentResultPath.value) return;
  emit("go", target);
}
</script>

<template>
  <div class="studio-two-col" @keydown="onKeydown">
    <!-- 左侧：参数控制与提示词工作台 -->
    <div class="studio-control-panel">
      <!-- 模型选择卡片（仅限文生图） -->
      <div v-if="spec.modelSwitch" class="studio-card studio-card-glow" style="margin-bottom: 14px">
        <div class="studio-card-header" style="margin-bottom: 10px">
          <span class="studio-card-title">
            <Flame :size="15" style="color: var(--st-iris)" /> 核心生图引擎
          </span>
          <span class="studio-card-subtitle">
            {{ form.model === "qwen" ? "Qwen-Image 2.1 · 旗舰级审美" : "Z-Image Turbo · 8秒极速出图" }}
          </span>
        </div>
        <div class="studio-model-seg">
          <button
            class="studio-model-btn"
            :class="{ active: form.model === 'qwen' }"
            @click="form.model = 'qwen'; onModelChange(mode)"
          >
            <span class="model-badge">旗舰</span>
            <strong>Qwen-Image 2.1</strong>
            <small>超高细节 · 复杂语义</small>
          </button>
          <button
            class="studio-model-btn"
            :class="{ active: form.model === 'zimage' }"
            @click="form.model = 'zimage'; onModelChange(mode)"
          >
            <span class="model-badge turbo">极速</span>
            <strong>Z-Image Turbo</strong>
            <small>闪电出图 · 构图先锋</small>
          </button>
        </div>
      </div>

      <!-- 参考图卡片（非文生图模式） -->
      <div v-if="spec.slots.length > 0" class="studio-card" style="margin-bottom: 14px">
        <div class="studio-card-header">
          <span class="studio-card-title">
            <Layers :size="15" style="color: var(--st-cyan)" /> 视觉参考源图
          </span>
          <span class="studio-card-subtitle">
            {{ spec.slots.length }} 个输入槽位 · 支持拖拽落图与圈选标注
          </span>
        </div>
        <div class="studio-slots-grid" :class="{ 'single-slot': spec.slots.length === 1 }">
          <ImageSlot
            v-for="(s, i) in spec.slots"
            :key="s.key"
            :zone-key="`${mode}:${s.key}`"
            :label="s.label"
            :required="s.required"
            v-model="form.refs[i]"
            v-model:annotated="form.marks[i]"
            @preview="emit('preview', [$event], 0)"
          />
        </div>
      </div>

      <!-- 提示词控制台 -->
      <div class="studio-card" style="margin-bottom: 14px">
        <div class="studio-card-header">
          <span class="studio-card-title">
            <Sparkles :size="15" style="color: var(--st-iris)" /> 创意提示词 (Prompt)
          </span>
          <div class="studio-header-actions">
            <button
              v-if="canUndoOptimize"
              class="st-btn st-btn-ghost st-btn-sm"
              title="撤销 DeepSeek 优化并恢复原文"
              @click="revertPrompt"
            >
              <Undo2 :size="12" /> 撤销优化
            </button>
            <button
              class="st-ai-btn"
              :disabled="optimizing"
              title="由 DeepSeek 智能扩写视觉细节"
              @click="optimize"
            >
              <Loader2 v-if="optimizing" :size="12" class="spin" />
              <Wand2 v-else :size="12" />
              <span>{{ optimizing ? "AI 润色中…" : "DeepSeek 智能精修" }}</span>
            </button>
          </div>
        </div>

        <!-- 参考图标签快捷插入 (image tags) -->
        <div v-if="refs.length > 0" class="studio-tag-bar">
          <span class="studio-tag-lead">点击插入引用：</span>
          <button
            v-for="(r, idx) in refs"
            :key="r.slotIndex"
            class="studio-ref-tag"
            @click="insertTag(`<image${idx + 1}>`)"
          >
            <img
              v-if="thumbUrl(refThumbs[r.path], r.path)"
              :src="thumbUrl(refThumbs[r.path], r.path)"
              class="ref-chip-img"
              alt=""
            />
            <span class="ref-num">&lt;image{{ idx + 1 }}&gt;</span>
            <span class="ref-title">{{ spec.slots[r.slotIndex]?.label }}</span>
            <span v-if="r.annotated" class="ref-annotated-dot" title="已带局部标注" />
          </button>
        </div>

        <!-- 文本输入框 -->
        <div class="studio-prompt-box">
          <textarea
            ref="ta"
            v-model="form.prompt"
            class="studio-prompt-textarea"
            spellcheck="false"
            :placeholder="spec.promptPlaceholder || '描绘你脑海中的画面细节、光影、构图与艺术氛围… (按 Ctrl+Enter 快速生成)'"
          />
          <div class="studio-prompt-footer">
            <div class="studio-prompt-actions">
              <span class="studio-prompt-counter">{{ form.prompt.length }} 字</span>
              <button
                v-if="form.prompt.trim()"
                class="st-btn st-btn-ghost st-btn-sm"
                @click="copyPrompt"
              >
                <Check v-if="copiedPrompt" :size="12" style="color: var(--st-emerald)" />
                <Copy v-else :size="12" />
                {{ copiedPrompt ? "已复制" : "复制" }}
              </button>
            </div>
            <span class="hotkey-tip">快捷键: Ctrl + Enter</span>
          </div>
        </div>

        <!-- 风格灵感库 (Style Chips) -->
        <div class="studio-style-preset-row">
          <span class="preset-label">风格注入:</span>
          <div class="studio-style-chips-wrap">
            <button
              v-for="item in STYLE_PRESETS"
              :key="item.name"
              class="studio-style-chip"
              @click="applyStylePreset(item.tag)"
            >
              {{ item.name }}
            </button>
          </div>
        </div>

        <div v-if="optErr" class="studio-alert-err">
          {{ optErr }}
        </div>
      </div>

      <!-- 画面比例画幅选择器（文生图） -->
      <div v-if="showSizePicker" class="studio-card" style="margin-bottom: 14px">
        <div class="studio-card-header" style="margin-bottom: 12px">
          <span class="studio-card-title">
            <Maximize2 :size="14" /> 画面画幅与比例
          </span>
          <span class="studio-card-subtitle">当前尺寸：{{ form.size }}</span>
        </div>

        <div class="studio-aspect-grid">
          <div
            v-for="aspect in ASPECT_PRESETS"
            :key="aspect.size"
            class="studio-aspect-card"
            :class="{ selected: form.size === aspect.size }"
            @click="form.size = aspect.size"
          >
            <div class="studio-aspect-shape-wrap">
              <div
                class="studio-aspect-shape"
                :style="{ width: `${aspect.w}px`, height: `${aspect.h}px` }"
              />
            </div>
            <div class="studio-aspect-label">{{ aspect.label }}</div>
            <div class="studio-aspect-size">{{ aspect.size }}</div>
          </div>
        </div>
      </div>

      <!-- 目标分辨率（编辑与多参考图） -->
      <div v-if="showResolution" class="studio-card" style="margin-bottom: 14px">
        <div class="studio-card-header">
          <span class="studio-card-title">输出等效边长</span>
          <span class="studio-card-subtitle">{{ form.resolution }} px</span>
        </div>
        <input
          v-model.number="form.resolution"
          type="range"
          min="768"
          max="2048"
          step="64"
          class="studio-slider"
        />
        <div class="studio-slider-labels">
          <span>768px (快速)</span>
          <span>1024px (标准推荐)</span>
          <span>2048px (高清大图)</span>
        </div>
      </div>

      <!-- 展开的高级采样参数与负向词 -->
      <div class="studio-card" style="margin-bottom: 14px">
        <div
          class="studio-accordion-header"
          @click="showAdvanced = !showAdvanced"
        >
          <span class="studio-card-title">
            <Sliders :size="14" /> 采样与扩散高级控制
          </span>
          <button class="st-btn st-btn-ghost st-btn-sm">
            {{ showAdvanced ? "收起" : "展开调参" }}
            <ChevronDown
              :size="14"
              :style="{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }"
            />
          </button>
        </div>

        <div v-if="showAdvanced" class="studio-accordion-body">
          <!-- 负向提示词 -->
          <div v-if="showNegative" class="advanced-field">
            <div class="studio-field-label">
              <span>负向提示词 (Negative Prompt)</span>
              <small>排除不需要的瑕疵特征</small>
            </div>
            <input
              v-model="form.negative"
              type="text"
              class="studio-input"
              placeholder="例如: low quality, blurry, deformed hands, extra limbs..."
            />
            <div class="quick-neg-tags">
              <span class="neg-tag-label">一键添加:</span>
              <button
                v-for="chip in NEGATIVE_CHIPS"
                :key="chip"
                class="neg-chip"
                @click="addNegativeTag(chip)"
              >
                + {{ chip }}
              </button>
            </div>
          </div>

          <!-- 采样步数与 CFG -->
          <div class="advanced-grid-2">
            <div class="advanced-field">
              <div class="studio-field-label">
                <span>采样步数 (Steps)</span>
                <span class="mono">{{ form.steps }}</span>
              </div>
              <input
                v-model.number="form.steps"
                type="range"
                min="10"
                max="60"
                step="1"
                class="studio-slider"
              />
            </div>
            <div class="advanced-field">
              <div class="studio-field-label">
                <span>提示词引导 (CFG)</span>
                <span class="mono">{{ form.cfg }}</span>
              </div>
              <input
                v-model.number="form.cfg"
                type="range"
                min="1.0"
                max="15.0"
                step="0.5"
                class="studio-slider"
              />
            </div>
          </div>

          <!-- 采样器与调度器 -->
          <div class="advanced-grid-2">
            <div class="advanced-field">
              <div class="studio-field-label">采样算法 (Sampler)</div>
              <input v-model="form.sampler" type="text" class="studio-input" />
            </div>
            <div class="advanced-field">
              <div class="studio-field-label">调度方式 (Scheduler)</div>
              <input v-model="form.scheduler" type="text" class="studio-input" />
            </div>
          </div>

          <!-- 种子控制 -->
          <div class="advanced-field">
            <div class="studio-field-label">随机种子 (Seed)</div>
            <div class="seed-control-row">
              <input
                v-model.number="form.seed"
                type="number"
                class="studio-input"
                :disabled="form.randomSeed"
              />
              <button
                class="st-btn"
                :class="{ 'st-btn-primary': form.randomSeed }"
                @click="form.randomSeed = !form.randomSeed"
              >
                <Dices :size="14" />
                {{ form.randomSeed ? "每次随机" : "固定种子" }}
              </button>
              <button
                class="st-btn st-btn-ghost"
                title="复位默认调优参数"
                @click="resetSampler(mode)"
              >
                <RotateCcw :size="13" /> 复位默认
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 错误与警告提示 -->
      <div v-if="err" class="studio-error-banner">
        <AlertTriangle :size="16" />
        <span>{{ err }}</span>
      </div>

      <!-- 核心生成大按钮 -->
      <div class="studio-action-row">
        <button
          class="st-btn st-btn-primary st-btn-hero"
          style="width: 100%"
          :disabled="!canRun || starting"
          @click="run"
        >
          <Loader2 v-if="job.running || starting" :size="20" class="spin" />
          <Play v-else :size="20" />
          <span>
            <template v-if="starting">正在唤醒本地 ComfyUI 引擎…</template>
            <template v-else-if="job.running">影像生成计算中…</template>
            <template v-else-if="job.preparing">工作台准备中…</template>
            <template v-else>立即生成 (Ctrl + Enter)</template>
          </span>
        </button>
      </div>
    </div>

    <!-- 右侧：电影级视界展台 (Showcase Canvas & Results) -->
    <div class="studio-showcase-panel">
      <!-- 生成中状态卡片 -->
      <div v-if="showProgress" class="studio-progress-card">
        <div class="progress-info-row">
          <div class="progress-stage-title">
            <Loader2 :size="16" class="spin" style="color: var(--st-iris-light)" />
            <span>{{ job.stage || "深度采样计算中…" }}</span>
          </div>
          <div class="progress-stats">
            <span v-if="job.progress" class="mono">
              {{ job.progress.value }} / {{ job.progress.max }} 步
            </span>
            <span class="dot-divider">·</span>
            <span>已用时 {{ formatDuration(job.elapsedMs) }}</span>
            <button class="st-btn st-btn-danger st-btn-sm" @click="cancelJob">
              终止任务
            </button>
          </div>
        </div>
        <div class="studio-progress-beam-track">
          <div
            class="studio-progress-beam-fill"
            :style="{ width: `${progressPct}%` }"
          />
        </div>
      </div>

      <!-- 结果 Hero 视界大画布 (100% 完整原比例呈现，杜绝截断) -->
      <div v-if="currentResultPath" class="studio-hero-container">
        <div class="studio-hero-viewport" @click="emit('preview', results, selectedResultIndex)">
          <img
            :src="fileUrl(currentResultPath)"
            class="studio-hero-image"
            alt="生成成果"
          />
        </div>

        <!-- 成果快捷操作栏 (移出视口，不遮挡画面) -->
        <div class="studio-hero-dock-bar">
          <button
            class="studio-dock-btn"
            title="无损原图全屏预览"
            @click="emit('preview', results, selectedResultIndex)"
          >
            <Maximize2 :size="14" /> 全屏查看
          </button>
          <div class="studio-dock-divider" />
          <button
            v-if="mode !== 'video'"
            class="studio-dock-btn"
            title="把这张图作为视频的首帧"
            @click="sendToMode('video')"
          >
            <Clapperboard :size="14" /> 转成视频
          </button>
          <button
            v-if="mode !== 'upscale'"
            class="studio-dock-btn"
            title="送入 2K 细节精修链"
            @click="sendToMode('upscale')"
          >
            <Sparkles :size="14" /> 2K精修
          </button>
          <div class="studio-dock-divider" />
          <button
            class="studio-dock-btn"
            title="收藏到备用图库"
            @click="saveToLibrary"
          >
            <Star :size="14" /> 收藏
          </button>
          <button
            class="studio-dock-btn"
            title="在文件夹中定位文件"
            @click="revealPath(currentResultPath)"
          >
            <FolderOpen :size="14" /> 定位
          </button>
        </div>
      </div>

      <!-- 空白状态：灵感画布 (Inspirational Empty State) -->
      <div v-else-if="!showProgress" class="studio-empty-state">
        <div class="studio-empty-icon-wrap">
          <Sparkles :size="32" />
        </div>
        <div class="studio-empty-title">画境 2.0 灵境工作室</div>
        <div class="studio-empty-desc">
          输入提示词或选择预设风格，点击「立即生成」，探索属于你的无限视觉灵感。
        </div>
        <div class="studio-quick-prompts">
          <div
            v-for="(p, idx) in STARTER_PROMPTS"
            :key="idx"
            class="studio-quick-prompt-tag"
            @click="form.prompt = p; emit('toast', '已填入创意灵感提示词')"
          >
            ✦ {{ p.slice(0, 18) }}…
          </div>
        </div>
      </div>

      <!-- 胶卷底片条 (Filmstrip for multiple images) -->
      <div v-if="results.length > 1" class="studio-card" style="margin-top: 14px">
        <div class="studio-card-header" style="margin-bottom: 10px">
          <span class="studio-card-title">
            <Film :size="14" /> 历史成果胶卷 (共 {{ results.length }} 张)
          </span>
          <span v-if="currentDims" class="studio-card-subtitle mono">
            尺寸: {{ currentDims }}
          </span>
        </div>
        <div class="studio-filmstrip">
          <div
            v-for="(path, index) in results"
            :key="path"
            class="studio-filmstrip-item"
            :class="{ active: selectedResultIndex === index }"
            @click="selectedResultIndex = index"
          >
            <img :src="thumbUrl(resultInfos[path], path)" alt="结果缩略图" />
          </div>
        </div>
      </div>

      <!-- 工作流信息栏 (Workflow Metadata Card) -->
      <div class="studio-card" style="margin-top: 14px">
        <div class="studio-card-header" style="margin-bottom: 8px">
          <span class="studio-card-title">
            <Info :size="14" /> 当前工作流管线
          </span>
          <span class="studio-card-subtitle mono">
            {{ settings.outputDir }}\{{ spec.outputSubfolder }}
          </span>
        </div>
        <div class="studio-pills-row">
          <span class="studio-meta-pill accent">{{ spec.label }}</span>
          <span class="studio-meta-pill">{{ spec.tagline }}</span>
          <span v-if="mode === 'txt2img'" class="studio-meta-pill">
            {{ form.model === "qwen" ? "Qwen 2.1 Latent 引擎" : "SD3 ZeroOut 极速引擎" }}
          </span>
          <span v-if="mode === 'multiref2k'" class="studio-meta-pill">
            Z-Image 2K 超清级联精修
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.studio-two-col {
  display: grid;
  grid-template-columns: 460px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}

@media (max-width: 1180px) {
  .studio-two-col {
    grid-template-columns: 1fr;
  }
}

.studio-control-panel {
  display: flex;
  flex-direction: column;
}

.studio-showcase-panel {
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
}

/* 引擎切换卡片 */
.studio-model-seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.studio-model-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: var(--st-radius-md);
  border: 1px solid var(--st-border-subtle);
  background: var(--st-bg-surface-2);
  color: var(--st-text-secondary);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  text-align: left;
  position: relative;
}

.studio-model-btn:hover {
  background: var(--st-bg-surface-3);
  border-color: var(--st-border-strong);
  transform: translateY(-1px);
}

.studio-model-btn.active {
  background: rgba(139, 92, 246, 0.14);
  border-color: var(--st-iris);
  color: #ffffff;
  box-shadow: 0 4px 18px rgba(124, 58, 237, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

.studio-model-btn strong {
  font-size: 13.5px;
  margin-top: 4px;
}

.studio-model-btn small {
  font-size: 11px;
  color: var(--st-text-muted);
  margin-top: 2px;
}

.studio-model-btn.active small {
  color: var(--st-iris-light);
}

.model-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(139, 92, 246, 0.25);
  color: var(--st-iris-light);
}

.model-badge.turbo {
  background: rgba(6, 182, 212, 0.25);
  color: var(--st-cyan);
}

/* 槽位网格 */
.studio-slots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(122px, 1fr));
  gap: 10px;
}
.studio-slots-grid.single-slot {
  max-width: 220px;
}

/* 提示词标签快捷条 */
.studio-tag-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 8px;
  margin-bottom: 4px;
}

.studio-tag-lead {
  font-size: 11px;
  color: var(--st-text-muted);
  white-space: nowrap;
}

.studio-ref-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 12px;
  background: var(--st-bg-surface-2);
  border: 1px solid var(--st-border-subtle);
  color: var(--st-text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.studio-ref-tag:hover {
  background: var(--st-bg-surface-3);
  color: var(--st-text-primary);
  border-color: var(--st-iris);
}

.ref-chip-img {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  object-fit: cover;
}

.ref-num {
  font-family: var(--st-font-mono);
  color: var(--st-iris-light);
  font-weight: 600;
}

.ref-annotated-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-amber);
}

.hotkey-tip {
  font-size: 11px;
  color: var(--st-text-dim);
}

.studio-style-preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.preset-label {
  font-size: 11.5px;
  color: var(--st-text-muted);
  white-space: nowrap;
}

.studio-alert-err {
  margin-top: 8px;
  font-size: 12px;
  color: var(--st-rose);
  padding: 6px 10px;
  border-radius: var(--st-radius-sm);
  background: var(--st-rose-soft);
  border: 1px solid rgba(244, 63, 94, 0.25);
}

.studio-slider {
  width: 100%;
  accent-color: var(--st-iris);
  cursor: pointer;
}

.studio-slider-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--st-text-dim);
  margin-top: 3px;
}

/* 高级手风琴 */
.studio-accordion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.studio-accordion-body {
  padding-top: 16px;
  border-top: 1px solid var(--st-border-subtle);
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.advanced-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.studio-field-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--st-text-secondary);
  font-weight: 500;
}

.studio-input {
  width: 100%;
  background: var(--st-bg-surface-2);
  border: 1px solid var(--st-border);
  border-radius: var(--st-radius-sm);
  padding: 8px 12px;
  color: var(--st-text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s ease;
}

.studio-input:focus {
  border-color: var(--st-iris);
}

.advanced-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.seed-control-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quick-neg-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.neg-tag-label {
  font-size: 11px;
  color: var(--st-text-dim);
}

.neg-chip {
  border: 1px solid var(--st-border-subtle);
  background: var(--st-bg-surface-3);
  color: var(--st-text-muted);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.neg-chip:hover {
  background: rgba(244, 63, 94, 0.15);
  border-color: rgba(244, 63, 94, 0.4);
  color: var(--st-rose);
}

.studio-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--st-radius-md);
  background: var(--st-rose-soft);
  border: 1px solid rgba(244, 63, 94, 0.3);
  color: var(--st-rose);
  font-size: 13px;
  margin-bottom: 12px;
}

.progress-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.progress-stage-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--st-text-primary);
}

.progress-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--st-text-muted);
}

.dot-divider {
  opacity: 0.4;
}

.studio-pills-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.studio-meta-pill {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 12px;
  background: var(--st-bg-surface-2);
  color: var(--st-text-secondary);
  border: 1px solid var(--st-border-subtle);
}

.studio-meta-pill.accent {
  background: rgba(139, 92, 246, 0.15);
  border-color: rgba(139, 92, 246, 0.3);
  color: var(--st-iris-light);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>

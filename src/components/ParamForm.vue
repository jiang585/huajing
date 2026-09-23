<script setup lang="ts">
/**
 * 参数表单：提示词、参考图槽、尺寸与高级采样参数。
 *
 * 三个和提示词相关的便利设计：
 * - 参考图标签 chips：点一下就插到光标处，不用手打 <imageN>；
 * - 优化提示词：把提示词交给 DeepSeek，按本地规范改写，可一键撤销；
 * - 标注：图槽上直接画圈，带标记的图会替代原图送进模型。
 */

import { computed, nextTick, ref } from "vue";
import {
  ChevronRight,
  Dices,
  RotateCcw,
  Play,
  Loader2,
  Lightbulb,
  Info,
  Sparkles,
  Undo2,
  Tag,
} from "lucide-vue-next";
import ImageSlot from "./ImageSlot.vue";
import { MODES, type ModeId } from "../api/graphs";
import { SIZE_PRESETS, settings } from "../stores/settings";
import {
  forms,
  resetSampler,
  onModelChange,
  effectiveRefs,
  missingSlotsOf,
} from "../stores/creator";
import { job, generate, randomSeed } from "../stores/job";
import { backend, startBackend } from "../stores/backend";
import { deepseekOptimize, thumbUrl, imageInfos, type ImageInfo } from "../api/tauri";

const props = defineProps<{ mode: ModeId }>();
const emit = defineEmits<{
  (e: "preview", path: string): void;
}>();

const spec = computed(() => MODES[props.mode]);
const form = computed(() => forms[props.mode]);

const err = ref("");
const showTips = ref(false);
const starting = ref(false);

const ta = ref<HTMLTextAreaElement | null>(null);

// 优化提示词
const optimizing = ref(false);
const optErr = ref("");
const canUndoOptimize = computed(() => form.value.promptBefore !== null);
const hasDeepSeek = computed(() => !!settings.deepseekKey.trim());

// 参考图标签
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
// refs 变化时（选图/清空/标注）刷新缩略图
import { watch } from "vue";
watch(() => refs.value.map((r) => r.path).join("|"), refreshRefThumbs, { immediate: true });

/** 把 <imageN> 插到光标位置，前后自动补空格免得和相邻文字粘住 */
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

async function optimize() {
  optErr.value = "";
  if (!form.value.prompt.trim()) {
    optErr.value = "先写点东西再优化";
    return;
  }
  if (!hasDeepSeek.value) {
    optErr.value = "还没配置 DeepSeek API Key，请到「设置 → DeepSeek」里填写。";
    return;
  }
  optimizing.value = true;
  try {
    // 有标注时把这件事告诉模型，让它用方位词指代，而不是去猜标记的内容
    const marked = refs.value.some((r) => r.annotated);
    const extra = marked
      ? "用户在参考图上画了标记（圆圈/方框/箭头）标出要修改的位置。提示词里请用方位描述来指代（例如「图中标记的区域」），不要臆测标记框住的具体内容是什么。"
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
}

// 尺寸
const showSizePicker = computed(() => spec.value.size === "free");
const showResolution = computed(() => spec.value.size === "followsRef");
const showNegative = computed(
  () => !(props.mode === "txt2img" && form.value.model === "zimage"),
);

const missingRequired = computed(() => {
  const need = spec.value.slots.filter((s) => s.required).length;
  return refs.value.length < need;
});
/** 已经填了、但文件不在磁盘上的槽位。这种图硬发出去会在上传阶段失败，得提前拦住。 */
const missingRefs = computed(() => missingSlotsOf(props.mode));

const canRun = computed(() => {
  if (job.running) return false;
  // 视频的启动后端/检测工作流也算引擎被占用，避免两边同时提交
  if (job.preparing) return false;
  if (missingRequired.value) return false;
  if (missingRefs.value.length > 0) return false;
  if (props.mode !== "upscale" && !form.value.prompt.trim()) return false;
  return true;
});

async function run() {
  err.value = "";
  if (job.preparing) {
    err.value = "视频任务正在准备中，等它进入生成后再试。";
    return;
  }
  if (!backend.running) {
    starting.value = true;
    try {
      await startBackend();
    } catch (e) {
      err.value = `后端启动失败：${e instanceof Error ? e.message : String(e)}`;
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
      // 标注过的用标注版 —— effectiveRefs 已经处理好了
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
    // 结果由任务 store 写入（见 stores/results.ts）：本组件在任务运行期间可能已被卸载，
    // 走事件的话没有接收者，成果就只在磁盘上、面板里空着。
    if (!r.ok && r.error) err.value = r.error;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <div class="card">
    <!-- 模型切换（仅文生图） -->
    <div v-if="spec.modelSwitch" class="field">
      <label class="label">模型</label>
      <div class="seg" style="width: 100%">
        <button
          style="flex: 1"
          :class="{ on: form.model === 'qwen' }"
          @click="form.model = 'qwen'; onModelChange(mode)"
        >
          Qwen-Image 2.1
        </button>
        <button
          style="flex: 1"
          :class="{ on: form.model === 'zimage' }"
          @click="form.model = 'zimage'; onModelChange(mode)"
        >
          Z-Image Turbo
        </button>
      </div>
      <div class="hint">
        {{
          form.model === "qwen"
            ? "质量更好，语义理解强，约 50–90 秒一张"
            : "极快，约 8–15 秒一张，适合先试构图和提示词"
        }}
      </div>
    </div>

    <!-- 参考图槽 -->
    <div v-if="spec.slots.length > 0" class="field">
      <label class="label">
        参考图
        <span v-if="spec.slots.some((s) => !s.required)" class="muted" style="font-weight: 400">
          （前 {{ spec.slots.filter((s) => s.required).length }} 张必填，其余可留空）
        </span>
      </label>
      <div class="slot-grid">
        <ImageSlot
          v-for="(s, i) in spec.slots"
          :key="s.key"
          :zone-key="`${mode}:${s.key}`"
          :label="s.label"
          :required="s.required"
          v-model="form.refs[i]"
          v-model:annotated="form.marks[i]"
          @preview="emit('preview', $event)"
        />
      </div>
      <div class="hint">
        悬停图槽出现铅笔图标，可以在图上画圈/方框/箭头，标出要让模型改的位置。
      </div>
    </div>

    <!-- 提示词 -->
    <div class="field">
      <div class="flex" style="justify-content: space-between; margin-bottom: 6px">
        <label class="label" style="margin: 0">
          提示词
          <span v-if="mode !== 'upscale'" class="req">*</span>
        </label>
        <button
          class="btn sm"
          :disabled="optimizing || !form.prompt.trim()"
          :title="hasDeepSeek ? '用 DeepSeek 按本地规范改写' : '需要先在设置里配置 DeepSeek'"
          @click="optimize"
        >
          <Loader2 v-if="optimizing" :size="12" class="spin" />
          <Sparkles v-else :size="12" />
          {{ optimizing ? "优化中…" : "优化提示词" }}
        </button>
      </div>

      <textarea
        ref="ta"
        v-model="form.prompt"
        class="textarea"
        :placeholder="spec.promptPlaceholder"
        spellcheck="false"
      />

      <!-- 引用标签快捷插入 -->
      <div v-if="refs.length > 0" class="tag-bar">
        <span class="tag-hint"><Tag :size="11" /> 点击插入引用：</span>
        <button
          v-for="(r, i) in refs"
          :key="r.slotIndex"
          class="tag-chip"
          :class="{ marked: r.annotated }"
          :title="`${spec.slots[r.slotIndex].label}${r.annotated ? '（已标注）' : ''}`"
          @click="insertTag(`<image${i + 1}>`)"
        >
          <img :src="thumbUrl(refThumbs[r.path], r.path)" alt="" />
          <span class="tag-code">&lt;image{{ i + 1 }}&gt;</span>
        </button>
      </div>

      <!-- 优化结果的撤销与提示 -->
      <div v-if="canUndoOptimize || optErr" class="opt-bar">
        <span v-if="canUndoOptimize" class="pill accent">
          <Sparkles :size="10" /> 已由 DeepSeek 优化
        </span>
        <button v-if="canUndoOptimize" class="btn ghost sm" @click="revertPrompt">
          <Undo2 :size="12" /> 恢复原文
        </button>
        <span v-if="optErr" class="pill err" :title="optErr">{{ optErr }}</span>
      </div>

      <div
        class="collapse-head"
        :class="{ open: showTips }"
        style="margin-top: 7px"
        @click="showTips = !showTips"
      >
        <ChevronRight :size="13" class="chev" />
        <Lightbulb :size="12" />
        这个模式该怎么写提示词
      </div>
      <ul v-if="showTips" class="tips" style="margin-top: 6px">
        <li v-for="(t, i) in spec.tips" :key="i">{{ t }}</li>
      </ul>
    </div>

    <!-- 尺寸 -->
    <div v-if="showSizePicker" class="field">
      <label class="label">尺寸</label>
      <div class="flex wrap" style="gap: 6px">
        <button
          v-for="p in SIZE_PRESETS"
          :key="p.value"
          class="btn sm"
          :class="{ primary: form.size === p.value }"
          :title="p.hint"
          @click="form.size = p.value"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="row" style="margin-top: 8px">
        <input
          v-model="form.size"
          class="input"
          placeholder="也可自己填，如 1024x1024"
          spellcheck="false"
        />
      </div>
    </div>

    <div v-else-if="showResolution" class="field">
      <label class="label">
        参考图精度：{{ form.resolution }} px
        <span class="muted" style="font-weight: 400">（越大越还原细节，也越吃显存）</span>
      </label>
      <input
        v-model.number="form.resolution"
        type="range"
        min="512"
        max="1536"
        step="64"
        style="width: 100%"
      />
      <div class="hint">
        输出尺寸由参考图 1 的宽高比决定，不在这里指定。8G 显存建议 1024。
      </div>
    </div>

    <div v-else class="field">
      <div class="alert info">
        <Info :size="14" />
        <div>
          放大链会先把图放大 4 倍再缩到 2 倍，最终尺寸约等于原图的 2 倍。
          显存吃紧时建议输入不要超过 1024。
        </div>
      </div>
    </div>

    <!-- 负向提示词 -->
    <div v-if="showNegative" class="field">
      <label class="label">
        负向提示词
        <span class="muted" style="font-weight: 400">（可留空）</span>
      </label>
      <textarea
        v-model="form.negative"
        class="textarea"
        style="min-height: 58px"
        placeholder="不想出现的东西，例如：blurry, watermark, text"
        spellcheck="false"
      />
    </div>

    <!-- 高级参数 -->
    <div class="field" style="margin-top: 14px">
      <div
        class="collapse-head"
        :class="{ open: form.showAdvanced }"
        @click="form.showAdvanced = !form.showAdvanced"
      >
        <ChevronRight :size="13" class="chev" />
        高级参数
        <span class="muted" style="font-size: 11px">（种子 / 步数 / CFG / 采样器）</span>
      </div>

      <div v-if="form.showAdvanced" style="margin-top: 10px">
        <div class="field">
          <label class="label">种子</label>
          <div class="flex">
            <input
              v-model.number="form.seed"
              class="input"
              type="number"
              :disabled="form.randomSeed"
              style="flex: 1"
            />
            <button
              class="btn sm"
              :class="{ primary: form.randomSeed }"
              @click="form.randomSeed = !form.randomSeed"
            >
              <Dices :size="12" />
              {{ form.randomSeed ? "随机" : "固定" }}
            </button>
            <button class="btn sm" title="立刻换一个种子" @click="form.seed = randomSeed()">
              <RotateCcw :size="12" />
            </button>
          </div>
          <div class="hint">
            固定种子 + 同样的提示词可以复现同一张图；改一点提示词再看变化时很有用。
          </div>
        </div>

        <div class="row row-3">
          <div class="field">
            <label class="label">步数</label>
            <input v-model.number="form.steps" class="input" type="number" min="1" max="100" />
          </div>
          <div class="field">
            <label class="label">CFG</label>
            <input
              v-model.number="form.cfg"
              class="input"
              type="number"
              step="0.1"
              min="0"
              max="20"
              :disabled="form.model === 'zimage' && mode === 'txt2img'"
            />
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label class="label">采样器</label>
            <select v-model="form.sampler" class="select">
              <option value="euler">euler</option>
              <option value="res_multistep">res_multistep</option>
              <option value="dpmpp_2m_sde">dpmpp_2m_sde</option>
              <option value="dpmpp_2m">dpmpp_2m</option>
              <option value="uni_pc">uni_pc</option>
            </select>
          </div>
          <div class="field">
            <label class="label">调度器</label>
            <select v-model="form.scheduler" class="select">
              <option value="simple">simple</option>
              <option value="beta">beta</option>
              <option value="normal">normal</option>
              <option value="karras">karras</option>
            </select>
          </div>
        </div>

        <button class="btn sm" @click="resetSampler(mode)">
          <RotateCcw :size="12" /> 恢复官方默认参数
        </button>

        <div v-if="mode === 'multiref2k'" class="hint" style="margin-top: 10px">
          2K 精修的降噪强度与步数在「设置」里统一调（当前降噪
          {{ settings.upscaleDenoise }}、{{ settings.upscaleSteps }} 步）。
        </div>
      </div>
    </div>

    <!--
      固定种子时把它亮出来。种子开关在「高级参数」里，默认折叠着看不见 ——
      参数复现会把它设成固定，用户很容易在改完提示词之后还一直复用同一个种子，
      结果就是「不同提示词、相同种子」出一堆噪点。
    -->
    <div v-if="!form.randomSeed" class="alert warn seed-fixed">
      <Dices :size="14" />
      <div style="flex: 1">
        <div>
          当前是<strong>固定种子</strong>
          <span class="mono">{{ form.seed }}</span>
        </div>
        <div style="font-size: 12px; opacity: 0.9; margin-top: 2px">
          换了提示词还想出新图的话，请切回随机 —— 同一个种子配不同提示词容易出噪点。
        </div>
      </div>
      <button class="btn sm" @click="form.randomSeed = true; form.seed = randomSeed()">
        <Dices :size="12" /> 切回随机
      </button>
    </div>

    <div v-if="form.upscaleOverride && (mode === 'upscale' || mode === 'multiref2k')" class="alert info" style="margin-top: 12px">
      <Info :size="14" />
      <div style="flex: 1">
        正在使用历史记录中的 2K 参数：{{ form.upscaleOverride.steps }} 步，降噪 {{ form.upscaleOverride.denoise }}。
      </div>
      <button class="btn sm" @click="form.upscaleOverride = null">改用当前设置</button>
    </div>

    <!-- 错误 -->
    <div v-if="err" class="alert err" style="margin-top: 12px">
      <Info :size="14" />
      <div style="white-space: pre-wrap">{{ err }}</div>
    </div>

    <!-- 生成 -->
    <button
      class="btn primary lg"
      style="width: 100%; margin-top: 14px"
      :disabled="!canRun || starting"
      @click="run"
    >
      <Loader2 v-if="job.running || job.preparing || starting" :size="15" class="spin" />
      <Play v-else :size="15" />
      <template v-if="starting">正在启动后端…</template>
      <template v-else-if="job.running">生成中…（{{ job.stage }}）</template>
      <template v-else-if="job.preparing">视频任务正在准备中…</template>
      <template v-else>开始生成</template>
    </button>
    <div v-if="missingRequired" class="hint" style="text-align: center">
      还需要补上必填的参考图
    </div>
    <div v-else-if="missingRefs.length" class="hint" style="text-align: center">
      <span style="color: var(--err)">
        {{ missingRefs.join("、") }} 的文件已不在磁盘上，请重新选择
      </span>
    </div>
    <div
      v-else-if="mode !== 'upscale' && !form.prompt.trim()"
      class="hint"
      style="text-align: center"
    >
      还需要写提示词
    </div>
  </div>
</template>

<style scoped>
.seed-fixed {
  margin-top: 12px;
  align-items: center;
}
.spin {
  animation: rot 1s linear infinite;
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}

.tag-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.tag-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px 0 3px;
  border-radius: 15px;
  border: 1px solid var(--border-strong);
  background: var(--bg-2);
  color: var(--text-2);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.tag-chip:hover {
  background: var(--accent-soft);
  border-color: var(--accent-border);
  color: var(--text);
}
.tag-chip img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.tag-chip.marked {
  border-color: var(--accent);
}
.tag-code {
  font-family: "Cascadia Mono", Consolas, monospace;
}

.opt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
</style>

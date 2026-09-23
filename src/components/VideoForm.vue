<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeftRight, CheckCircle2, ChevronDown, Cpu, Dices, Info, Loader2, Play, RefreshCw, Video } from "lucide-vue-next";
import VideoFrameSlot from "./VideoFrameSlot.vue";
import { backend } from "../stores/backend";
import { job, randomSeed } from "../stores/job";
import {
  videoForm,
  videoCapability,
  videoChecking,
  videoError,
  refreshVideoCapability,
  runVideo,
  swapVideoFrames,
} from "../stores/video";

const emit = defineEmits<{
  (e: "preview", path: string): void;
  (e: "toast", message: string): void;
}>();

const advanced = ref(false);
const sizes: { value: typeof videoForm.size; name: string; ratio: string; width: number; height: number }[] = [
  { value: "864x480", name: "横屏", ratio: "16:9", width: 22, height: 13 },
  { value: "480x864", name: "竖屏", ratio: "9:16", width: 13, height: 22 },
  { value: "640x640", name: "方形", ratio: "1:1", width: 18, height: 18 },
];
const lengths: { value: typeof videoForm.length; label: string; detail: string }[] = [
  { value: 124, label: "约 5 秒", detail: "推荐先试" },
  { value: 243, label: "约 10 秒", detail: "更多显存" },
  { value: 362, label: "约 15 秒", detail: "更多显存" },
];
// 忙碌状态取自 store（job.preparing / job.running）而不是组件内的 ref：
// 准备阶段切走页面会卸载组件，组件内的锁会跟着消失，store 上的不会。
const busy = computed(() => job.running || job.preparing);
const ownJob = computed(() => job.running && job.mode === "video");
const supportsLast = computed(() => videoCapability.value?.supports_last_frame !== false);
const ready = computed(() => backend.running && videoCapability.value?.ready);
const seconds = computed(() => (videoForm.length / 24).toFixed(1));
const pendingReason = computed(() => {
  if (job.running && !ownJob.value) return "有其他任务正在生成，完成后即可生成视频。";
  if (!videoForm.firstFrame) return "先选一张首帧图，作为视频的起始画面。";
  if (!videoForm.prompt.trim()) return "写下希望画面如何动起来。";
  return "";
});

watch(() => backend.running, (running) => {
  if (running && !videoCapability.value) void refreshVideoCapability();
}, { immediate: true });

async function run() {
  if (busy.value || pendingReason.value || videoChecking.value) return;
  try {
    await runVideo();
  } catch (e) {
    videoError.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <div class="card video-form">
    <div class="workflow-heading">
      <span class="workflow-icon"><Video :size="19" /></span>
      <div>
        <h3>让画面动起来</h3>
        <p>MiniMax H3 Turbo <span>·</span> 本地运行</p>
      </div>
    </div>

    <div class="workflow-status" :class="{ ready }" aria-live="polite">
      <div class="workflow-status-line">
        <Loader2 v-if="videoChecking" :size="14" class="spin" />
        <CheckCircle2 v-else-if="ready" :size="14" />
        <Cpu v-else :size="14" />
        <span>{{ videoChecking ? "正在检查工作流…" : ready ? "工作流已就绪" : !backend.running ? "生成时自动启动本地引擎" : videoCapability ? "工作流需要检查" : "尚未检查工作流" }}</span>
        <button class="btn ghost sm" :disabled="busy || videoChecking" @click="refreshVideoCapability" :title="'检查本机模型和视频节点'">
          <RefreshCw :size="12" :class="{ spin: videoChecking }" /> {{ videoChecking ? "检查中" : "检查" }}
        </button>
      </div>
      <p v-if="videoCapability && !videoCapability.ready && backend.running" class="status-detail">{{ videoCapability.message }}</p>
      <details v-if="videoCapability && (videoCapability.missing_nodes.length || videoCapability.missing_models.length)" class="missing-details">
        <summary>查看缺少的依赖</summary>
        <div v-if="videoCapability.missing_nodes.length">节点：{{ videoCapability.missing_nodes.join("、") }}</div>
        <div v-if="videoCapability.missing_models.length">模型：{{ videoCapability.missing_models.join("、") }}</div>
      </details>
    </div>

    <fieldset :disabled="busy" class="video-fields">
      <section class="form-section">
        <div class="section-heading">
          <h4><span class="step-number">1</span> 设定起止画面</h4>
          <button v-if="supportsLast" class="btn ghost sm" :disabled="busy || !videoForm.firstFrame || !videoForm.lastFrame" @click="swapVideoFrames"><ArrowLeftRight :size="12" /> 交换</button>
        </div>
        <div class="video-frame-grid" :class="{ single: !supportsLast }">
          <VideoFrameSlot v-model="videoForm.firstFrame" zone-key="video:first-frame" label="首帧" required :disabled="busy" @preview="emit('preview', $event)" />
          <VideoFrameSlot v-if="supportsLast" v-model="videoForm.lastFrame" zone-key="video:last-frame" label="尾帧" :disabled="busy" @preview="emit('preview', $event)" />
        </div>
        <p class="section-hint">{{ supportsLast ? "只放首帧也能生成。添加尾帧，让视频逐渐过渡到指定画面。" : "当前工作流使用首帧生成视频。" }}</p>
      </section>

      <section class="form-section">
        <div class="section-heading"><h4><span class="step-number">2</span> 描述动作与镜头</h4><span class="quiet-label">必填</span></div>
        <label class="sr-only" for="video-prompt">视频提示词</label>
        <textarea id="video-prompt" v-model="videoForm.prompt" class="textarea video-prompt" spellcheck="false" placeholder="例如：镜头缓慢推近，人物抬头看向窗外，微风吹动发梢，窗外传来轻柔的雨声。" />
        <p class="section-hint">写清主体动作、镜头运动和声音。使用尾帧时，描述两个画面之间的变化。</p>
      </section>

      <section class="form-section">
        <div class="section-heading"><h4><span class="step-number">3</span> 选择视频规格</h4><span class="quiet-label">24 帧 / 秒</span></div>
        <label class="label">画面比例</label>
        <div class="size-options" role="group" aria-label="画面比例">
          <button v-for="size in sizes" :key="size.value" class="size-option" :class="{ selected: videoForm.size === size.value }" :aria-pressed="videoForm.size === size.value" @click="videoForm.size = size.value">
            <span class="ratio-outline" :style="{ width: `${size.width}px`, height: `${size.height}px` }"></span>
            <strong>{{ size.name }} <small>{{ size.ratio }}</small></strong>
            <span>{{ size.value.replace('x', ' × ') }}</span>
          </button>
        </div>
        <p class="section-hint">图片会按所选比例居中裁切。选择接近原图的比例，可减少画面裁切。</p>
        <label class="label duration-label">视频时长</label>
        <div class="duration-options" role="group" aria-label="视频时长">
          <button v-for="length in lengths" :key="length.value" class="duration-option" :class="{ selected: videoForm.length === length.value }" :aria-pressed="videoForm.length === length.value" @click="videoForm.length = length.value">
            <strong>{{ length.label }}</strong><span>{{ length.detail }}</span>
          </button>
        </div>
        <p class="section-hint">{{ videoForm.length }} 帧 · 约 {{ seconds }} 秒。长视频占用更多显存、生成更久，8 GB 显存建议先用约 5 秒。</p>
      </section>

      <section class="advanced-section">
        <button class="advanced-toggle" :aria-expanded="advanced" aria-controls="video-advanced" @click="advanced = !advanced"><ChevronDown :size="14" :class="{ expanded: advanced }" /> 高级设置 <span>{{ videoForm.randomSeed ? "随机种子" : "固定种子" }}</span></button>
        <div v-if="advanced" id="video-advanced" class="advanced-content">
          <label class="seed-toggle"><input v-model="videoForm.randomSeed" type="checkbox" /> 每次使用随机种子</label>
          <div v-if="!videoForm.randomSeed" class="seed-row">
            <label for="video-seed" class="label">种子</label>
            <input id="video-seed" v-model.number="videoForm.seed" class="input" type="number" min="0" max="9007199254740991" step="1" />
            <button class="btn" title="生成新的种子" aria-label="生成新的种子" @click="videoForm.seed = randomSeed()"><Dices :size="14" /></button>
          </div>
          <p class="section-hint">固定种子便于对比提示词变化，其他参数保持一致时更容易复现结果。</p>
        </div>
      </section>
    </fieldset>

    <div v-if="videoError" class="alert err video-error" role="alert"><Info :size="15" /><div>{{ videoError }}</div></div>
    <button class="btn primary lg generate-video" :disabled="busy || videoChecking || !!pendingReason" @click="run">
      <Loader2 v-if="busy" :size="16" class="spin" /><Play v-else :size="16" />
      {{ ownJob ? "视频生成中…" : job.preparing ? "正在准备本地工作流…" : job.running ? "等待当前任务完成" : "开始生成视频" }}
    </button>
    <p v-if="pendingReason && !job.preparing" class="run-hint">{{ pendingReason }}</p>
    <p v-else-if="!busy" class="run-hint">本机生成，视频完成后自动保存到输出目录。</p>
  </div>
</template>

<style scoped>
.video-form { padding: 20px; }
.workflow-heading { display: flex; align-items: center; gap: 11px; margin-bottom: 16px; }
.workflow-icon { width: 40px; height: 40px; display: grid; place-items: center; color: #cfc2ff; border: 1px solid var(--accent-border); border-radius: 11px; background: var(--accent-soft); }
.workflow-heading h3 { margin: 0; font-size: 15px; font-weight: 600; }
.workflow-heading p { margin: 2px 0 0; color: var(--text-2); font-size: 11px; }
.workflow-heading p span { margin: 0 4px; color: var(--text-3); }
.workflow-status { border: 1px solid var(--border); background: var(--bg-2); border-radius: 8px; padding: 6px 10px; color: var(--text-2); }
.workflow-status.ready { color: var(--ok); background: rgba(53,201,138,.05); border-color: rgba(53,201,138,.22); }
.workflow-status-line { display: flex; align-items: center; gap: 7px; font-size: 11px; min-height: 26px; }
.workflow-status-line > svg { flex-shrink: 0; }
.workflow-status-line > .btn { margin-left: auto; }
.status-detail { margin: 5px 0 4px; font-size: 11px; color: var(--text-2); }
.missing-details { font-size: 11px; margin: 5px 0; overflow-wrap: anywhere; }
.missing-details summary { cursor: pointer; }
.missing-details div { margin-top: 5px; color: var(--text-2); }
.video-fields { min-width: 0; padding: 0; margin: 0; border: 0; }
.form-section { margin-top: 22px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; min-height: 26px; }
.section-heading h4 { margin: 0; display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; }
.step-number { font-size: 10px; line-height: 19px; width: 19px; text-align: center; border-radius: 50%; color: #cfc2ff; background: var(--accent-soft); }
.quiet-label { font-size: 10px; color: var(--text-3); white-space: nowrap; }
.video-frame-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.video-frame-grid.single { grid-template-columns: 1fr; }
.section-hint { margin: 8px 0 0; font-size: 11px; color: var(--text-2); line-height: 1.7; }
.video-prompt { min-height: 124px; font-size: 12px; }
.size-options, .duration-options { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 7px; }
.size-option, .duration-option { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-width: 0; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 4px; color: var(--text-2); font-family: inherit; cursor: pointer; }
.size-option:hover:not(:disabled), .duration-option:hover:not(:disabled) { border-color: var(--border-strong); background: var(--bg-3); }
.size-option.selected, .duration-option.selected { background: var(--accent-soft); border-color: var(--accent-border); color: var(--text); }
.size-option strong, .duration-option strong { font-size: 12px; font-weight: 500; }
.size-option small { font-size: 10px; color: var(--text-2); font-weight: 400; }
.size-option > span:last-child, .duration-option span { font-size: 10px; color: var(--text-2); }
.ratio-outline { display: block; border: 1.5px solid currentColor; border-radius: 3px; margin-bottom: 4px; color: var(--text-2); }
.selected .ratio-outline { color: #bbabff; }
.duration-label { margin-top: 16px; }
.duration-option { gap: 3px; padding: 8px 4px; }
.advanced-section { border-top: 1px solid var(--border); margin-top: 20px; padding-top: 12px; }
.advanced-toggle { display: flex; align-items: center; gap: 6px; background: none; border: 0; padding: 3px 0; color: var(--text-2); font-size: 11px; font-family: inherit; cursor: pointer; width: 100%; text-align: left; }
.advanced-toggle > svg { transform: rotate(-90deg); transition: transform .15s; }
.advanced-toggle > svg.expanded { transform: rotate(0); }
.advanced-toggle span { color: var(--text-3); margin-left: auto; }
.advanced-content { margin-top: 10px; }
.seed-toggle { display: flex; gap: 7px; align-items: center; font-size: 12px; color: var(--text-2); cursor: pointer; }
.seed-toggle input { accent-color: var(--accent); }
.seed-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.seed-row .label { margin: 0; white-space: nowrap; }
.seed-row .input { min-width: 0; }
.video-error { margin-top: 16px; font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
.generate-video { width: 100%; margin-top: 18px; }
.run-hint { margin: 8px 0 0; text-align: center; font-size: 11px; color: var(--text-2); line-height: 1.65; }
button:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 3px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.spin { animation: video-spin 1s linear infinite; }
@keyframes video-spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) { .video-form { padding: 14px; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>

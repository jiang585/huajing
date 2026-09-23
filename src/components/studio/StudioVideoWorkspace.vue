<script setup lang="ts">
/**
 * 画境 2.0 灵境视频工坊 (Studio 2.0 Video Workspace)
 * 顶级审美 AI 视频生成：动效时间线连接器、运镜预设注入、首尾帧过渡可视化与原生暗色播放展台。
 */

import { computed, ref, watch } from "vue";
import {
  Video,
  Clapperboard,
  ArrowRight,
  ArrowLeftRight,
  CheckCircle2,
  Cpu,
  Loader2,
  RefreshCw,
  Play,
  Square,
  FolderOpen,
  Download,
  AlertCircle,
  Film,
  Sparkles,
} from "lucide-vue-next";
import VideoFrameSlot from "../VideoFrameSlot.vue";
import { backend } from "../../stores/backend";
import { job, cancelJob } from "../../stores/job";
import {
  videoForm,
  videoCapability,
  videoChecking,
  videoError,
  videoResults,
  refreshVideoCapability,
  runVideo,
  swapVideoFrames,
} from "../../stores/video";
import {
  copyFile,
  fileUrl,
  formatDuration,
  openPath,
  pickDirectory,
  revealPath,
} from "../../api/tauri";

const emit = defineEmits<{
  (e: "preview", path: string): void;
  (e: "toast", message: string): void;
}>();

// 运镜预设库
const CAMERA_PRESETS = [
  { name: "🎥 缓慢推近", tag: "镜头缓慢向前推近，焦点逐渐聚焦在主体面部与眼神，景深柔和虚化" },
  { name: "🔭 渐渐拉远", tag: "镜头缓慢向后拉远，逐渐展现出宏大而震撼的周围全景环境" },
  { name: "⬅️ 向左横移", tag: "电影级横向平滑向左运镜平移，展现画面的流动延展感" },
  { name: "➡️ 向右横移", tag: "电影级横向平滑向右运镜平移，光影随视角平滑位移变换" },
  { name: "🔄 环绕运镜", tag: "镜头轻柔半环绕主体旋转移动，呈现丰富的立体三维纵深" },
  { name: "🍃 微风呼吸", tag: "主体微微呼吸动作，微风吹拂发丝与衣角，窗帘自然轻晃，画面生动自然" },
  { name: "🎬 电影升降", tag: "镜头从低角度平缓升起俯瞰，光影倾泻而下，充满电影叙事史诗感" },
];

const sizes = [
  { value: "864x480" as const, name: "横屏画幅", ratio: "16:9", w: 32, h: 18 },
  { value: "480x864" as const, name: "竖屏全屏", ratio: "9:16", w: 18, h: 32 },
  { value: "640x640" as const, name: "方形构图", ratio: "1:1", w: 22, h: 22 },
];

const lengths = [
  { value: 124 as const, label: "约 5 秒", desc: "极速先锋 · 推荐首选" },
  { value: 243 as const, label: "约 10 秒", desc: "细腻延展 · 适中显存" },
  { value: 362 as const, label: "约 15 秒", desc: "完整镜头 · 需高显存" },
];

const busy = computed(() => job.running || job.preparing);
const ownJob = computed(() => job.running && job.mode === "video");
const supportsLast = computed(() => videoCapability.value?.supports_last_frame !== false);
const ready = computed(() => backend.running && videoCapability.value?.ready);

const saving = ref<string | null>(null);
const cancelling = ref(false);
const actionError = ref("");
const playbackErrors = ref<Record<string, boolean>>({});
const metadata = ref<Record<string, { width: number; height: number; seconds: number }>>({});

const progressPct = computed(() =>
  job.progress && job.progress.max > 0
    ? Math.min(100, Math.max(0, Math.round((job.progress.value / job.progress.max) * 100)))
    : null,
);

watch(
  () => backend.running,
  (running) => {
    if (running && !videoCapability.value) void refreshVideoCapability();
  },
  { immediate: true },
);

function applyCamera(tag: string) {
  const current = videoForm.prompt.trim();
  if (current.includes(tag)) return;
  videoForm.prompt = current ? `${current}，${tag}` : tag;
  emit("toast", "已注入电影运镜指令");
}

function filename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function loaded(path: string, event: Event) {
  const video = event.target as HTMLVideoElement;
  metadata.value[path] = {
    width: video.videoWidth,
    height: video.videoHeight,
    seconds: video.duration,
  };
  playbackErrors.value[path] = false;
}

async function run() {
  if (busy.value || !videoForm.firstFrame || !videoForm.prompt.trim()) return;
  try {
    await runVideo();
  } catch (e) {
    videoError.value = e instanceof Error ? e.message : String(e);
  }
}

async function cancel() {
  if (cancelling.value) return;
  cancelling.value = true;
  actionError.value = "";
  try {
    await cancelJob();
  } catch (e) {
    actionError.value = `取消失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    cancelling.value = false;
  }
}

async function saveCopy(path: string) {
  if (saving.value) return;
  saving.value = path;
  actionError.value = "";
  try {
    const directory = await pickDirectory("选择视频保存位置");
    if (!directory) return;
    await copyFile(path, directory);
    emit("toast", "视频副本已保存");
  } catch (e) {
    actionError.value = `保存副本失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    saving.value = null;
  }
}

async function openFile(path: string, reveal: boolean) {
  actionError.value = "";
  try {
    if (reveal) await revealPath(path);
    else await openPath(path);
  } catch (e) {
    actionError.value = `打开文件失败：${e instanceof Error ? e.message : String(e)}`;
  }
}
</script>

<template>
  <div class="studio-two-col video-workspace">
    <!-- 左侧：参数与首尾帧时间线 -->
    <div class="studio-control-panel">
      <!-- 引擎状态卡片 -->
      <div class="studio-card studio-card-glow" style="margin-bottom: 14px">
        <div class="studio-card-header" style="margin-bottom: 8px">
          <span class="studio-card-title">
            <Video :size="16" style="color: var(--st-cyan)" /> MiniMax H3 视频生成引擎
          </span>
          <button
            class="st-btn st-btn-ghost st-btn-sm"
            :disabled="busy || videoChecking"
            @click="refreshVideoCapability"
          >
            <RefreshCw :size="12" :class="{ spin: videoChecking }" />
            {{ videoChecking ? "自检中…" : "工作流自检" }}
          </button>
        </div>
        <div class="video-engine-status-row">
          <div class="engine-status-pill" :class="{ ok: ready }">
            <CheckCircle2 v-if="ready" :size="13" />
            <Cpu v-else :size="13" />
            <span>
              {{
                videoChecking
                  ? "正在检测本机工作流…"
                  : ready
                    ? "H3 节点与模型全部就绪"
                    : !backend.running
                      ? "启动生成时自动拉起后端"
                      : "需核对依赖节点或模型"
              }}
            </span>
          </div>
          <span class="engine-model-tag">H3 Turbo · 本地离线</span>
        </div>
      </div>

      <!-- 视觉时间线：首帧与尾帧 -->
      <div class="studio-card" style="margin-bottom: 14px">
        <div class="studio-card-header">
          <span class="studio-card-title">
            <Clapperboard :size="15" /> 视觉帧时间线 (Keyframes)
          </span>
          <button
            v-if="supportsLast"
            class="st-btn st-btn-ghost st-btn-sm"
            :disabled="busy || !videoForm.firstFrame || !videoForm.lastFrame"
            @click="swapVideoFrames"
          >
            <ArrowLeftRight :size="12" /> 对调首尾帧
          </button>
        </div>

        <div class="studio-timeline-flow">
          <div class="timeline-slot-box">
            <div class="slot-badge">起始首帧</div>
            <VideoFrameSlot
              v-model="videoForm.firstFrame"
              zone-key="video:first-frame"
              label="首帧 (起始)"
              required
              :disabled="busy"
              @preview="emit('preview', $event)"
            />
          </div>

          <div v-if="supportsLast" class="timeline-kinetic-arrow">
            <div class="arrow-line" />
            <ArrowRight :size="18" class="arrow-icon" />
            <span class="arrow-text">平滑过渡</span>
          </div>

          <div v-if="supportsLast" class="timeline-slot-box">
            <div class="slot-badge optional">结束尾帧 (可选)</div>
            <VideoFrameSlot
              v-model="videoForm.lastFrame"
              zone-key="video:last-frame"
              label="尾帧 (过渡目标)"
              :disabled="busy"
              @preview="emit('preview', $event)"
            />
          </div>
        </div>
      </div>

      <!-- 动作与镜头描述 (Prompt) -->
      <div class="studio-card" style="margin-bottom: 14px">
        <div class="studio-card-header">
          <span class="studio-card-title">
            <Sparkles :size="15" style="color: var(--st-iris)" /> 动作与运镜指令
          </span>
          <span class="studio-card-subtitle">支持输入微风、呼吸、推拉摇移等动态细节</span>
        </div>

        <div class="studio-prompt-box">
          <textarea
            v-model="videoForm.prompt"
            class="studio-prompt-textarea"
            placeholder="描述画面的动态过程：例如「镜头缓慢推近，人物眼睫微动，窗外微风吹拂发丝，光影随之流转」…"
          />
        </div>

        <!-- 运镜预设药丸 (Camera Presets) -->
        <div class="camera-preset-chips-wrap">
          <span class="camera-lead">运镜注入:</span>
          <button
            v-for="cam in CAMERA_PRESETS"
            :key="cam.name"
            class="studio-style-chip"
            @click="applyCamera(cam.tag)"
          >
            {{ cam.name }}
          </button>
        </div>
      </div>

      <!-- 规格与时长选择 -->
      <div class="studio-card" style="margin-bottom: 14px">
        <div class="studio-card-header" style="margin-bottom: 12px">
          <span class="studio-card-title">画幅比例与成片时长</span>
          <span class="studio-card-subtitle">24 帧 / 秒 电影帧率</span>
        </div>

        <div class="studio-aspect-grid" style="margin-bottom: 14px">
          <div
            v-for="s in sizes"
            :key="s.value"
            class="studio-aspect-card"
            :class="{ selected: videoForm.size === s.value }"
            @click="videoForm.size = s.value"
          >
            <div class="studio-aspect-shape-wrap">
              <div
                class="studio-aspect-shape"
                :style="{ width: `${s.w}px`, height: `${s.h}px` }"
              />
            </div>
            <div class="studio-aspect-label">{{ s.name }}</div>
            <div class="studio-aspect-size">{{ s.ratio }} ({{ s.value }})</div>
          </div>
        </div>

        <div class="duration-grid">
          <button
            v-for="len in lengths"
            :key="len.value"
            class="duration-card"
            :class="{ active: videoForm.length === len.value }"
            @click="videoForm.length = len.value"
          >
            <strong>{{ len.label }}</strong>
            <small>{{ len.desc }}</small>
          </button>
        </div>
      </div>

      <!-- 启动视频生成按钮 -->
      <div class="studio-action-row">
        <button
          class="st-btn st-btn-primary st-btn-hero"
          style="width: 100%"
          :disabled="busy || !videoForm.firstFrame || !videoForm.prompt.trim()"
          @click="run"
        >
          <Loader2 v-if="busy" :size="20" class="spin" />
          <Play v-else :size="20" />
          <span>
            <template v-if="job.running && ownJob">视频正在渲染中…</template>
            <template v-else-if="job.preparing">工作台初始化中…</template>
            <template v-else-if="!videoForm.firstFrame">请先添加视频首帧</template>
            <template v-else-if="!videoForm.prompt.trim()">请填写镜头与动作描述</template>
            <template v-else>立即渲染生成视频</template>
          </span>
        </button>
      </div>
    </div>

    <!-- 右侧：视频播放器与成片预览 -->
    <div class="studio-showcase-panel">
      <!-- 渲染中状态卡片 -->
      <div v-if="ownJob" class="studio-progress-card">
        <div class="progress-info-row">
          <div class="progress-stage-title">
            <Loader2 :size="16" class="spin" style="color: var(--st-cyan)" />
            <span>{{ job.stage || "H3 视频潜空间扩散采样中…" }}</span>
          </div>
          <div class="progress-stats">
            <span v-if="job.progress" class="mono">
              {{ job.progress.value }} / {{ job.progress.max }} 步
            </span>
            <span class="dot-divider">·</span>
            <span>已耗时 {{ formatDuration(job.elapsedMs) }}</span>
            <button class="st-btn st-btn-danger st-btn-sm" :disabled="cancelling" @click="cancel">
              <Square :size="11" /> {{ cancelling ? "正在停止…" : "中断渲染" }}
            </button>
          </div>
        </div>
        <div class="studio-progress-beam-track">
          <div
            class="studio-progress-beam-fill"
            :style="{ width: `${progressPct ?? 35}%` }"
          />
        </div>
      </div>

      <!-- 视频成果列表 -->
      <div v-if="videoResults.length" class="studio-video-results">
        <div v-for="path in videoResults" :key="path" class="studio-video-player-card">
          <div class="video-player-wrap">
            <video
              :src="fileUrl(path)"
              controls
              playsinline
              preload="metadata"
              class="studio-video-player"
              @loadedmetadata="loaded(path, $event)"
              @error="playbackErrors[path] = true"
            />
          </div>

          <div class="video-meta-bar">
            <div class="video-file-meta">
              <span class="video-title">{{ filename(path) }}</span>
              <span v-if="metadata[path]?.width" class="video-dims mono">
                {{ metadata[path].width }} × {{ metadata[path].height }} ·
                {{ metadata[path].seconds.toFixed(1) }} 秒
              </span>
            </div>
            <div class="video-actions-row">
              <button class="st-btn st-btn-ghost st-btn-sm" @click="openFile(path, true)">
                <FolderOpen :size="13" /> 打开目录
              </button>
              <button class="st-btn st-btn-ghost st-btn-sm" @click="saveCopy(path)">
                <Download :size="13" /> 另存副本
              </button>
              <button class="st-btn st-btn-ghost st-btn-sm" @click="openFile(path, false)">
                <Play :size="12" /> 系统播放
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 空白占位状态 -->
      <div v-else-if="!ownJob" class="studio-empty-state">
        <div class="studio-empty-icon-wrap" style="color: var(--st-cyan)">
          <Film :size="32" />
        </div>
        <div class="studio-empty-title">等待视频镜头诞生</div>
        <div class="studio-empty-desc">
          在左侧选定起始首帧，输入运动描述，ComfyUI MiniMax H3
          将为你逐帧推演光影流动，成片将在本区域高品质呈现。
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.video-engine-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.engine-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--st-text-secondary);
}

.engine-status-pill.ok {
  color: var(--st-emerald);
}

.engine-model-tag {
  font-size: 10px;
  font-family: var(--st-font-mono);
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--st-bg-surface-3);
  color: var(--st-text-muted);
}

.studio-timeline-flow {
  display: flex;
  align-items: center;
  gap: 16px;
}

.timeline-slot-box {
  flex: 1;
  position: relative;
}

.slot-badge {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--st-cyan);
  margin-bottom: 6px;
}

.slot-badge.optional {
  color: var(--st-text-muted);
}

.timeline-kinetic-arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--st-cyan);
  padding: 0 4px;
}

.arrow-line {
  width: 28px;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--st-cyan), transparent);
}

.arrow-icon {
  animation: pulse-arrow 1.6s ease-in-out infinite;
}

@keyframes pulse-arrow {
  0%, 100% { transform: translateX(0); opacity: 0.6; }
  50% { transform: translateX(3px); opacity: 1; }
}

.arrow-text {
  font-size: 9.5px;
  color: var(--st-text-dim);
}

.camera-preset-chips-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  margin-top: 10px;
  padding-bottom: 4px;
}

.camera-lead {
  font-size: 11.5px;
  color: var(--st-text-muted);
  white-space: nowrap;
}

.duration-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.duration-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 8px;
  border-radius: var(--st-radius-md);
  border: 1px solid var(--st-border-subtle);
  background: var(--st-bg-surface-2);
  color: var(--st-text-secondary);
  cursor: pointer;
  transition: all 0.16s ease;
}

.duration-card:hover {
  background: var(--st-bg-surface-3);
  border-color: var(--st-border-strong);
}

.duration-card.active {
  background: rgba(6, 182, 212, 0.14);
  border-color: var(--st-cyan);
  color: #ffffff;
  box-shadow: 0 0 16px rgba(6, 182, 212, 0.25);
}

.duration-card strong {
  font-size: 13px;
}

.duration-card small {
  font-size: 10px;
  color: var(--st-text-muted);
  margin-top: 2px;
}

.duration-card.active small {
  color: var(--st-cyan);
}

.studio-video-player-card {
  border-radius: var(--st-radius-lg);
  border: 1px solid var(--st-border);
  background: #090b10;
  overflow: hidden;
  box-shadow: 0 16px 40px -10px rgba(0, 0, 0, 0.7);
  margin-bottom: 16px;
}

.video-player-wrap {
  position: relative;
  width: 100%;
  max-height: 480px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000000;
}

.studio-video-player {
  width: 100%;
  max-height: 480px;
  object-fit: contain;
}

.video-meta-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: var(--st-bg-surface-1);
  border-top: 1px solid var(--st-border-subtle);
}

.video-file-meta {
  display: flex;
  flex-direction: column;
}

.video-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--st-text-primary);
}

.video-dims {
  font-size: 11px;
  color: var(--st-text-muted);
}

.video-actions-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>

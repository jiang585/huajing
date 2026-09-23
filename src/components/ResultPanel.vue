<script setup lang="ts">
/** 生成结果展示：进度、错误、产出图，以及图上的快捷操作。 */

import { computed, ref, watch } from "vue";
import {
  Loader2,
  Star,
  Maximize2,
  FolderOpen,
  ImageOff,
  AlertTriangle,
  Wand2,
  Sparkles,
  Clapperboard,
} from "lucide-vue-next";
import {
  imageInfos,
  thumbUrl,
  revealPath,
  formatDuration,
  type ImageInfo,
} from "../api/tauri";
import { job, cancelJob } from "../stores/job";
import { addMany } from "../stores/library";
import { MODES, type ModeId } from "../api/graphs";

const props = defineProps<{
  /** 当前页面的模式，用于判断能不能「送去 2K 放大」 */
  mode: ModeId;
  /** 上一次完成的结果（切页回来时还能看到） */
  results: string[];
}>();

const emit = defineEmits<{
  (e: "preview", index: number): void;
  (e: "sendTo", target: ModeId, path: string): void;
  (e: "openOutput"): void;
}>();

const infos = ref<Record<string, ImageInfo>>({});
const addedAll = ref(false);

watch(
  () => props.results.join("|"),
  async () => {
    addedAll.value = false;
    // 先把旧信息清掉：结果已经换了，旧路径的尺寸/缩略图不能再留着被误用
    infos.value = {};
    if (props.results.length === 0) return;
    try {
      const list = await imageInfos(props.results);
      const map: Record<string, ImageInfo> = {};
      list.forEach((i) => (map[i.path] = i));
      infos.value = map;
    } catch (e) {
      // 取尺寸/缩略图失败不该让面板停摆 —— 下面的 <img> 会用原图路径兜底
      console.error("[画境] 读取结果图信息失败：", e);
    }
  },
  { immediate: true },
);

const pct = computed(() => {
  const p = job.progress;
  if (!p || p.max <= 0) return 0;
  return Math.min(100, Math.round((p.value / p.max) * 100));
});

const showProgress = computed(() => job.running && job.mode === props.mode);
const hasResults = computed(() => props.results.length > 0);
const canSendToUpscale = computed(() => props.mode !== "upscale");

async function addAll() {
  await addMany(props.results, "generated");
  addedAll.value = true;
}

function dims(p: string) {
  const i = infos.value[p];
  if (!i || !i.width) return "";
  return `${i.width}×${i.height}`;
}
</script>

<template>
  <div class="card">
    <h3 class="card-title">
      <Sparkles :size="14" />
      生成结果
      <span v-if="job.mode === mode" class="muted">{{ MODES[mode].label }}</span>
      <div style="flex: 1"></div>
      <span v-if="hasResults && !job.running" class="muted">
        {{ results.length }} 张<template v-if="job.mode === mode"> · 上次耗时 {{ formatDuration(job.elapsedMs) }}</template>
      </span>
    </h3>

    <div v-if="job.mode === mode && job.warning" class="alert warn" style="margin-bottom: 12px">
      <AlertTriangle :size="15" />
      <div>{{ job.warning }}</div>
    </div>

    <!-- 进行中 -->
    <div v-if="showProgress" class="progress-wrap">
      <div class="progress-head">
        <Loader2 :size="14" class="spin" />
        <span>{{ job.stage || "执行中" }}</span>
        <div class="spacer"></div>
        <span v-if="job.progress" class="mono">
          {{ job.progress.value }} / {{ job.progress.max }} 步
        </span>
        <button class="btn sm danger" @click="cancelJob">取消</button>
      </div>
      <div class="progress-track">
        <div
          class="progress-fill"
          :class="{ indet: !job.progress }"
          :style="{ width: pct + '%' }"
        />
      </div>
      <div class="progress-meta">
        <span>已用时 {{ formatDuration(job.elapsedMs) }}</span>
        <span v-if="job.queueRemaining > 0">队列中还有 {{ job.queueRemaining }} 个任务</span>
      </div>
    </div>

    <!-- 出错 -->
    <div v-else-if="job.mode === mode && job.error" class="alert err" style="margin-bottom: 12px">
      <AlertTriangle :size="15" />
      <div>
        <div style="font-weight: 500">生成失败</div>
        <div style="margin-top: 3px; font-size: 12px; opacity: 0.9; white-space: pre-wrap">
          {{ job.error }}
        </div>
      </div>
    </div>

    <!-- 有结果 -->
    <template v-if="hasResults && !showProgress">
      <div class="flex wrap" style="margin-bottom: 11px">
        <button class="btn sm" :disabled="addedAll" @click="addAll">
          <Star :size="12" /> {{ addedAll ? "已全部加入图库" : "全部加入图库" }}
        </button>
        <button class="btn sm" @click="emit('openOutput')">
          <FolderOpen :size="12" /> 打开输出目录
        </button>
        <div style="flex: 1"></div>
      </div>

      <div class="result-grid">
        <div
          v-for="(p, i) in results"
          :key="p"
          class="result-item"
          @click="emit('preview', i)"
        >
          <!--
            不挂 loading="lazy"：这是刚生成出来的图，必须立刻加载。
            兜底传 p，这样 infos 还没到时也能直接显示原图，不会先空白再跳。
          -->
          <img :src="thumbUrl(infos[p], p)" alt="" />
          <span v-if="dims(p)" class="dims">{{ dims(p) }}</span>
          <div class="overlay" @click.stop>
            <button
              v-if="canSendToUpscale"
              class="btn sm"
              title="送去 2K 放大"
              @click="emit('sendTo', 'upscale', p)"
            >
              <Maximize2 :size="12" /> 2K
            </button>
            <button
              class="btn sm"
              title="送去单图编辑"
              @click="emit('sendTo', 'edit', p)"
            >
              <Wand2 :size="12" /> 编辑
            </button>
            <button
              class="btn sm"
              title="设为 MiniMax H3 视频首帧"
              @click="emit('sendTo', 'video', p)"
            >
              <Clapperboard :size="12" /> 视频
            </button>
            <button class="btn ghost sm" title="定位文件" @click="revealPath(p)">
              <FolderOpen :size="12" />
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 空态 -->
    <div v-else-if="!showProgress && !(job.mode === mode && job.error)" class="empty">
      <ImageOff :size="34" />
      <div class="empty-title">还没有结果</div>
      <div class="empty-sub">填好左边的参数，点「开始生成」</div>
    </div>
  </div>
</template>

<style scoped>
.spin {
  animation: rot 1s linear infinite;
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}
</style>

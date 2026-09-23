<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertCircle, CheckCircle2, Download, Film, FolderOpen, Loader2, Play, Square, Video } from "lucide-vue-next";
import { copyFile, fileUrl, formatDuration, openPath, pickDirectory, revealPath } from "../api/tauri";
import { job, cancelJob } from "../stores/job";
import { videoResults } from "../stores/video";

const emit = defineEmits<{ (e: "toast", message: string): void }>();
const saving = ref<string | null>(null);
const cancelling = ref(false);
const actionError = ref("");
const playbackErrors = ref<Record<string, boolean>>({});
const metadata = ref<Record<string, { width: number; height: number; seconds: number }>>({});
const running = computed(() => job.running && job.mode === "video");
const progress = computed(() => job.progress && job.progress.max > 0 ? Math.min(100, Math.max(0, Math.round(job.progress.value / job.progress.max * 100))) : null);

function filename(path: string) { return path.split(/[\\/]/).pop() ?? path; }

function loaded(path: string, event: Event) {
  const video = event.target as HTMLVideoElement;
  metadata.value[path] = { width: video.videoWidth, height: video.videoHeight, seconds: video.duration };
  playbackErrors.value[path] = false;
}

async function saveCopy(path: string) {
  if (saving.value) return;
  saving.value = path;
  actionError.value = "";
  try {
    const directory = await pickDirectory("选择视频副本的保存位置");
    if (!directory) return;
    await copyFile(path, directory);
    emit("toast", "视频副本已保存");
  } catch (e) {
    actionError.value = `保存副本失败：${e instanceof Error ? e.message : String(e)}`;
  } finally { saving.value = null; }
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

async function cancel() {
  if (cancelling.value) return;
  cancelling.value = true;
  actionError.value = "";
  try { await cancelJob(); }
  catch (e) { actionError.value = `取消失败：${e instanceof Error ? e.message : String(e)}`; }
  finally { cancelling.value = false; }
}
</script>

<template>
  <div class="card video-result">
    <div class="result-heading">
      <h3><Film :size="16" /> 视频预览</h3>
      <span v-if="videoResults.length && !running" class="saved-label"><CheckCircle2 :size="12" /> 已保存到本机</span>
      <span v-else-if="running" class="pill accent">正在生成</span>
    </div>

    <div v-if="running" class="video-progress" role="status" aria-live="polite">
      <div class="progress-title"><Loader2 :size="16" class="spin" /><strong>{{ job.stage || "准备生成视频" }}</strong><button class="btn sm danger" :disabled="cancelling" @click="cancel"><Square :size="11" /> {{ cancelling ? "正在取消…" : "取消生成" }}</button></div>
      <div class="progress-track" role="progressbar" aria-label="当前采样阶段进度" :aria-valuenow="progress ?? undefined" :aria-valuemin="progress !== null ? 0 : undefined" :aria-valuemax="progress !== null ? 100 : undefined"><div class="progress-fill" :class="{ indet: progress === null }" :style="{ width: `${progress ?? 34}%` }"></div></div>
      <div class="video-progress-meta"><span>已用时 {{ formatDuration(job.elapsedMs) }}</span><span v-if="job.progress && job.progress.max > 0">当前采样 {{ job.progress.value }} / {{ job.progress.max }} 步</span></div>
      <p>首次加载模型可能较慢，生成过程中可切换到其他页面。</p>
    </div>

    <div v-if="actionError" class="alert err action-error" role="alert"><AlertCircle :size="14" /><span>{{ actionError }}</span></div>
    <div v-if="job.mode === 'video' && job.warning" class="alert warn action-error" role="status"><AlertCircle :size="14" /><span>{{ job.warning }}</span></div>

    <div v-if="videoResults.length" class="video-results">
      <p v-if="running" class="previous-label">上次生成的结果</p>
      <article v-for="path in videoResults" :key="path" class="video-item">
        <div class="video-stage">
          <video :src="fileUrl(path)" controls playsinline preload="metadata" :aria-label="filename(path)" @loadedmetadata="loaded(path, $event)" @error="playbackErrors[path] = true">当前环境不支持内嵌播放，请使用系统播放器打开。</video>
        </div>
        <div v-if="playbackErrors[path]" class="playback-error"><AlertCircle :size="14" /><span>暂时无法内嵌播放，可打开系统播放器查看；若文件已移动，请到输出目录查找。</span></div>
        <div class="video-file-info">
          <span class="video-name" :title="path">{{ filename(path) }}</span>
          <span v-if="metadata[path]?.width" class="video-dimensions">{{ metadata[path].width }} × {{ metadata[path].height }}<template v-if="Number.isFinite(metadata[path].seconds)"> · {{ metadata[path].seconds.toFixed(1) }} 秒</template></span>
        </div>
        <div class="video-actions">
          <button class="btn sm" @click="openFile(path, true)"><FolderOpen :size="13" /> 打开所在目录</button>
          <button class="btn sm" :disabled="saving !== null" @click="saveCopy(path)"><Loader2 v-if="saving === path" :size="13" class="spin" /><Download v-else :size="13" /> {{ saving === path ? "保存中…" : "另存副本" }}</button>
          <button class="btn ghost sm" @click="openFile(path, false)"><Play :size="12" /> 系统播放器</button>
        </div>
      </article>
      <p v-if="!running && job.mode === 'video' && job.elapsedMs && !job.error" class="completion-time">本次生成耗时 {{ formatDuration(job.elapsedMs) }}</p>
    </div>

    <div v-else class="video-empty" :class="{ preparing: running }">
      <div class="empty-preview"><div class="frame-corner top-left"></div><div class="frame-corner top-right"></div><Video :size="36" :stroke-width="1.2" /><div class="frame-corner bottom-left"></div><div class="frame-corner bottom-right"></div></div>
      <h4>{{ running ? "正在把画面变成视频" : "下一段故事，从一张图开始" }}</h4>
      <p>{{ running ? "完成后会在这里显示视频，支持播放、下载副本和打开文件位置。" : "选择首帧，描述动作，然后生成。成片将在这里播放，也会自动保存到本机。" }}</p>
      <div v-if="!running" class="empty-format"><span>首帧 / 首尾帧</span><span>本地 H3 Turbo</span><span>24 帧 / 秒</span></div>
    </div>
  </div>
</template>

<style scoped>
.video-result { padding: 20px; min-width: 0; }
.result-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.result-heading h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 600; }
.result-heading h3 svg { color: #bbaaff; }
.saved-label { display: flex; align-items: center; gap: 5px; color: var(--ok); font-size: 11px; }
.video-progress { padding: 15px; border: 1px solid var(--accent-border); border-radius: 10px; background: var(--accent-soft); margin-bottom: 17px; }
.progress-title { display: flex; gap: 8px; align-items: center; margin-bottom: 13px; font-size: 12px; }
.progress-title > svg { color: #bbaaff; flex-shrink: 0; }
.progress-title strong { font-weight: 500; overflow-wrap: anywhere; }
.progress-title > .btn { margin-left: auto; flex-shrink: 0; }
.video-progress-meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 5px 10px; color: var(--text-2); font-size: 11px; margin-top: 9px; }
.video-progress p { margin: 8px 0 0; font-size: 11px; color: var(--text-2); }
.action-error { margin-bottom: 14px; font-size: 12px; overflow-wrap: anywhere; }
.previous-label { color: var(--text-2); font-size: 11px; margin: 0 0 8px; }
.video-item + .video-item { border-top: 1px solid var(--border); margin-top: 19px; padding-top: 19px; }
.video-stage { background: #080a0e; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; min-height: 190px; }
.video-stage video { width: 100%; display: block; max-height: 62vh; min-height: 160px; object-fit: contain; }
.video-file-info { display: flex; align-items: center; justify-content: space-between; gap: 6px 14px; flex-wrap: wrap; margin: 12px 0 10px; }
.video-name { min-width: 0; font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-dimensions { color: var(--text-2); font-size: 11px; white-space: nowrap; }
.video-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.completion-time { font-size: 11px; color: var(--text-3); margin: 14px 0 0; }
.playback-error { display: flex; align-items: flex-start; gap: 6px; padding-top: 10px; color: #ffd79a; font-size: 11px; line-height: 1.7; }
.playback-error svg { flex-shrink: 0; margin-top: 3px; }
.video-empty { min-height: 390px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 16px; text-align: center; }
.empty-preview { position: relative; width: 140px; height: 86px; display: grid; place-items: center; color: #9280cf; background: linear-gradient(135deg, rgba(124,92,255,.1), rgba(124,92,255,.02)); border-radius: 10px; margin-bottom: 24px; }
.frame-corner { position: absolute; width: 14px; height: 14px; border-color: rgba(143,116,255,.48); border-style: solid; }
.top-left { left: 0; top: 0; border-width: 1px 0 0 1px; border-radius: 9px 0 0 0; }
.top-right { right: 0; top: 0; border-width: 1px 1px 0 0; border-radius: 0 9px 0 0; }
.bottom-left { left: 0; bottom: 0; border-width: 0 0 1px 1px; border-radius: 0 0 0 9px; }
.bottom-right { right: 0; bottom: 0; border-width: 0 1px 1px 0; border-radius: 0 0 9px 0; }
.video-empty h4 { color: var(--text); font-size: 15px; font-weight: 500; margin: 0 0 8px; }
.video-empty p { color: var(--text-2); font-size: 12px; max-width: 310px; line-height: 1.9; margin: 0; }
.empty-format { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 24px; }
.empty-format span { color: var(--text-3); font-size: 10px; border: 1px solid var(--border); border-radius: 5px; padding: 2px 7px; }
.preparing { min-height: 280px; }
button:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 3px; }
.spin { animation: video-result-spin 1s linear infinite; }
@keyframes video-result-spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) { .video-result { padding: 14px; } .video-empty { min-height: 290px; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } .progress-fill.indet { animation: none; } }
</style>

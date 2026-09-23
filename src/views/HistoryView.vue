<script setup lang="ts">
/** 生成历史：图片与视频的预览、参数恢复和可审阅的清理操作。 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Search, Trash2, RotateCcw, FolderOpen, Eraser, ImageOff, Star, Lock, Film, AlertTriangle } from "lucide-vue-next";
import {
  history, filteredHistory, historyMode, historyQuery, loadHistory,
  removeHistory, clearHistory, pruneMissingHistory, type HistoryEntry,
} from "../stores/history";
import { imageInfos, thumbUrl, fileUrl, revealPath, formatDuration, pathExists, type ImageInfo } from "../api/tauri";
import { MODES, MODE_ORDER, type ModeId } from "../api/graphs";
import { forms, sendToMode, firstEmptySlot, setSlotMissing } from "../stores/creator";
import { restoreVideoFromHistory, setVideoFirstFrame } from "../stores/video";
import { vaultVisible } from "../stores/vault";
import { addMany } from "../stores/library";

const emit = defineEmits<{
  (e: "preview", paths: string[], index: number): void;
  (e: "go", page: string): void;
  (e: "toast", msg: string): void;
  (e: "moveToVault", paths: string[]): void;
}>();
const infos = ref<Record<string, ImageInfo>>({});
const loaded = ref(false);
const busy = ref(false);
const error = ref("");
const confirmation = ref<{ entry: HistoryEntry | null; withFiles: boolean } | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
let infoRequest = 0;

async function refreshInfos() {
  const request = ++infoRequest;
  const all = [...new Set(filteredHistory.value.filter((e) => e.mode !== "video").flatMap((e) => e.images))];
  infos.value = {};
  if (!all.length) return;
  try {
    const list = await imageInfos(all);
    if (request !== infoRequest) return;
    infos.value = Object.fromEntries(list.map((i) => [i.path, i]));
  } catch (e) { console.error("[画境] 读取历史图信息失败：", e); }
}
onMounted(async () => {
  try {
    if (!history.value.length) await loadHistory();
    await refreshInfos();
  } catch (e) { error.value = message(e); }
  finally { loaded.value = true; }
});
// 同样数量的筛选结果也可能对应完全不同的文件。
watch(() => filteredHistory.value.map((e) => `${e.id}:${e.images.join("|")}`).join("\n"), refreshInfos);
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
function stamp(ms: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}
function modeLabel(mode: ModeId) { return MODES[mode]?.label ?? mode; }
async function perform(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try { await action(); }
  catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}

/** 恢复输入与参数，避免把当前页面的旧参考图混进一次历史任务。 */
async function reuse(entry: HistoryEntry) {
  await perform(async () => {
    if (entry.mode === "video") {
      restoreVideoFromHistory(entry);
      emit("go", "video");
      emit("toast", "视频参数与首尾帧已填回，请检查后再生成");
      return;
    }
    const f = forms[entry.mode];
    if (!f) throw new Error("这条历史使用了当前版本不支持的模式。");
    const p = entry.params;
    const savedRefs = Array.isArray(p.refPaths) ? p.refPaths.filter((v): v is string => typeof v === "string") : null;
    const refs = Array.from({ length: MODES[entry.mode].slots.length }, (_, i) => savedRefs?.[i] ?? null);
    const exists = await Promise.all(refs.map((path) => path ? pathExists(path) : Promise.resolve(true)));
    f.prompt = entry.prompt;
    f.promptBefore = null;
    f.negative = entry.negative;
    if (p.model === "qwen" || p.model === "zimage") f.model = p.model;
    if (typeof p.size === "string") f.size = p.size;
    if (typeof p.resolution === "number") f.resolution = p.resolution;
    if (typeof p.steps === "number") f.steps = p.steps;
    if (typeof p.cfg === "number") f.cfg = p.cfg;
    if (typeof p.sampler === "string") f.sampler = p.sampler;
    if (typeof p.scheduler === "string") f.scheduler = p.scheduler;
    if (typeof p.seed === "number") { f.seed = p.seed; f.randomSeed = false; }
    f.refs = refs;
    f.marks = refs.map(() => null);
    refs.forEach((_, i) => setSlotMissing(`${entry.mode}:${MODES[entry.mode].slots[i].key}`, !exists[i]));
    const upscale = p.upscale as Record<string, unknown> | undefined;
    f.upscaleOverride = upscale && typeof upscale.prompt === "string" && typeof upscale.steps === "number"
      && typeof upscale.denoise === "number"
      ? { prompt: upscale.prompt, steps: upscale.steps, denoise: upscale.denoise } : null;
    emit("go", entry.mode);
    const missing = exists.filter((v) => !v).length;
    emit("toast", missing
      ? `参数已恢复；${missing} 张原参考图已不存在，请重新选择`
      : refs.length && !savedRefs
        ? "参数已恢复；这条旧历史未保存参考图，请重新选择"
        : "已恢复参数和参考图，并固定当次种子；可直接生成或继续修改");
  });
}
function reuseImages(entry: HistoryEntry) {
  const f = forms[entry.mode];
  if (!f || entry.mode === "video") return;
  f.refs = f.refs.map(() => null);
  f.marks = f.marks.map(() => null);
  const count = Math.min(entry.images.length, f.refs.length);
  entry.images.slice(0, count).forEach((p, i) => sendToMode(entry.mode, p, i));
  MODES[entry.mode].slots.forEach((s) => setSlotMissing(`${entry.mode}:${s.key}`, false));
  emit("go", entry.mode);
  emit("toast", `已把 ${count} 张结果图填进参考图槽位`);
}
function sendTo(target: ModeId, path: string) {
  if (target === "video") setVideoFirstFrame(path);
  else sendToMode(target, path, firstEmptySlot(target));
  emit("go", target);
  emit("toast", target === "video" ? "已设为视频首帧，填写动作描述即可继续" : `已放入「${modeLabel(target)}」的参考图槽位`);
}
async function collect(entry: HistoryEntry) {
  await perform(async () => { await addMany(entry.images, "generated"); emit("toast", "已加入备用图库"); });
}
async function locate(path: string) { await perform(async () => { await revealPath(path); }); }
async function prune() {
  await perform(async () => {
    const n = await pruneMissingHistory();
    emit("toast", n > 0 ? `清理了 ${n} 条失效记录` : "没有失效记录");
  });
}
async function askDelete(entry: HistoryEntry | null, withFiles = false) {
  if (busy.value) return;
  error.value = "";
  confirmation.value = { entry, withFiles };
  await nextTick();
  dialog.value?.showModal();
}
function closeConfirmation() {
  if (busy.value) return;
  dialog.value?.close();
  confirmation.value = null;
}
async function confirmDelete() {
  const pending = confirmation.value;
  if (!pending) return;
  await perform(async () => {
    if (pending.entry) {
      await removeHistory(pending.entry.id, pending.withFiles);
      emit("toast", pending.withFiles ? "已删除记录和文件" : "已删除记录，文件仍保留");
    } else {
      await clearHistory();
      emit("toast", "历史已清空，文件仍保留在输出目录");
    }
    dialog.value?.close();
    confirmation.value = null;
  });
}
const totals = computed(() => ({
  images: history.value.filter((e) => e.mode !== "video").reduce((n, e) => n + e.images.length, 0),
  videos: history.value.filter((e) => e.mode === "video").reduce((n, e) => n + e.images.length, 0),
}));
const paramLabels: Record<string, string> = {
  model: "模型", size: "画布", resolution: "参考图分辨率", steps: "步数", cfg: "提示词强度", seed: "种子",
  sampler: "采样器", scheduler: "调度器", refCount: "参考图", duration: "时长", durationSeconds: "时长",
  fps: "帧率", promptOptimizer: "提示词优化", prompt_optimizer: "提示词优化",
};
function paramsFor(entry: HistoryEntry) {
  const out: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(entry.params)) {
    if (!(key in paramLabels) || value == null || typeof value === "object") continue;
    let text = String(value);
    if (key === "model") text = value === "qwen" ? "Qwen-Image 2.1" : value === "zimage" ? "Z-Image Turbo" : text;
    if (key === "refCount") text += " 张";
    if (key === "duration" || key === "durationSeconds") text += " 秒";
    if (typeof value === "boolean") text = value ? "开启" : "关闭";
    out.push({ label: paramLabels[key], value: text });
  }
  const upscale = entry.params.upscale as Record<string, unknown> | undefined;
  if (upscale && typeof upscale.steps === "number") out.push({ label: "精修步数", value: String(upscale.steps) });
  if (upscale && typeof upscale.denoise === "number") out.push({ label: "精修降噪", value: String(upscale.denoise) });
  return out;
}
</script>

<template>
  <div>
    <div class="history-toolbar">
      <div class="history-search"><Search :size="14" /><input v-model="historyQuery" class="input" aria-label="搜索历史提示词" placeholder="搜索提示词" /></div>
      <select v-model="historyMode" class="select history-filter" aria-label="筛选生成类型">
        <option value="all">所有生成类型</option>
        <option v-for="m in MODE_ORDER" :key="m" :value="m">{{ modeLabel(m) }}</option>
      </select>
      <span class="history-count">{{ history.length }} 条记录 · {{ totals.images }} 张图<template v-if="totals.videos"> · {{ totals.videos }} 段视频</template></span>
      <button class="btn sm" :disabled="busy" @click="prune"><Eraser :size="12" /> 清理失效</button>
      <button class="btn sm danger" :disabled="busy || !history.length" @click="askDelete(null)"><Trash2 :size="12" /> 清空历史</button>
    </div>
    <div v-if="error && !confirmation" class="alert err history-error" role="alert"><AlertTriangle :size="15" /><span>{{ error }}</span></div>
    <div v-if="!loaded" class="empty">正在读取历史…</div>
    <div v-else-if="!filteredHistory.length" class="empty">
      <ImageOff :size="36" />
      <div class="empty-title">{{ history.length ? "没有符合条件的记录" : "还没有历史记录" }}</div>
      <div class="empty-sub">{{ history.length ? "试试其他关键词或生成类型" : "生成的图片与视频会自动记录在这里" }}</div>
      <button v-if="history.length" class="btn sm" style="margin-top: 12px" @click="historyQuery = ''; historyMode = 'all'">清除筛选</button>
    </div>
    <div v-else class="hist-list">
      <article v-for="e in filteredHistory" :key="e.id" class="card hist-item">
        <div class="hist-head">
          <span class="pill accent">{{ modeLabel(e.mode) }}</span>
          <span class="pill" :class="e.status === 'done' ? '' : e.status === 'failed' ? 'err' : 'warn'">{{ e.status === "done" ? "成功" : e.status === "failed" ? "失败" : "已取消" }}</span>
          <span class="muted">{{ stamp(e.createdAt) }}</span>
          <span v-if="e.durationMs" class="muted">耗时 {{ formatDuration(e.durationMs) }}</span>
        </div>
        <div class="hist-prompt">{{ e.prompt || "（无提示词）" }}</div>
        <div v-if="e.error" class="alert history-error" :class="e.status === 'canceled' ? 'warn' : 'err'">{{ e.error }}</div>
        <div v-if="e.mode === 'video' && e.images.length" class="history-videos">
          <div v-for="p in e.images" :key="p" class="history-video">
            <video :src="fileUrl(p)" controls preload="metadata" playsinline />
            <button class="btn sm" :disabled="busy" @click="locate(p)"><FolderOpen :size="12" /> 定位视频文件</button>
          </div>
        </div>
        <div v-else-if="e.images.length" class="result-grid history-images">
          <div v-for="(p, i) in e.images" :key="p" class="history-image">
            <button class="history-preview" :aria-label="`预览第 ${i + 1} 张结果图`" @click="emit('preview', e.images, i)">
              <img :src="thumbUrl(infos[p], p)" alt="生成结果" loading="lazy" />
              <span v-if="infos[p]?.width" class="dims">{{ infos[p].width }}×{{ infos[p].height }}</span>
              <span v-if="infos[p]?.exists === false" class="missing-image">文件已不存在</span>
            </button>
            <div class="history-image-actions">
              <button class="btn ghost sm" :disabled="infos[p]?.exists === false" @click="sendTo('video', p)"><Film :size="12" /> 生视频</button>
              <button class="btn ghost sm" :disabled="infos[p]?.exists === false" @click="sendTo('upscale', p)">2K</button>
              <button class="btn ghost sm" :disabled="infos[p]?.exists === false" @click="sendTo('edit', p)">编辑</button>
              <button v-if="vaultVisible" class="btn ghost sm" title="移入隐私空间" aria-label="将图片移入隐私空间" @click="emit('moveToVault', [p])"><Lock :size="12" /></button>
              <button class="btn ghost sm" title="定位图片文件" aria-label="定位图片文件" :disabled="busy" @click="locate(p)"><FolderOpen :size="12" /></button>
            </div>
          </div>
        </div>
        <div v-if="paramsFor(e).length" class="hist-params"><span v-for="p in paramsFor(e)" :key="p.label" class="pill">{{ p.label }}：{{ p.value }}</span></div>
        <div class="hist-actions">
          <button class="btn sm" :disabled="busy" @click="reuse(e)"><RotateCcw :size="12" /> 恢复到表单</button>
          <template v-if="e.mode !== 'video' && e.images.length">
            <button v-if="MODES[e.mode]?.slots.length" class="btn ghost sm" @click="reuseImages(e)">结果用作参考</button>
            <button class="btn ghost sm" :disabled="busy" @click="collect(e)"><Star :size="12" /> 加入图库</button>
            <button v-if="vaultVisible" class="btn ghost sm" @click="emit('moveToVault', e.images)"><Lock :size="12" /> 移入隐私空间</button>
          </template>
          <span class="action-spacer"></span>
          <button class="btn ghost sm" :disabled="busy" @click="askDelete(e)">移除记录</button>
          <button v-if="e.images.length" class="btn ghost sm danger" :disabled="busy" @click="askDelete(e, true)"><Trash2 :size="12" /> 删除文件…</button>
        </div>
      </article>
    </div>
    <dialog v-if="confirmation" ref="dialog" class="history-confirm" aria-labelledby="history-confirm-title" @cancel.prevent="closeConfirmation">
      <div class="modal-head"><span id="history-confirm-title" class="modal-title">{{ confirmation.withFiles ? "删除生成文件和记录？" : confirmation.entry ? "移除这条记录？" : "清空所有历史记录？" }}</span></div>
      <div class="modal-body">
        <template v-if="confirmation.withFiles && confirmation.entry">
          <p>将永久删除下面 {{ confirmation.entry.images.length }} 个文件；图库和表单中引用这些文件的位置也将失效。此操作无法撤销。</p>
          <ul class="delete-paths"><li v-for="p in confirmation.entry.images" :key="p">{{ p }}</li></ul>
        </template>
        <p v-else-if="confirmation.entry">仅移除这条任务的参数记录，已生成的文件会保留在输出目录。</p>
        <p v-else>将清空全部 {{ history.length }} 条参数记录，已生成的图片与视频文件会保留。历史参数无法恢复。</p>
        <p v-if="confirmation.entry" class="confirm-prompt">{{ confirmation.entry.prompt || "（无提示词）" }}</p>
        <div v-if="error" class="alert err history-error" role="alert">{{ error }}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" autofocus :disabled="busy" @click="closeConfirmation">保留</button>
        <button class="btn danger" :disabled="busy" @click="confirmDelete">{{ busy ? "处理中…" : confirmation.withFiles ? "永久删除文件" : confirmation.entry ? "移除记录" : "清空记录" }}</button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.history-toolbar, .hist-head, .hist-actions, .hist-params, .history-image-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.history-toolbar { margin-bottom: 16px; }
.history-search { position: relative; flex: 1 1 210px; max-width: 340px; }
.history-search svg { position: absolute; top: 11px; left: 10px; color: var(--text-3); }
.history-search input { padding-left: 32px; }
.history-filter { width: auto; min-width: 150px; }
.history-count { color: var(--text-3); font-size: 12px; margin-right: auto; }
.hist-list { display: flex; flex-direction: column; gap: 14px; }
.hist-item { padding: 16px; }
.hist-head { font-size: 12px; }
.hist-prompt { margin-top: 12px; font-size: 13px; color: var(--text); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 150px; overflow-y: auto; }
.hist-params { margin-top: 12px; gap: 6px; }
.hist-actions { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 12px; }
.action-spacer { flex: 1; }
.history-error { white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0; }
.history-images { margin-top: 12px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.history-image { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-2); }
.history-preview { position: relative; padding: 0; display: block; width: 100%; aspect-ratio: 4 / 3; border: 0; background: var(--bg-1); cursor: zoom-in; }
.history-preview img { width: 100%; height: 100%; object-fit: contain; display: block; }
.dims, .missing-image { position: absolute; right: 7px; top: 7px; font-size: 10px; background: rgba(0, 0, 0, .7); color: #fff; padding: 3px 6px; border-radius: 4px; }
.missing-image { inset: auto 8px 8px; font-size: 12px; }
.history-image-actions { padding: 7px; gap: 3px; }
.history-videos { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 12px; margin-top: 12px; }
.history-video { min-width: 0; }
.history-video video { width: 100%; max-height: 440px; background: #000; display: block; border-radius: var(--radius); margin-bottom: 8px; }
.history-confirm { padding: 0; max-width: min(560px, calc(100vw - 32px)); width: 560px; max-height: calc(100vh - 48px); background: var(--bg-1); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
.history-confirm::backdrop { background: rgba(0, 0, 0, .65); backdrop-filter: blur(3px); }
.history-confirm p { font-size: 13px; line-height: 1.7; margin: 0 0 12px; }
.history-confirm .modal-body { max-height: 60vh; }
.delete-paths { list-style: none; margin: 12px 0; padding: 10px; border-radius: var(--radius); background: var(--bg-2); font-size: 12px; overflow-wrap: anywhere; }
.delete-paths li + li { margin-top: 8px; }
.confirm-prompt { color: var(--text-3); max-height: 110px; overflow: auto; white-space: pre-wrap; }
@media (max-width: 680px) { .history-count { flex-basis: 100%; } .action-spacer { display: none; } .history-images { grid-template-columns: minmax(0, 1fr); } }
</style>

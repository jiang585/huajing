<script setup lang="ts">
/** 大图预览：看原图、在资源管理器里定位、另存为、加入图库。 */

import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import {
  X,
  FolderOpen,
  Star,
  Trash2,
  ChevronLeft,
  Copy,
  Lock,
  Loader2,
  Maximize2,
  Minimize2,
} from "lucide-vue-next";
import {
  fileUrl,
  imageInfo,
  openPath,
  revealPath,
  copyFile,
  deleteFile,
  pickDirectory,
  formatBytes,
  type ImageInfo,
} from "../api/tauri";
import { addExisting } from "../stores/library";

const props = defineProps<{
  /** 要预览的图片路径列表 */
  paths: string[];
  index: number;
  /** 是否显示删除按钮 */
  deletable?: boolean;
  /**
   * 是否显示「移入隐私空间」按钮。
   * 只有「未启用」或「本次已解锁」才为 true —— 已启用但锁定时按钮必须消失，
   * 否则等于告诉别人有这么个隐私空间。
   */
  vaultReady?: boolean;
  /** 正在移入，按钮显示 loading */
  moving?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:index", v: number): void;
  (e: "deleted", path: string): void;
  (e: "moveToVault", path: string): void;
}>();

const info = ref<ImageInfo | null>(null);
const toast = ref("");
const added = ref(false);
/** false = 适应窗口，true = 1:1 原尺寸（靠滚动看细节） */
const actualSize = ref(false);

const current = computed(() => props.paths[props.index] ?? null);
const url = computed(() => fileUrl(current.value));
const many = computed(() => props.paths.length > 1);

async function refresh() {
  added.value = false;
  toast.value = "";
  // 换图就回到适应窗口，免得上一张的缩放状态影响这一张
  actualSize.value = false;
  if (!current.value) return;
  info.value = await imageInfo(current.value);
}

watch(() => [props.index, props.paths.length], refresh, { immediate: true });

function prev() {
  if (props.index > 0) emit("update:index", props.index - 1);
}
function next() {
  if (props.index < props.paths.length - 1) emit("update:index", props.index + 1);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "ArrowLeft") prev();
  else if (e.key === "ArrowRight") next();
  else if (e.key === "f" || e.key === "F" || e.key === "0") actualSize.value = !actualSize.value;
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

async function flash(msg: string) {
  toast.value = msg;
  window.setTimeout(() => {
    if (toast.value === msg) toast.value = "";
  }, 2200);
}

async function addToLibrary() {
  if (!current.value) return;
  const r = await addExisting(current.value, "generated");
  added.value = true;
  await flash(r ? "已加入备用图库" : "这张图已经在图库里了");
}

async function saveAs() {
  if (!current.value) return;
  const dir = await pickDirectory("另存到哪个文件夹");
  if (!dir) return;
  try {
    const p = await copyFile(current.value, dir);
    await flash(`已另存到 ${p}`);
  } catch (e) {
    await flash(`另存失败：${e}`);
  }
}

async function remove() {
  if (!current.value) return;
  const p = current.value;
  try {
    await deleteFile(p);
    emit("deleted", p);
    await flash("已删除");
    if (props.paths.length <= 1) emit("close");
    else if (props.index >= props.paths.length - 1) emit("update:index", props.paths.length - 2);
  } catch (e) {
    await flash(`删除失败：${e}`);
  }
}

async function copyPath() {
  if (!current.value) return;
  try {
    await navigator.clipboard.writeText(current.value);
    await flash("路径已复制");
  } catch {
    await flash("复制失败");
  }
}
</script>

<template>
  <div v-if="current" class="lightbox">
    <div class="lightbox-bar">
      <button v-if="many" class="btn ghost sm" :disabled="index === 0" @click="prev">
        <ChevronLeft :size="15" />
      </button>
      <span class="name">
        {{ current.split(/[\\/]/).pop() }}
      </span>
      <span v-if="info" class="pill">
        {{ info.width }}×{{ info.height }} · {{ formatBytes(info.bytes) }}
      </span>
      <span v-if="many" class="pill accent">{{ index + 1 }} / {{ paths.length }}</span>
      <span v-if="toast" class="pill ok">{{ toast }}</span>
      <div class="topbar-spacer" style="flex: 1"></div>

      <button
        class="btn sm"
        :title="actualSize ? '缩小到适应窗口（F）' : '按原尺寸显示，可滚动看细节（F）'"
        @click="actualSize = !actualSize"
      >
        <Maximize2 v-if="actualSize" :size="13" />
        <Minimize2 v-else :size="13" />
        {{ actualSize ? "适应窗口" : "1:1" }}
      </button>
      <button class="btn sm" :disabled="added" @click="addToLibrary">
        <Star :size="13" /> {{ added ? "已在图库" : "加入图库" }}
      </button>
      <button
        v-if="vaultReady"
        class="btn sm"
        :disabled="moving"
        title="加密收进隐私空间，原文件会删除、历史记录里也查不到"
        @click="emit('moveToVault', current)"
      >
        <Loader2 v-if="moving" :size="13" class="spin" />
        <Lock v-else :size="13" />
        移入隐私空间
      </button>
      <button class="btn sm" @click="saveAs"><Copy :size="13" /> 另存为</button>
      <button class="btn sm" @click="revealPath(current)"><FolderOpen :size="13" /> 定位文件</button>
      <button class="btn sm" @click="openPath(current)"><FolderOpen :size="13" /> 用默认程序打开</button>
      <button class="btn ghost sm" title="复制路径" @click="copyPath"><Copy :size="13" /></button>
      <button v-if="deletable" class="btn danger sm" @click="remove">
        <Trash2 :size="13" />
      </button>
      <button class="btn ghost sm" @click="emit('close')"><X :size="16" /></button>
    </div>

    <div class="lightbox-stage" :class="{ actual: actualSize }" @click.self="emit('close')">
      <img :src="url" alt="" />
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

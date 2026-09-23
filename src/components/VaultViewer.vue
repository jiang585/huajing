<script setup lang="ts">
/**
 * 隐私空间的图片查看器。
 *
 * 和普通预览（Lightbox）长得一样，但机制完全不同：这里没有本地文件路径可给
 * asset 协议读 —— 图片是加密存的，得让 Rust 侧解密后在内存里转成 base64 传过来。
 * 所以它是独立组件而不是给 Lightbox 加分支：条件分支堆多了就成补丁了。
 *
 * 解密结果只在内存里缓存，锁定或关掉应用就没了，磁盘上始终只有密文。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  X,
  ChevronLeft,
  Loader2,
  Download,
  FolderOutput,
  Trash2,
  Lock,
  AlertTriangle,
} from "lucide-vue-next";
import type { VaultEntry } from "../api/tauri";
import { previewVaultImage, saveVaultImageAs } from "../stores/vault";
import { formatBytes } from "../api/tauri";

const props = defineProps<{
  entries: VaultEntry[];
  index: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:index", v: number): void;
  (e: "moveOut", id: string): void;
  (e: "remove", id: string): void;
  (e: "toast", msg: string): void;
}>();

/** id -> 解密后的 data URL，仅本次会话有效 */
const cache = new Map<string, string>();
const url = ref("");
const loading = ref(false);
const err = ref("");

const current = computed(() => props.entries[props.index] ?? null);
const many = computed(() => props.entries.length > 1);

async function load(id: string) {
  err.value = "";
  const hit = cache.get(id);
  if (hit) {
    url.value = hit;
    return;
  }
  url.value = "";
  loading.value = true;
  try {
    const dataUrl = await previewVaultImage(id);
    cache.set(id, dataUrl);
    // 期间用户可能已经翻页了，避免把旧图盖上去
    if (current.value?.id === id) url.value = dataUrl;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => current.value?.id,
  (id) => {
    if (id) load(id);
  },
  { immediate: true },
);

function prev() {
  if (props.index > 0) emit("update:index", props.index - 1);
}
function next() {
  if (props.index < props.entries.length - 1) emit("update:index", props.index + 1);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "ArrowLeft") prev();
  else if (e.key === "ArrowRight") next();
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

async function download() {
  if (!current.value) return;
  try {
    const p = await saveVaultImageAs(current.value.id);
    if (p) emit("toast", `已另存到 ${p}`);
  } catch (e) {
    emit("toast", `另存失败：${e instanceof Error ? e.message : e}`);
  }
}
</script>

<template>
  <div v-if="current" class="lightbox">
    <div class="lightbox-bar">
      <button v-if="many" class="btn ghost sm" :disabled="index === 0" @click="prev">
        <ChevronLeft :size="15" />
      </button>
      <Lock :size="13" style="color: var(--accent-hover)" />
      <span class="name">{{ current.name }}</span>
      <span class="pill">
        {{ current.width }}×{{ current.height }} · {{ formatBytes(current.bytes) }}
      </span>
      <span v-if="many" class="pill accent">{{ index + 1 }} / {{ entries.length }}</span>
      <span v-if="loading" class="pill warn"><Loader2 :size="11" class="spin" /> 解密中</span>
      <span class="pill" title="资产以高强度密文存储，当前为解密至系统内存的运行时视图">
        运行时解密（内存驻留）
      </span>

      <div style="flex: 1"></div>

      <button class="btn sm" @click="download"><Download :size="13" /> 另存为</button>
      <button class="btn sm" @click="emit('moveOut', current.id)">
        <FolderOutput :size="13" /> 解密导出
      </button>
      <button class="btn danger sm" @click="emit('remove', current.id)">
        <Trash2 :size="13" /> 永久销毁
      </button>
      <button class="btn ghost sm" @click="emit('close')"><X :size="16" /></button>
    </div>

    <div class="lightbox-stage" @click.self="emit('close')">
      <div v-if="loading" class="empty" style="color: var(--text-2)">
        <Loader2 :size="30" class="spin" />
        <div style="margin-top: 10px">正在解密…</div>
      </div>
      <div v-else-if="err" class="alert err" style="max-width: 460px">
        <AlertTriangle :size="15" />
        <div>{{ err }}</div>
      </div>
      <img v-else-if="url" :src="url" alt="" />
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

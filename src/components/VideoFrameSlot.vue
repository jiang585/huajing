<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { FolderOpen, ImagePlus, Library, Maximize2, X } from "lucide-vue-next";
import { imageInfo, pickImages, thumbUrl, type ImageInfo } from "../api/tauri";
import { hoverZone, useDropZone } from "../composables/useDropZone";
import LibraryPicker from "./LibraryPicker.vue";

const props = defineProps<{
  modelValue: string | null;
  zoneKey: string;
  label: string;
  required?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", path: string | null): void;
  (e: "preview", path: string): void;
}>();

const info = ref<ImageInfo | null>(null);
const error = ref("");
const showLibrary = ref(false);
let request = 0;
const missing = computed(() => info.value?.exists === false);
const filename = computed(() => props.modelValue?.split(/[\\/]/).pop() ?? "");

watch(() => props.modelValue, async (path) => {
  const current = ++request;
  info.value = null;
  error.value = "";
  if (!path) return;
  try {
    const result = await imageInfo(path);
    if (current === request) info.value = result;
  } catch (e) {
    if (current === request) error.value = `无法读取图片：${String(e)}`;
  }
}, { immediate: true });

function select(path: string | null) {
  if (props.disabled) return;
  emit("update:modelValue", path);
  showLibrary.value = false;
}

async function choose() {
  if (props.disabled) return;
  try {
    const paths = await pickImages();
    if (paths[0]) select(paths[0]);
  } catch (e) {
    error.value = `选图失败：${String(e)}`;
  }
}

useDropZone(props.zoneKey, (paths) => {
  if (paths[0]) select(paths[0]);
});
</script>

<template>
  <section class="frame-slot" :class="{ 'is-dragging': !disabled && hoverZone === zoneKey }" :data-drop-zone="disabled ? undefined : zoneKey">
    <div class="frame-heading">
      <span>{{ label }}</span>
      <span class="frame-badge">{{ required ? "必选" : "可选" }}</span>
    </div>
    <button
      class="frame-preview"
      :class="{ filled: modelValue && !missing && !error }"
      :disabled="disabled && !modelValue"
      :aria-label="modelValue && !missing ? `预览${label}` : `选择${label}`"
      @click="modelValue && !missing && !error ? emit('preview', modelValue) : choose()"
    >
      <template v-if="modelValue && !missing && !error">
        <img :src="thumbUrl(info, modelValue)" :alt="label" />
        <span class="preview-hint"><Maximize2 :size="12" /> 预览</span>
      </template>
      <template v-else>
        <ImagePlus :size="25" :stroke-width="1.5" />
        <span>{{ missing ? "图片已被移动或删除" : "点击选图，或拖到这里" }}</span>
        <small>{{ required ? "视频从这张画面开始" : "指定视频结束时的画面" }}</small>
      </template>
    </button>
    <div class="frame-actions">
      <button class="btn sm" :disabled="disabled" @click="choose"><FolderOpen :size="12" /> {{ modelValue ? "换图" : "选文件" }}</button>
      <button class="btn sm" :disabled="disabled" @click="showLibrary = true"><Library :size="12" /> 图库</button>
      <button v-if="modelValue" class="btn ghost sm clear-frame" :disabled="disabled" :aria-label="`清除${label}`" :title="`清除${label}`" @click="select(null)"><X :size="14" /></button>
    </div>
    <div v-if="error" class="frame-error" role="alert">{{ error }}</div>
    <div v-else-if="missing" class="frame-error">文件已丢失，请重新选图。</div>
    <div v-else-if="modelValue" class="frame-meta" :title="modelValue">
      <span>{{ filename }}</span>
      <small v-if="info?.width">{{ info.width }} × {{ info.height }}</small>
    </div>
  </section>
  <LibraryPicker v-if="showLibrary" @close="showLibrary = false" @pick="select" />
</template>

<style scoped>
.frame-slot { min-width: 0; border: 1px solid var(--border); border-radius: 11px; padding: 10px; background: var(--bg-2); }
.frame-slot.is-dragging { border-color: var(--accent); background: var(--accent-soft); }
.frame-heading { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 9px; color: var(--text); font-size: 12px; font-weight: 500; }
.frame-badge { font-size: 10px; color: var(--text-2); background: var(--bg-3); border-radius: 4px; padding: 0 5px; font-weight: 400; }
.frame-preview { display: flex; position: relative; flex-direction: column; gap: 6px; align-items: center; justify-content: center; width: 100%; aspect-ratio: 4 / 3; min-height: 118px; overflow: hidden; border: 1px dashed var(--border-strong); border-radius: 7px; padding: 9px; color: var(--text-2); background: var(--bg-1); cursor: pointer; font-family: inherit; font-size: 11px; line-height: 1.6; }
.frame-preview.filled { padding: 0; border-style: solid; background: #090b0f; }
.frame-preview:not(:disabled):hover { border-color: var(--accent-border); }
.frame-preview img { position: absolute; width: 100%; height: 100%; object-fit: contain; }
.frame-preview small { font-size: 10px; color: var(--text-3); }
.preview-hint { position: absolute; bottom: 6px; right: 6px; display: flex; gap: 4px; align-items: center; background: rgba(0,0,0,.65); color: #fff; border-radius: 5px; padding: 2px 6px; font-size: 10px; }
.frame-actions { display: flex; gap: 5px; margin-top: 8px; }
.frame-actions .btn { padding: 0 7px; font-size: 11px; }
.clear-frame { margin-left: auto; }
.frame-meta { display: flex; flex-wrap: wrap; gap: 2px 6px; margin-top: 7px; color: var(--text-3); font-size: 10px; }
.frame-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frame-meta small { white-space: nowrap; font-size: 10px; }
.frame-error { color: #ffb3b5; font-size: 11px; margin-top: 6px; overflow-wrap: anywhere; }
button:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 3px; }
</style>

<script setup lang="ts">
/**
 * 单个图片槽：点击选图、拖拽落图、从备用图库插入、画面标注。
 *
 * 标注过的话，槽里显示的是**带标记的那张图** —— 送进模型的就是它，
 * 所见即所送，不用靠记忆判断到底会传哪一张。
 */

import { computed, ref, watch } from "vue";
import {
  Image as ImageIcon,
  FolderOpen,
  X,
  Library,
  Pencil,
  RotateCcw,
} from "lucide-vue-next";
import { pickImages, imageInfo, thumbUrl, type ImageInfo } from "../api/tauri";
import { hoverZone, useDropZone } from "../composables/useDropZone";
import { setSlotMissing } from "../stores/creator";
import LibraryPicker from "./LibraryPicker.vue";
import Annotator from "./Annotator.vue";

const props = defineProps<{
  /** 落图区标识，全局唯一 */
  zoneKey: string;
  label: string;
  required?: boolean;
  /** 原始图片路径，空表示未选 */
  modelValue: string | null;
  /** 标注后的图片路径；有值则优先展示与使用 */
  annotated?: string | null;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: string | null): void;
  (e: "update:annotated", v: string | null): void;
  (e: "preview", path: string): void;
}>();

const info = ref<ImageInfo | null>(null);
const showPicker = ref(false);
const showAnnotator = ref(false);

useDropZone(props.zoneKey, (paths) => {
  if (paths[0]) {
    emit("update:modelValue", paths[0]);
    // 换了图，之前的标注就不对应了，直接清掉
    emit("update:annotated", null);
  }
});

const isHover = computed(() => hoverZone.value === props.zoneKey);
/** 展示用：标注版优先 */
const displayPath = computed(() => props.annotated ?? props.modelValue);
const hasMark = computed(() => !!props.annotated);

async function refresh() {
  const mark = props.annotated;
  const orig = props.modelValue;

  // 标注只是**派生副本** —— `_标注` 目录有回收策略，用户也可能手动清掉它。
  // 所以标注文件没了但原图还在时必须退回原图：否则原图明明好好的，
  // 槽位却报「文件已丢失」，而且生成时会把不存在的路径传给 ComfyUI，上传直接失败。
  if (mark) {
    const mi = await imageInfo(mark).catch(() => null);
    if (mi?.exists) {
      info.value = mi;
      setSlotMissing(props.zoneKey, false);
      return;
    }
    emit("update:annotated", null); // 标注失效，清掉它
  }

  if (!orig) {
    info.value = null;
    setSlotMissing(props.zoneKey, false);
    return;
  }
  const oi = await imageInfo(orig).catch(() => null);
  info.value = oi;
  // 记下文件是否真的不在，供生成前拦截
  setSlotMissing(props.zoneKey, oi !== null && !oi.exists);
}

watch(displayPath, refresh, { immediate: true });

const url = computed(() => thumbUrl(info.value, displayPath.value));
const missing = computed(() => info.value !== null && !info.value.exists);

async function choose() {
  const picked = await pickImages();
  if (picked.length > 0) {
    emit("update:modelValue", picked[0]);
    emit("update:annotated", null);
  }
}

function clear(e: MouseEvent) {
  e.stopPropagation();
  emit("update:modelValue", null);
  emit("update:annotated", null);
}

function fromLibrary(e: MouseEvent) {
  e.stopPropagation();
  showPicker.value = true;
}

function onPicked(path: string) {
  emit("update:modelValue", path);
  emit("update:annotated", null);
  showPicker.value = false;
}

function openAnnotator(e: MouseEvent) {
  e.stopPropagation();
  if (!props.modelValue) return;
  showAnnotator.value = true;
}

function clearMark(e: MouseEvent) {
  e.stopPropagation();
  emit("update:annotated", null);
}
</script>

<template>
  <div
    class="slot"
    :class="{ filled: !!displayPath, drag: isHover }"
    :data-drop-zone="zoneKey"
    @click="choose"
  >
    <template v-if="displayPath && url && !missing">
      <img :src="url" alt="" @click.stop="emit('preview', displayPath!)" />
      <span class="slot-label">{{ label }}</span>

      <div class="slot-actions">
        <button
          class="slot-btn"
          :class="{ active: hasMark }"
          :title="hasMark ? '重新标注' : '在图上画标记'"
          @click="openAnnotator"
        >
          <Pencil :size="13" />
        </button>
        <button
          v-if="hasMark"
          class="slot-btn"
          title="去掉标注，用原图"
          @click="clearMark"
        >
          <RotateCcw :size="13" />
        </button>
        <button class="slot-btn" title="从备用图库选择" @click="fromLibrary">
          <Library :size="13" />
        </button>
        <button class="slot-btn" title="换成别的图" @click.stop="choose">
          <FolderOpen :size="13" />
        </button>
        <button class="slot-btn" title="清空" @click="clear">
          <X :size="13" />
        </button>
      </div>

      <span v-if="hasMark" class="slot-marked">已标注</span>
      <span v-else-if="!required" class="slot-optional">可选</span>
    </template>

    <div v-else class="slot-empty">
      <ImageIcon :size="20" />
      <div class="slot-empty-title">{{ label }}</div>
      <div class="slot-empty-sub">
        {{ missing ? "文件已丢失" : placeholder || "点击或拖入" }}
      </div>
      <!--
        空槽可选择从本地选择或从备用图库提取
      -->
      <div class="slot-empty-actions" @click.stop>
        <button class="slot-cta" title="从本地磁盘选图" @click="choose">
          <FolderOpen :size="12" />
          <span>本地</span>
        </button>
        <button class="slot-cta" title="从备用图库选图" @click="fromLibrary">
          <Library :size="12" />
          <span>图库</span>
        </button>
      </div>
    </div>
  </div>

  <LibraryPicker v-if="showPicker" @close="showPicker = false" @pick="onPicked" />

  <Annotator
    v-if="showAnnotator && modelValue"
    :src="modelValue"
    :label="label"
    @close="showAnnotator = false"
    @saved="(p) => emit('update:annotated', p)"
    @toast="() => {}"
  />
</template>

<style scoped>
.slot-empty {
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
  padding: 8px 4px;
  pointer-events: none;
  width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.slot-empty-title {
  margin-top: 4px;
  font-weight: 500;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slot-empty-sub {
  font-size: 11px;
  opacity: 0.75;
  margin-top: 2px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slot-empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
  margin-top: 8px;
  width: 100%;
  max-width: 100%;
  padding: 0 4px;
  box-sizing: border-box;
  pointer-events: auto;
}
.slot-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 23px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-3);
  color: var(--text-2);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  max-width: 100%;
  box-sizing: border-box;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.slot-cta span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slot-cta:hover {
  background: var(--accent-soft);
  border-color: var(--accent-border);
  color: var(--text);
}
.slot-btn.active {
  background: var(--accent);
  color: #fff;
}
.slot-marked {
  position: absolute;
  bottom: 6px;
  left: 6px;
  font-size: 10px;
  color: #fff;
  background: var(--accent);
  padding: 1px 7px;
  border-radius: 4px;
  font-weight: 500;
}
</style>

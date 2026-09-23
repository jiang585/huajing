<script setup lang="ts">
/**
 * 功能页外壳：支持 2.0 灵境美学版 (Studio 2.0) 与 1.0 经典工作台双版本无缝切换。
 * 图像模式复用通用表单，视频模式使用专门的首尾帧界面。
 */

import { computed } from "vue";
import ParamForm from "../components/ParamForm.vue";
import ResultPanel from "../components/ResultPanel.vue";
import VideoForm from "../components/VideoForm.vue";
import VideoResult from "../components/VideoResult.vue";
import StudioGenerator from "../components/studio/StudioGenerator.vue";
import StudioVideoWorkspace from "../components/studio/StudioVideoWorkspace.vue";
import { MODES, type ModeId } from "../api/graphs";
import { forms, sendToMode, firstEmptySlot } from "../stores/creator";
import { lastResults } from "../stores/results";
import { openPath } from "../api/tauri";
import { settings } from "../stores/settings";
import { setVideoFirstFrame } from "../stores/video";

const props = defineProps<{ mode: ModeId }>();
const emit = defineEmits<{
  (e: "preview", paths: string[], index: number): void;
  (e: "go", page: string): void;
  (e: "toast", msg: string): void;
}>();

const spec = computed(() => MODES[props.mode]);
const results = computed(() => lastResults[props.mode]);
const isV2 = computed(() => settings.themeEdition !== "v1");

/** 点「编辑 / 2K」时把结果图送进目标页的槽位，并跳过去 */
function sendTo(target: ModeId, path: string) {
  if (target === "video") setVideoFirstFrame(path);
  else sendToMode(target, path, firstEmptySlot(target));
  emit("go", target);
  emit(
    "toast",
    target === "video"
      ? "已设为视频首帧，填写动作描述即可生成"
      : `已放入「${MODES[target].label}」的参考图槽位`,
  );
}

function openOutput() {
  openPath(settings.outputDir).catch(() => undefined);
}
</script>

<template>
  <!-- 2.0 灵境美学版 (Studio 2.0 Mode) -->
  <template v-if="isV2">
    <StudioVideoWorkspace
      v-if="mode === 'video'"
      @preview="emit('preview', [$event], 0)"
      @toast="emit('toast', $event)"
    />
    <StudioGenerator
      v-else
      :mode="mode"
      @preview="(paths, idx) => emit('preview', paths, idx)"
      @go="emit('go', $event)"
      @toast="emit('toast', $event)"
    />
  </template>

  <!-- 1.0 经典工作台版 (Classic Mode) -->
  <template v-else>
    <div v-if="mode === 'video'" class="two-col video-workspace">
      <VideoForm
        @preview="emit('preview', [$event], 0)"
        @toast="emit('toast', $event)"
      />
      <VideoResult @toast="emit('toast', $event)" />
    </div>

    <div v-else class="two-col">
      <ParamForm
        :mode="mode"
        @preview="emit('preview', [ $event ], 0)"
      />

      <div>
        <ResultPanel
          :mode="mode"
          :results="results"
          @preview="(i) => emit('preview', results, i)"
          @send-to="sendTo"
          @open-output="openOutput"
        />

        <div class="card">
          <h3 class="card-title">当前工作流</h3>
          <div class="flex wrap" style="gap: 6px; margin-bottom: 10px">
            <span class="pill accent">{{ spec.label }}</span>
            <span class="pill">{{ spec.tagline }}</span>
            <span v-if="mode === 'txt2img'" class="pill">
              {{ forms.txt2img.model === "qwen" ? "Qwen-Image 2.1" : "Z-Image Turbo" }}
            </span>
            <span v-if="mode === 'multiref2k'" class="pill">含 Z-Image 2K 精修链</span>
          </div>
          <div class="hint">
            输出目录：<span class="mono">{{ settings.outputDir }}\{{ spec.outputSubfolder }}</span>
          </div>
          <div class="hint" style="margin-top: 4px">
            <template v-if="mode === 'txt2img'">
              Qwen 用 EmptyLatentImage 指定尺寸；Z-Image 走 EmptySD3LatentImage + ConditioningZeroOut。
            </template>
            <template v-else-if="mode === 'edit' || mode === 'multiref' || mode === 'multiref2k'">
              latent 由 TextEncodeQwenImage21 的第三个输出给出，尺寸自动跟随参考图 1 的比例。
            </template>
            <template v-else>
              ESRGAN 4 倍放大 → lanczos 缩到 2 倍 → VAE 编码 → 低降噪重采样。
            </template>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
/** 底部日志抽屉：显示 ComfyUI 进程的 stdout/stderr。 */

import { nextTick, ref, watch } from "vue";
import { X, Trash2, ArrowDownToLine } from "lucide-vue-next";
import { logs, showLogs, refreshLogs } from "../stores/backend";

const box = ref<HTMLElement | null>(null);
const follow = ref(true);

watch(
  () => logs.value.length,
  async () => {
    if (!follow.value) return;
    await nextTick();
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  },
);

function onScroll() {
  if (!box.value) return;
  const { scrollTop, scrollHeight, clientHeight } = box.value;
  follow.value = scrollHeight - scrollTop - clientHeight < 40;
}
</script>

<template>
  <div v-if="showLogs" class="log-drawer">
    <div class="modal-head" style="padding: 9px 13px">
      <span class="modal-title" style="font-size: 13px">后端日志</span>
      <span class="pill">{{ logs.length }} 行</span>
      <div style="flex: 1"></div>
      <button class="btn ghost sm" title="刷新" @click="refreshLogs">
        <ArrowDownToLine :size="13" />
      </button>
      <button class="btn ghost sm" title="清空显示" @click="logs = []">
        <Trash2 :size="13" />
      </button>
      <button class="btn ghost sm" @click="showLogs = false">
        <X :size="15" />
      </button>
    </div>
    <div ref="box" class="log-body" @scroll="onScroll">
      <template v-if="logs.length">{{ logs.join("\n") }}</template>
      <span v-else class="muted">暂无日志。启动 ComfyUI 后这里会显示它的输出。</span>
    </div>
  </div>
</template>

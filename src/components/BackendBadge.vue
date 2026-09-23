<script setup lang="ts">
/** 顶栏的后端状态与启停按钮。 */

import { ref } from "vue";
import { Play, Square, Terminal, Loader2, AlertTriangle } from "lucide-vue-next";
import { backend, busy, startBackend, stopBackend, showLogs, logs } from "../stores/backend";

const err = ref("");

async function start() {
  err.value = "";
  try {
    await startBackend();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}

async function stop() {
  err.value = "";
  try {
    await stopBackend();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <div class="flex">
    <span
      class="dot"
      :class="busy.starting || busy.stopping ? 'busy' : backend.running ? 'on' : 'off'"
    />
    <span style="font-size: 12px; color: var(--text-2)">
      <template v-if="busy.starting">正在启动 ComfyUI…</template>
      <template v-else-if="busy.stopping">正在关闭…</template>
      <template v-else-if="backend.running">
        ComfyUI 已连接<template v-if="backend.pid"> · PID {{ backend.pid }}</template>
      </template>
      <template v-else>ComfyUI 未运行</template>
    </span>

    <button
      v-if="!backend.running"
      class="btn sm"
      :disabled="busy.starting"
      @click="start"
    >
      <Loader2 v-if="busy.starting" :size="12" class="spin" />
      <Play v-else :size="12" />
      启动 ComfyUI
    </button>
    <button v-else class="btn sm" :disabled="busy.stopping" @click="stop">
      <Square :size="12" /> 关闭后端
    </button>

    <button
      class="btn ghost sm"
      :class="{ on: showLogs }"
      title="后端日志"
      @click="showLogs = !showLogs"
    >
      <Terminal :size="13" />
      <span v-if="logs.length" class="muted" style="font-size: 11px">{{ logs.length }}</span>
    </button>

    <span v-if="err" class="pill err" :title="err" style="max-width: 260px">
      <AlertTriangle :size="11" />
      <span style="overflow: hidden; text-overflow: ellipsis">{{ err }}</span>
    </span>
    <span v-else-if="!backend.python_ok && !backend.running" class="pill warn">
      找不到 venv\Scripts\python.exe
    </span>
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

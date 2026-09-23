/** ComfyUI 后端连接状态、启停、日志，以及 websocket 进度分发 */

import { reactive, ref } from "vue";
import {
  comfyStatus,
  comfyStart,
  comfyStop,
  comfyLogs,
  comfyWsEnsure,
  comfyClientId,
  onProgress,
  onLog,
  type ComfyStatus,
  type WsMessage,
} from "../api/tauri";
import { settings } from "./settings";

export const backend = reactive<ComfyStatus>({
  running: false,
  managed: false,
  pid: null,
  port: 8188,
  root: settings.comfyRoot,
  python_ok: true,
});

export const busy = reactive({ starting: false, stopping: false });
export const logs = ref<string[]>([]);
export const showLogs = ref(false);

export const clientId = ref("");
let pollTimer: number | null = null;

type ProgressHandler = (m: WsMessage) => void;
const handlers = new Set<ProgressHandler>();

/** 订阅 ComfyUI 的 websocket 消息，返回取消订阅函数 */
export function onComfyMessage(fn: ProgressHandler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export async function refreshStatus() {
  try {
    Object.assign(backend, await comfyStatus());
  } catch {
    backend.running = false;
  }
}

export async function refreshLogs() {
  try {
    logs.value = await comfyLogs();
  } catch {
    /* 后端不可用时保持原样 */
  }
}

let startTask: Promise<ComfyStatus> | null = null;

/**
 * 启动后端。
 *
 * 并发的调用共享同一次启动过程：第二个调用者会等第一个真正完成再拿到已就绪的状态，
 * 而不是被立刻打发回去、在后端还没监听 8188 时继续提交任务（结果是
 * 「ComfyUI 尚未运行」这种自相矛盾的报错）。失败时同样把原因传给所有调用者。
 */
export function startBackend(): Promise<ComfyStatus> {
  if (startTask) return startTask;
  busy.starting = true;
  startTask = (async () => {
    const status = await comfyStart();
    Object.assign(backend, status);
    await ensureProgressChannel();
    return status;
  })();
  // 失败也要清掉共享引用，否则后面每次调用都会拿到同一个已经失败的 Promise
  startTask = startTask.finally(() => {
    startTask = null;
    busy.starting = false;
  });
  return startTask;
}

export async function stopBackend() {
  if (busy.stopping) return;
  busy.stopping = true;
  try {
    await comfyStop();
    await refreshStatus();
  } finally {
    busy.stopping = false;
  }
}

export async function ensureProgressChannel() {
  try {
    await comfyWsEnsure();
    if (!clientId.value) clientId.value = await comfyClientId();
  } catch {
    /* 后端没起来时静默失败，下次连上会重试 */
  }
}

/** 启动时调用一次：挂上事件、拿 client id、开始轮询状态 */
export async function initBackend() {
  await onProgress((m) => {
    handlers.forEach((h) => h(m));
  });
  await onLog((line) => {
    logs.value = [...logs.value.slice(-399), line];
  });
  await refreshStatus();
  if (backend.running) await ensureProgressChannel();

  if (pollTimer !== null) window.clearInterval(pollTimer);
  // 只做轻量状态同步；生成进度走 websocket，不靠轮询
  pollTimer = window.setInterval(refreshStatus, 5000);
}

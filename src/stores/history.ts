/** 生成历史：每次任务的参数与产出，持久化到 history.json */

import { ref, computed } from "vue";
import { storeLoad, storeSave, pathExists } from "../api/tauri";
import type { ModeId } from "../api/graphs";
import { settings } from "./settings";

export interface HistoryEntry {
  id: string;
  mode: ModeId;
  prompt: string;
  negative: string;
  /** 尺寸、步数、CFG、种子、模型等，用于「再来一次」精确复现 */
  params: Record<string, unknown>;
  /** 落盘后的绝对路径；video 模式保存视频，其余模式保存图片。 */
  images: string[];
  createdAt: number;
  durationMs: number;
  status: "done" | "failed" | "canceled";
  error?: string;
}

export const history = ref<HistoryEntry[]>([]);
export const historyMode = ref<ModeId | "all">("all");
export const historyQuery = ref("");

// 同一份 JSON 的读写必须按顺序完成，否则较慢的旧快照会覆盖刚完成的任务。
let loaded = false;
let operations: Promise<unknown> = Promise.resolve();
function ordered<T>(action: () => Promise<T>): Promise<T> {
  const next = operations.then(action, action);
  operations = next.catch(() => undefined);
  return next;
}

async function ensureLoaded() {
  if (loaded) return;
  const saved = await storeLoad<HistoryEntry[]>("history");
  history.value = Array.isArray(saved) ? saved : [];
  loaded = true;
}

async function write(entries: HistoryEntry[]) {
  // invoke 开始前取快照，避免后续的响应式修改改变待写数据。
  await storeSave("history", JSON.parse(JSON.stringify(entries)));
}

export const filteredHistory = computed(() => {
  const q = historyQuery.value.trim().toLowerCase();
  return history.value.filter((e) => {
    if (historyMode.value !== "all" && e.mode !== historyMode.value) return false;
    if (!q) return true;
    return e.prompt.toLowerCase().includes(q);
  });
});

export async function loadHistory() {
  await ordered(ensureLoaded);
}

/** 供隐私空间在移入/移出后同步落盘（历史被外部改过） */
export async function saveHistory() {
  await ordered(async () => { await ensureLoaded(); await write(history.value); });
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function pushHistory(entry: HistoryEntry) {
  await ordered(async () => {
    await ensureLoaded();
    const limit = Math.max(1, Math.floor(settings.historyLimit || 500));
    history.value = [entry, ...history.value.filter((e) => e.id !== entry.id)].slice(0, limit);
    // 保存失败仍保留本次生成结果，供用户定位文件或重试保存。
    await write(history.value);
  });
}

export async function removeHistory(id: string, alsoDeleteFiles = false) {
  await ordered(async () => {
  await ensureLoaded();
  const entry = history.value.find((e) => e.id === id);
  if (!entry) return;
  if (alsoDeleteFiles) {
    const { deleteFile } = await import("../api/tauri");
    const failed: string[] = [];
    for (const p of entry.images) {
      try {
        await deleteFile(p);
      } catch (e) {
        failed.push(`${p}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 删除失败时保留记录，用户仍能定位文件、查看原因并重试。
    if (failed.length) throw new Error(`有 ${failed.length} 个文件未能删除，记录已保留：\n${failed.join("\n")}`);
  }
  const next = history.value.filter((e) => e.id !== id);
  await write(next);
  history.value = next;
  });
}

export async function clearHistory() {
  await ordered(async () => {
    await ensureLoaded();
    await write([]);
    history.value = [];
  });
}

/** 移入隐私空间后，通过同一条保存队列移除原文件引用。 */
export async function removeHistoryPaths(paths: string[]) {
  await ordered(async () => {
    await ensureLoaded();
    const moved = new Set(paths);
    history.value = history.value.map((entry) => ({
      ...entry, images: entry.images.filter((path) => !moved.has(path)),
    })).filter((entry) => entry.images.length > 0 || entry.status !== "done");
    await write(history.value);
  });
}

/** 清掉那些文件已经不在磁盘上的记录 */
export async function pruneMissingHistory(): Promise<number> {
  return ordered(async () => {
  await ensureLoaded();
  const missingIds = new Set<string>();
  const snapshot = [...history.value];
  for (const e of snapshot) {
    let ok = false;
    for (const p of e.images) {
      if (await pathExists(p)) {
        ok = true;
        break;
      }
    }
    // 失败记录本来就没有文件，保留
    if (!ok && e.status === "done") missingIds.add(e.id);
  }
  if (missingIds.size > 0) {
    // 检查磁盘期间可能有新任务完成；只去掉这次确认失效的记录。
    const next = history.value.filter((e) => !missingIds.has(e.id));
    await write(next);
    history.value = next;
  }
  return missingIds.size;
  });
}

/** 历史里所有出现过的模式，用于筛选栏 */
export const historyModes = computed(() => {
  const set = new Set<ModeId>();
  history.value.forEach((e) => set.add(e.mode));
  return [...set];
});

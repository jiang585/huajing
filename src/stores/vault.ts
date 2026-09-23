/**
 * 隐私空间。
 *
 * 三态：
 * - 未启用：侧栏显示入口，点进去引导设置密码；
 * - 已启用但锁定：入口**从侧栏消失**，要在设置页连点版本号 5 下唤出密码框；
 * - 已解锁：入口恢复显示，可浏览、移入移出、下载、删除。锁只在本次会话有效。
 *
 * 移入是"真移入"：加密写入后原文件会被删除，历史记录里的对应条目也一并清掉，
 * 所以磁盘上不留明文，历史里也查不到。移出则解密回输出目录并重建历史记录。
 */

import { computed, reactive, ref } from "vue";
import {
  vaultStatus,
  vaultEnable,
  vaultUnlock,
  vaultLock,
  vaultList,
  vaultImport,
  vaultExport,
  vaultDelete,
  vaultThumb,
  vaultPreview,
  vaultSaveAs,
  vaultChangePassword,
  vaultDisable,
  buildOutputPath,
  copyFile,
  pathExists,
  type VaultStatus,
  type VaultEntry,
  type VaultImportItem,
} from "../api/tauri";
import { pushHistory, newId, removeHistoryPaths } from "./history";
import { settings } from "./settings";
import type { ModeId } from "../api/graphs";

export const vault = reactive<VaultStatus>({
  enabled: false,
  unlocked: false,
  count: null,
  hint: null,
  iterations: 0,
});

export const vaultEntries = ref<VaultEntry[]>([]);
/** id -> 缩略图 data URL，只在内存里 */
export const vaultThumbs = ref<Record<string, string>>({});
export const vaultBusy = ref(false);
export const vaultSelected = ref<Set<string>>(new Set());
/** 解密失败的条目。记下来界面才能给出明确状态，而不是一直转圈 */
export const vaultThumbFailed = ref<Set<string>>(new Set());

/** 侧栏入口什么时候显示：未启用（引导）或已解锁 */
export const vaultVisible = computed(() => !vault.enabled || vault.unlocked);

export async function refreshVaultStatus() {
  try {
    Object.assign(vault, await vaultStatus());
  } catch {
    /* 拿不到就保持原状 */
  }
}

export async function enableVault(password: string, hint: string) {
  const s = await vaultEnable(password, hint);
  Object.assign(vault, s);
  await refreshVaultEntries();
}

export async function unlockVault(password: string): Promise<boolean> {
  const ok = await vaultUnlock(password);
  await refreshVaultStatus();
  if (ok) await refreshVaultEntries();
  return ok;
}

export async function lockVault() {
  await vaultLock();
  vaultEntries.value = [];
  vaultThumbs.value = {};
  vaultThumbFailed.value = new Set();
  vaultSelected.value = new Set();
  await refreshVaultStatus();
}

export async function refreshVaultEntries() {
  if (!vault.unlocked) {
    vaultEntries.value = [];
    return;
  }
  vaultEntries.value = await vaultList();
  await refreshVaultStatus();
}

export async function loadThumb(id: string) {
  if (vaultThumbs.value[id] || vaultThumbFailed.value.has(id)) return;
  try {
    const url = await vaultThumb(id);
    vaultThumbs.value = { ...vaultThumbs.value, [id]: url };
  } catch (e) {
    // 记下失败：不然界面会永远停在加载动画上，看起来像卡死了
    console.error(`[画境] 解密缩略图失败（${id}）：`, e);
    vaultThumbFailed.value = new Set(vaultThumbFailed.value).add(id);
  }
}

export async function loadAllThumbs() {
  // 并发解密会同时读多个大文件，分批来更稳
  const batch = 4;
  const list = vaultEntries.value.map((e) => e.id);
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(loadThumb));
  }
}

export async function previewVaultImage(id: string): Promise<string> {
  return vaultPreview(id);
}

export async function saveVaultImageAs(id: string): Promise<string | null> {
  const { pickDirectory } = await import("../api/tauri");
  const dir = await pickDirectory("另存到哪个文件夹");
  if (!dir) return null;
  const entry = vaultEntries.value.find((e) => e.id === id);
  const ext = entry?.name.split(".").pop() ?? "png";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return vaultSaveAs(id, `${dir}\\${stamp}.${ext}`);
}

// ---------------------------------------------------------------- 移入 / 移出

export interface MoveInRequest {
  path: string;
  from: string;
  prompt: string;
  params: Record<string, unknown>;
}

/**
 * 移入隐私空间。Rust 侧负责加密 + 删除原文件，这里负责同步历史记录：
 * 把被移走的图片从历史条目里摘掉，条目空了就整条删除。
 */
export async function moveIntoVault(reqs: MoveInRequest[]): Promise<number> {
  if (!vault.unlocked) throw new Error("隐私空间已锁定");
  if (reqs.length === 0) return 0;

  vaultBusy.value = true;
  try {
    const items: VaultImportItem[] = reqs.map((r) => ({
      path: r.path,
      from: r.from,
      prompt: r.prompt,
      params: r.params,
    }));
    const added = await vaultImport(items);

    // Rust 侧只搬走真实存在的文件，不存在的会被跳过；按「原文件是否还在」判断哪些真的
    // 搬进去了，免得把没搬成功的条目也从历史里抹掉。
    const moved: string[] = [];
    for (const r of reqs) {
      if (!(await pathExists(r.path))) moved.push(r.path);
    }
    // 必须走 history store 的串行队列：任务完成时的 pushHistory 可能正在读改同一份 JSON，
    // 这里直接改 history.value 再落盘，会把刚写进去的条目盖掉。
    if (moved.length > 0) await removeHistoryPaths(moved);

    await refreshVaultEntries();
    await loadAllThumbs();
    return added.length;
  } finally {
    vaultBusy.value = false;
  }
}

/**
 * 移出：解密到输出目录，并重建历史记录（这样移出后又能查到了）。
 * Rust 侧把落盘路径一并返回，所以这里不需要猜文件名。
 */
export async function moveOutOfVault(ids: string[]): Promise<string[]> {
  if (!vault.unlocked) throw new Error("隐私空间已锁定");
  if (ids.length === 0) return [];

  vaultBusy.value = true;
  try {
    const destDir = `${settings.outputDir}\\隐私空间移出`;
    const moved = await vaultExport(ids, destDir);
    const savedPaths: string[] = [];

    for (const m of moved) {
      savedPaths.push(m.path);
      await pushHistory({
        id: newId(),
        mode: (m.entry.from || "txt2img") as ModeId,
        prompt: m.entry.prompt,
        negative: "",
        params: m.entry.params ?? {},
        images: [m.path],
        createdAt: Date.now(),
        durationMs: 0,
        status: "done",
      });
    }

    await refreshVaultEntries();
    await loadAllThumbs();
    return savedPaths;
  } finally {
    vaultBusy.value = false;
  }
}

export async function deleteFromVault(ids: string[]): Promise<number> {
  if (!vault.unlocked) throw new Error("隐私空间已锁定");
  vaultBusy.value = true;
  try {
    const n = await vaultDelete(ids);
    vaultSelected.value = new Set();
    await refreshVaultEntries();
    return n;
  } finally {
    vaultBusy.value = false;
  }
}

export async function changeVaultPassword(oldPw: string, newPw: string) {
  await vaultChangePassword(oldPw, newPw);
}

export async function disableVault(password: string) {
  await vaultDisable(password);
  vaultEntries.value = [];
  vaultThumbs.value = {};
  await refreshVaultStatus();
}

// ---------------------------------------------------------------- 选择

export function toggleSelect(id: string) {
  const s = new Set(vaultSelected.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  vaultSelected.value = s;
}

export function selectAll() {
  vaultSelected.value = new Set(vaultEntries.value.map((e) => e.id));
}

export function clearSelection() {
  vaultSelected.value = new Set();
}

export function totalVaultBytes(): number {
  return vaultEntries.value.reduce((s, e) => s + e.bytes, 0);
}

export { buildOutputPath, copyFile };

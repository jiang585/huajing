/**
 * 备用图库：把外部图片和生成结果收进一个可复用的小仓库，任何页面的图槽都能一键插入。
 *
 * 设计取舍：图库只存「路径索引」，不复制文件。
 * - 生成结果本来就已经落盘到输出目录，再复制一份纯属浪费磁盘；
 * - 外部导入的图会复制到 `{输出目录}/_导入/`，保证不会被随手清理掉；
 * - 文件被外部移动/删除时，条目会标记为失效并给出重新添加的入口，而不是静默丢失。
 */

import { ref, computed } from "vue";
import {
  storeLoad,
  storeSave,
  imageInfo,
  imageInfos,
  copyFile,
  deleteFile,
  pathExists,
  type ImageInfo,
} from "../api/tauri";
import { settings } from "./settings";

export interface LibraryEntry {
  id: string;
  /** 图片绝对路径 */
  path: string;
  /** 展示名 */
  name: string;
  /** 来源：生成结果 / 外部导入 */
  source: "generated" | "imported";
  addedAt: number;
  width: number;
  height: number;
  /** 用户自定义标签，便于检索 */
  tags: string[];
}

export const library = ref<LibraryEntry[]>([]);
export const libraryInfo = ref<Record<string, ImageInfo>>({});
export const libraryLoading = ref(false);
export const libraryFilter = ref("");

export const importedDir = computed(() => `${settings.outputDir}\\_导入`);

export const filteredLibrary = computed(() => {
  const q = libraryFilter.value.trim().toLowerCase();
  if (!q) return library.value;
  return library.value.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
});

export async function loadLibrary() {
  const saved = await storeLoad<LibraryEntry[]>("library");
  library.value = saved ?? [];
  await refreshLibraryInfo();
}

async function refreshLibraryInfo() {
  if (library.value.length === 0) {
    libraryInfo.value = {};
    return;
  }
  libraryLoading.value = true;
  try {
    const infos = await imageInfos(library.value.map((e) => e.path));
    const map: Record<string, ImageInfo> = {};
    infos.forEach((i) => (map[i.path] = i));
    libraryInfo.value = map;
  } catch (e) {
    // 取尺寸/缩略图失败不该让图库停摆 —— 界面上的 <img> 会用原图路径兜底
    console.error("[画境] 读取图库图片信息失败：", e);
  } finally {
    libraryLoading.value = false;
  }
}

async function persist() {
  await storeSave("library", library.value);
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把一个已经存在的文件加进图库（不复制） */
export async function addExisting(
  path: string,
  source: LibraryEntry["source"] = "generated",
): Promise<LibraryEntry | null> {
  if (library.value.some((e) => e.path === path)) return null;
  const info = await imageInfo(path);
  const entry: LibraryEntry = {
    id: newId(),
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    source,
    addedAt: Date.now(),
    width: info.width,
    height: info.height,
    tags: [],
  };
  library.value = [entry, ...library.value];
  libraryInfo.value = { ...libraryInfo.value, [path]: info };
  await persist();
  return entry;
}

/** 批量加入（生成完一键收藏整组结果） */
export async function addMany(paths: string[], source: LibraryEntry["source"] = "generated") {
  for (const p of paths) await addExisting(p, source);
}

/** 导入外部图片：复制到输出目录下的 _导入，再登记 */
export async function importFiles(paths: string[]): Promise<number> {
  let n = 0;
  const dir = importedDir.value;
  for (const p of paths) {
    try {
      const copied = await copyFile(p, dir);
      const added = await addExisting(copied, "imported");
      if (added) n++;
    } catch {
      /* 单张失败不影响其它 */
    }
  }
  return n;
}

export async function removeEntry(id: string, alsoDeleteFile = false) {
  const entry = library.value.find((e) => e.id === id);
  if (!entry) return;
  library.value = library.value.filter((e) => e.id !== id);
  if (alsoDeleteFile) {
    try {
      await deleteFile(entry.path);
    } catch {
      /* 文件可能已经不在了 */
    }
  }
  await persist();
}

export async function updateTags(id: string, tags: string[]) {
  const entry = library.value.find((e) => e.id === id);
  if (!entry) return;
  entry.tags = tags;
  await persist();
}

/** 检查失效条目（文件被移走/删掉了） */
export async function pruneMissing(): Promise<number> {
  const alive: LibraryEntry[] = [];
  let removed = 0;
  for (const e of library.value) {
    if (await pathExists(e.path)) alive.push(e);
    else removed++;
  }
  if (removed > 0) {
    library.value = alive;
    await persist();
  }
  return removed;
}

export function isMissing(entry: LibraryEntry): boolean {
  const info = libraryInfo.value[entry.path];
  return info ? !info.exists : false;
}

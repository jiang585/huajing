<script setup lang="ts">
/** 备用图库管理页：导入、检索、打标签、清理。 */

import { computed, onMounted, ref } from "vue";
import {
  Search,
  Download,
  Trash2,
  FolderOpen,
  Eraser,
  Library as LibIcon,
  Tag,
} from "lucide-vue-next";
import {
  library,
  libraryInfo,
  libraryFilter,
  filteredLibrary,
  loadLibrary,
  importFiles,
  removeEntry,
  pruneMissing,
  updateTags,
  isMissing,
  importedDir,
  type LibraryEntry,
} from "../stores/library";
import { thumbUrl, pickImages, revealPath, openPath } from "../api/tauri";

const emit = defineEmits<{
  (e: "preview", paths: string[], index: number): void;
  (e: "toast", msg: string): void;
}>();

const busy = ref(false);
const tagFor = ref<string | null>(null);
const tagText = ref("");

onMounted(async () => {
  busy.value = true;
  try {
    await loadLibrary();
  } finally {
    busy.value = false;
  }
});

async function doImport() {
  const paths = await pickImages();
  if (paths.length === 0) return;
  busy.value = true;
  try {
    const n = await importFiles(paths);
    emit("toast", `导入了 ${n} 张图到 ${importedDir.value}`);
  } finally {
    busy.value = false;
  }
}

async function del(e: LibraryEntry) {
  await removeEntry(e.id, false);
  emit("toast", "已从图库移除（文件仍在原位置）");
}

async function delWithFile(e: LibraryEntry) {
  await removeEntry(e.id, true);
  emit("toast", "已从图库移除并删除文件");
}

async function prune() {
  const n = await pruneMissing();
  emit("toast", n > 0 ? `移除了 ${n} 个失效条目` : "没有失效条目");
}

function openTag(e: LibraryEntry) {
  tagFor.value = e.id;
  tagText.value = e.tags.join(", ");
}

async function saveTags() {
  if (!tagFor.value) return;
  const tags = tagText.value
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  await updateTags(tagFor.value, tags);
  tagFor.value = null;
  emit("toast", "标签已保存");
}

const missingCount = computed(() => library.value.filter(isMissing).length);
const paths = computed(() => filteredLibrary.value.map((e) => e.path));
</script>

<template>
  <div>
    <div class="flex wrap" style="margin-bottom: 14px">
      <div style="position: relative; width: 240px">
        <Search :size="13" style="position: absolute; left: 9px; top: 9px; color: var(--text-3)" />
        <input
          v-model="libraryFilter"
          class="input"
          style="padding-left: 28px; height: 32px"
          placeholder="搜索名称或标签"
        />
      </div>
      <div style="flex: 1"></div>
      <span class="pill">{{ library.length }} 张</span>
      <span v-if="missingCount" class="pill warn">{{ missingCount }} 张失效</span>
      <button class="btn sm" @click="prune"><Eraser :size="12" /> 清理失效</button>
      <button class="btn sm" @click="openPath(importedDir)"><FolderOpen :size="12" /> 打开图库目录</button>
      <button class="btn primary sm" :disabled="busy" @click="doImport">
        <Download :size="12" /> 导入图片
      </button>
    </div>

    <div class="alert info" style="margin-bottom: 14px">
      <LibIcon :size="14" />
      <div>
        图库只记录文件位置，不重复复制 —— 生成结果本来就已经在输出目录里了。
        外部导入的图会复制到
        <span class="mono">{{ importedDir }}</span>
        以保证不被随手清理。任何页面的图槽都能一键从图库里取图。
      </div>
    </div>

    <div v-if="busy" class="empty">正在读取图库…</div>

    <div v-else-if="filteredLibrary.length === 0" class="empty">
      <LibIcon :size="36" />
      <div class="empty-title">图库还是空的</div>
      <div class="empty-sub">
        把常用的人物图、服装图、场景图导进来，做多参考图时就不用每次翻文件夹了。<br />
        生成结果也可以在结果面板或预览里点「加入图库」。
      </div>
    </div>

    <div v-else class="result-grid">
      <div
        v-for="(e, i) in filteredLibrary"
        :key="e.id"
        class="result-item"
        :style="isMissing(e) ? 'opacity:.42' : ''"
        @click="!isMissing(e) && emit('preview', paths, i)"
      >
        <img v-if="!isMissing(e)" :src="thumbUrl(libraryInfo[e.path], e.path)" alt="" loading="lazy" />
        <div v-else class="empty" style="padding: 24px 10px; font-size: 11px">
          文件已丢失<br />{{ e.path }}
        </div>
        <span class="dims">
          {{ libraryInfo[e.path]?.width || "?" }}×{{ libraryInfo[e.path]?.height || "?" }}
        </span>
        <div class="overlay" @click.stop>
          <button class="btn ghost sm" title="打标签" @click="openTag(e)"><Tag :size="12" /></button>
          <button class="btn ghost sm" title="定位文件" @click="revealPath(e.path)">
            <FolderOpen :size="12" />
          </button>
          <button class="btn ghost sm" title="从图库移除" @click="del(e)">
            <Trash2 :size="12" />
          </button>
          <button
            v-if="e.source === 'imported'"
            class="btn ghost sm danger"
            title="移除并删除文件"
            @click="delWithFile(e)"
          >
            <Trash2 :size="12" />
          </button>
        </div>
        <div v-if="e.tags.length" class="lib-tags">
          <span v-for="t in e.tags" :key="t" class="pill accent">{{ t }}</span>
        </div>
      </div>
    </div>

    <div v-if="tagFor" class="overlay-mask" @click.self="tagFor = null">
      <div class="modal" style="width: 420px">
        <div class="modal-head"><span class="modal-title">编辑标签</span></div>
        <div class="modal-body">
          <input
            v-model="tagText"
            class="input"
            placeholder="用逗号或空格分隔，例如：人物 旗袍 参考"
            @keyup.enter="saveTags"
          />
          <div class="hint">标签会参与图库搜索，建议用短词。</div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="tagFor = null">取消</button>
          <button class="btn primary" @click="saveTags">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lib-tags {
  position: absolute;
  top: 6px;
  left: 6px;
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
  max-width: 70%;
}
.lib-tags .pill {
  background: rgba(0, 0, 0, 0.68);
  color: #dcd4ff;
  backdrop-filter: blur(4px);
}
</style>

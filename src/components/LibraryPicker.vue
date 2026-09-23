<script setup lang="ts">
/** 从备用图库里挑一张图插到当前槽位。 */

import { computed, onMounted, ref } from "vue";
import { Search, X, Library, RefreshCw } from "lucide-vue-next";
import { library, libraryInfo, libraryFilter, filteredLibrary, isMissing, loadLibrary, importFiles } from "../stores/library";
import { thumbUrl, pickImages, formatBytes } from "../api/tauri";

const emit = defineEmits<{ (e: "close"): void; (e: "pick", path: string): void }>();

const importing = ref(false);
const busy = ref(false);

const items = computed(() => filteredLibrary.value);

onMounted(async () => {
  if (library.value.length === 0) {
    busy.value = true;
    try {
      await loadLibrary();
    } finally {
      busy.value = false;
    }
  }
});

async function doImport() {
  const paths = await pickImages();
  if (paths.length === 0) return;
  importing.value = true;
  try {
    await importFiles(paths);
  } finally {
    importing.value = false;
  }
}

async function refresh() {
  busy.value = true;
  try {
    await loadLibrary();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="overlay-mask" @click.self="emit('close')">
    <div class="modal" style="width: 860px; height: 78vh">
      <div class="modal-head">
        <Library :size="16" />
        <span class="modal-title">备用图库</span>
        <span class="pill">{{ library.length }} 张</span>
        <div style="flex: 1"></div>
        <div style="position: relative; width: 200px">
          <Search
            :size="13"
            style="position: absolute; left: 9px; top: 9px; color: var(--text-3)"
          />
          <input
            v-model="libraryFilter"
            class="input"
            style="padding-left: 28px; height: 30px"
            placeholder="搜索名称或标签"
          />
        </div>
        <button class="btn sm" :disabled="importing" @click="doImport">
          <RefreshCw v-if="importing" :size="12" class="spin" />
          导入图片
        </button>
        <button class="btn ghost sm" @click="refresh">
          <RefreshCw :size="12" />
        </button>
        <button class="btn ghost sm" @click="emit('close')">
          <X :size="14" />
        </button>
      </div>

      <div class="modal-body">
        <div v-if="busy" class="empty">正在读取图库…</div>

        <div v-else-if="items.length === 0" class="empty">
          <Library :size="34" />
          <div class="empty-title">图库还是空的</div>
          <div class="empty-sub">
            点右上角「导入图片」把常用的人物图、服装图、场景图收进来，<br />
            以后在任何页面的图槽里都能一键插入。生成结果也可以直接「加入图库」。
          </div>
        </div>

        <div v-else class="result-grid">
          <div
            v-for="e in items"
            :key="e.id"
            class="result-item"
            :style="isMissing(e) ? 'opacity:.4' : ''"
            :title="e.path"
            @click="!isMissing(e) && emit('pick', e.path)"
          >
            <img v-if="!isMissing(e)" :src="thumbUrl(libraryInfo[e.path], e.path)" alt="" loading="lazy" />
            <div v-else class="empty" style="padding: 20px; font-size: 11px">文件已丢失</div>
            <span class="dims">
              {{ libraryInfo[e.path]?.width || "?" }}×{{ libraryInfo[e.path]?.height || "?" }}
            </span>
            <div class="overlay">
              <span class="pill" style="background: rgba(0,0,0,.6); color: #fff">
                {{ formatBytes(libraryInfo[e.path]?.bytes ?? 0) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <span class="muted" style="font-size: 12px; margin-right: auto">
          点一张图即可插入到当前槽位
        </span>
        <button class="btn" @click="emit('close')">取消</button>
      </div>
    </div>
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

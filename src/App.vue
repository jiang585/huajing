<script setup lang="ts">
/** 应用外壳：侧边导航、顶栏状态、页面切换，以及全局的预览/提示/日志。 */

import { computed, onMounted, ref, watch } from "vue";
import {
  Image,
  Wand2,
  Layers,
  Sparkles,
  Maximize2,
  Clapperboard,
  Library as LibIcon,
  History as HistoryIcon,
  Settings as SettingsIcon,
  CheckCircle2,
  Lock,
  ShieldPlus,
} from "lucide-vue-next";
import BackendBadge from "./components/BackendBadge.vue";
import Logo from "./components/Logo.vue";
import LogDrawer from "./components/LogDrawer.vue";
import Lightbox from "./components/Lightbox.vue";
import VaultUnlock from "./components/VaultUnlock.vue";
import GeneratorView from "./views/GeneratorView.vue";
import HistoryView from "./views/HistoryView.vue";
import LibraryView from "./views/LibraryView.vue";
import SettingsView from "./views/SettingsView.vue";
import VaultView from "./views/VaultView.vue";
import { MODES, MODE_ORDER, type ModeId } from "./api/graphs";
import { loadSettings, settings, saveSettings } from "./stores/settings";
import { initBackend } from "./stores/backend";
import { loadLibrary, library } from "./stores/library";
import { loadHistory, history } from "./stores/history";
import { vault, vaultVisible, refreshVaultStatus, moveIntoVault } from "./stores/vault";
import { loadForms, watchForms } from "./stores/creator";
import { initVideoStore } from "./stores/video";
import { initDropRouting, dragging } from "./composables/useDropZone";

type Page = ModeId | "library" | "history" | "settings" | "vault";

const VALID_PAGES: Page[] = [
  ...MODE_ORDER,
  "library",
  "history",
  "settings",
  "vault",
] as Page[];

const page = ref<Page>("txt2img");
const toast = ref("");
let toastTimer: number | null = null;

/**
 * 创作界面什么时候开放。
 *
 * 只等 `settingsReady` 是不够的：历史、表单、视频表单都还在异步恢复，
 * 用户可以在恢复完成前就开始打字，随后 `loadForms()` 把刚输入的内容覆盖掉。
 * 所以等关键恢复都结束（不管成功还是失败）再放行 —— 非关键的初始化继续在后台跑。
 */
const appReady = ref(false);

const lightbox = ref<{ paths: string[]; index: number } | null>(null);
const showUnlock = ref(false);
const movingToVault = ref(false);

const NAV_ICONS: Record<ModeId, unknown> = {
  txt2img: Image,
  edit: Wand2,
  multiref: Layers,
  multiref2k: Sparkles,
  upscale: Maximize2,
  video: Clapperboard,
};

const title = computed(() => {
  if (page.value === "library") return "备用图库";
  if (page.value === "history") return "历史记录";
  if (page.value === "settings") return "设置";
  if (page.value === "vault") return "隐私空间";
  return MODES[page.value as ModeId].label;
});

const tagline = computed(() => {
  if (page.value === "library") return "收着常用的参考图，随时一键插入";
  if (page.value === "history") return "生成过的任务都在这里，可复现参数";
  if (page.value === "settings") return "目录、默认参数、DeepSeek 与模型自检";
  if (page.value === "vault") return "端到端 AES-256 加密保护，解密仅在内存运行时执行";
  return MODES[page.value as ModeId].tagline;
});

const isV2 = computed(() => settings.themeEdition !== "v1");

function setEdition(v: "v2" | "v1") {
  settings.themeEdition = v;
  saveSettings().catch(() => undefined);
  showToast(v === "v2" ? "已切换至 2.0 灵境美学版" : "已切换至 1.0 经典工作台");
}

function showToast(msg: string) {
  toast.value = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ""), 2600);
}

function go(p: string) {
  page.value = p as Page;
}

/** 判断当前页是不是创作模式之一 */
function isMode(p: Page): boolean {
  return (MODE_ORDER as string[]).includes(p);
}

function openPreview(paths: string[], index: number) {
  lightbox.value = { paths, index };
}

function onDeleted(path: string) {
  // 从所有正在预览的列表里剔掉，避免继续显示已删除的文件
  if (!lightbox.value) return;
  const paths = lightbox.value.paths.filter((p) => p !== path);
  if (paths.length === 0) {
    lightbox.value = null;
    return;
  }
  lightbox.value = {
    paths,
    index: Math.min(lightbox.value.index, paths.length - 1),
  };
}

/**
 * 把图片移入隐私空间。
 * 来源可能是历史记录、备用图库或预览窗，所以这里从历史里取生成参数，
 * 取不到就用空参数 —— 移出时能恢复出历史条目即可。
 */
async function moveToVault(paths: string[]) {
  if (!vault.unlocked) {
    // 正常情况下走不到这里：所有入口都按 vaultVisible 隐藏了。
    // 真到了这里也不能提"隐私空间"四个字，只静默弹出解锁框。
    showUnlock.value = true;
    return;
  }
  if (paths.length === 0) return;
  movingToVault.value = true;
  try {
    const reqs = paths.map((p) => {
      const src = history.value.find((e) => e.images.includes(p));
      return {
        path: p,
        from: src?.mode ?? "txt2img",
        prompt: src?.prompt ?? "",
        params: (src?.params ?? {}) as Record<string, unknown>,
      };
    });
    const n = await moveIntoVault(reqs);
    lightbox.value = null;
    showToast(`已安全归档 ${n} 项资产至隐私空间，原始文件与历史记录已同步抹除`);
  } catch (e) {
    showToast(`归档失败：${e instanceof Error ? e.message : e}`);
  } finally {
    movingToVault.value = false;
  }
}

function onVaultUnlocked() {
  page.value = "vault";
}

/**
 * 初始化。
 *
 * 每一步各自兜住异常：这些步骤之间没有依赖关系，任何一步挂掉都不该拖累其它步骤。
 * （之前是串行 await 且不捕获 —— 拖拽落图初始化一失败，排在它后面的后端状态检测
 * 就再也没跑，界面永远显示「ComfyUI 未运行」，而且看不出原因。）
 */
async function safeInit(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[画境] 初始化「${label}」失败：`, e);
  }
}

onMounted(async () => {
  await loadSettings();
  // 回到上次停留的页面。隐私空间没解锁就不回去，免得看到锁屏。
  const last = settings.lastPage as Page;
  if (VALID_PAGES.includes(last) && last !== "vault") {
    page.value = last;
  }

  // 后端状态最要紧，先起（不影响编辑，但起来后各页的检测才有得用）
  await safeInit("后端连接", initBackend);

  // 关键恢复：历史、图库、表单（提示词、参考图、标注）。都跑完才开放创作界面。
  await safeInit("图库与历史", () => Promise.all([loadLibrary(), loadHistory()]));
  await safeInit("表单恢复", async () => {
    await Promise.all([loadForms(), initVideoStore()]);
    watchForms();
  });
  appReady.value = true;

  // 非关键：隐私空间状态与拖拽落图，失败也只是少个便利功能
  await safeInit("隐私空间状态", refreshVaultStatus);
  await safeInit("拖拽落图", initDropRouting);
});

watch(page, (p) => {
  settings.lastPage = p;
  saveSettings().catch(() => undefined);
});
</script>

<template>
  <div class="shell" :class="{ 'studio-shell': isV2 }">
    <aside class="sidebar" :class="{ 'studio-sidebar': isV2 }">
      <div :class="isV2 ? 'studio-brand-wrap' : 'brand'">
        <div :class="{ 'studio-logo-glow': isV2 }">
          <Logo :size="30" />
        </div>
        <div :class="{ 'studio-brand-text': isV2 }">
          <div :class="isV2 ? 'studio-brand-title' : 'brand-name'">
            画境
            <span v-if="isV2" class="studio-badge-v2">2.0</span>
          </div>
          <div :class="isV2 ? 'studio-brand-sub' : 'brand-sub'">
            {{ isV2 ? "AI 灵境影像工坊" : "AI 影像工作台" }}
          </div>
        </div>
      </div>

      <nav :class="isV2 ? 'studio-nav' : 'nav'">
        <div :class="isV2 ? 'studio-nav-group-title' : 'nav-group'">创作工坊</div>
        <div
          v-for="m in MODE_ORDER"
          :key="m"
          :class="[isV2 ? 'studio-nav-item' : 'nav-item', { active: page === m }]"
          @click="page = m"
        >
          <component :is="NAV_ICONS[m]" :size="15" />
          <span>{{ MODES[m].label }}</span>
        </div>

        <div :class="isV2 ? 'studio-nav-group-title' : 'nav-group'">媒体资产</div>
        <div
          :class="[isV2 ? 'studio-nav-item' : 'nav-item', { active: page === 'library' }]"
          @click="page = 'library'"
        >
          <LibIcon :size="15" />
          <span>备用图库</span>
          <span v-if="library.length" :class="isV2 ? 'studio-nav-badge' : 'badge'">{{ library.length }}</span>
        </div>
        <div
          :class="[isV2 ? 'studio-nav-item' : 'nav-item', { active: page === 'history' }]"
          @click="page = 'history'"
        >
          <HistoryIcon :size="15" />
          <span>生成历史</span>
          <span v-if="history.length" :class="isV2 ? 'studio-nav-badge' : 'badge'">{{ history.length }}</span>
        </div>

        <!-- 隐私空间：未启用时显示引导入口，启用后只在解锁状态下出现 -->
        <div
          v-if="vaultVisible"
          :class="[isV2 ? 'studio-nav-item' : 'nav-item', { active: page === 'vault' }]"
          @click="page = 'vault'"
        >
          <component :is="vault.enabled ? Lock : ShieldPlus" :size="15" />
          <span>隐私空间</span>
          <span v-if="!vault.enabled" :class="isV2 ? 'studio-nav-badge' : 'badge'">未启用</span>
          <span v-else-if="vault.count !== null" :class="isV2 ? 'studio-nav-badge' : 'badge'">{{ vault.count }}</span>
        </div>

        <div :class="isV2 ? 'studio-nav-group-title' : 'nav-group'">系统配置</div>
        <div
          :class="[isV2 ? 'studio-nav-item' : 'nav-item', { active: page === 'settings' }]"
          @click="page = 'settings'"
        >
          <SettingsIcon :size="15" />
          <span>系统设置</span>
        </div>
      </nav>
    </aside>

    <main class="main" :class="{ 'studio-main': isV2 }">
      <header class="topbar" :class="{ 'studio-topbar': isV2 }">
        <div class="studio-topbar-breadcrumb">
          <span :class="isV2 ? 'studio-topbar-title' : 'topbar-title'">{{ title }}</span>
          <span :class="isV2 ? 'studio-topbar-tagline' : 'topbar-tag'">{{ tagline }}</span>
        </div>
        <div class="topbar-spacer"></div>

        <!-- 视觉版本切换胶囊 (Edition Switcher) -->
        <div class="studio-edition-toggle">
          <button
            class="studio-edition-btn"
            :class="{ active: isV2 }"
            title="体验画境 2.0 灵境美学版"
            @click="setEdition('v2')"
          >
            <Sparkles :size="12" /> 灵境 2.0
          </button>
          <button
            class="studio-edition-btn"
            :class="{ active: !isV2, classic: !isV2 }"
            title="切换回经典工作台"
            @click="setEdition('v1')"
          >
            经典 1.0
          </button>
        </div>

        <BackendBadge />
      </header>

      <div class="content" :class="{ 'studio-content': isV2 }">
        <div v-if="!appReady" class="empty">正在恢复上次的工作台…</div>

        <template v-else>
          <!--
            用 MODE_ORDER.includes 而不是链式 !== 判断：后者会让 TS 把 page 收窄成
            {library,history,settings}，后面 v-else-if 里的 'vault' 就被当成不可能的分支。
          -->
          <GeneratorView
            v-if="isMode(page)"
            :key="page"
            :mode="page as ModeId"
            @preview="openPreview"
            @go="go"
            @toast="showToast"
          />
          <LibraryView
            v-else-if="page === 'library'"
            @preview="openPreview"
            @toast="showToast"
          />
          <HistoryView
            v-else-if="page === 'history'"
            @preview="openPreview"
            @go="go"
            @toast="showToast"
            @move-to-vault="moveToVault"
          />
          <VaultView v-else-if="page === 'vault'" @toast="showToast" />
          <SettingsView v-else @toast="showToast" @unlock-vault="showUnlock = true" />
        </template>
      </div>
    </main>

    <LogDrawer />

    <Lightbox
      v-if="lightbox"
      :paths="lightbox.paths"
      :index="lightbox.index"
      :deletable="page === 'library' || page === 'history'"
      :vault-ready="vaultVisible"
      :moving="movingToVault"
      @update:index="(i) => lightbox && (lightbox.index = i)"
      @deleted="onDeleted"
      @move-to-vault="moveToVault([$event])"
      @close="lightbox = null"
    />

    <VaultUnlock
      v-if="showUnlock"
      @close="showUnlock = false"
      @unlocked="onVaultUnlocked"
      @toast="showToast"
    />

    <div v-if="dragging" class="drop-mask">
      <div class="drop-hint">
        <Image :size="38" />
        <div>松手即可填入图槽</div>
      </div>
    </div>

    <Transition name="toast">
      <div v-if="toast" class="toast">
        <CheckCircle2 :size="14" />
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.drop-mask {
  position: fixed;
  inset: 0;
  z-index: 250;
  background: rgba(10, 12, 18, 0.72);
  display: grid;
  place-items: center;
  pointer-events: none;
}
.drop-hint {
  border: 2px dashed var(--accent);
  border-radius: var(--radius-lg);
  padding: 34px 52px;
  text-align: center;
  color: var(--text);
  background: rgba(124, 92, 255, 0.1);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}

.toast {
  position: fixed;
  bottom: 26px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 400;
  background: var(--bg-3);
  border: 1px solid var(--border-strong);
  border-radius: 22px;
  padding: 9px 18px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: var(--shadow);
  color: var(--text);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>

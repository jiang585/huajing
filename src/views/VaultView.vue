<script setup lang="ts">
/**
 * 隐私空间页面。
 *
 * 三种形态：未启用（引导设密码）、已启用未解锁（锁屏）、已解锁（图片网格）。
 * 正常情况下「已启用未解锁」进不来 —— 入口在侧栏是隐藏的，得走设置页的手势。
 * 这里保留锁屏形态，是为了锁定之后停在当前页时不至于看到空白。
 */

import { computed, onMounted, ref } from "vue";
import {
  Lock,
  Unlock,
  ShieldCheck,
  ShieldPlus,
  Download,
  FolderOutput,
  Trash2,
  CheckSquare,
  Square,
  KeyRound,
  ShieldOff,
  Loader2,
  ImageOff,
  AlertTriangle,
  Eye,
  Info,
} from "lucide-vue-next";
import {
  vault,
  vaultEntries,
  vaultThumbs,
  vaultBusy,
  vaultSelected,
  vaultThumbFailed,
  loadAllThumbs,
  refreshVaultEntries,
  moveOutOfVault,
  deleteFromVault,
  lockVault,
  enableVault,
  disableVault,
  changeVaultPassword,
  saveVaultImageAs,
  toggleSelect,
  selectAll,
  clearSelection,
  totalVaultBytes,
} from "../stores/vault";
import { formatBytes } from "../api/tauri";
import { settings } from "../stores/settings";
import VaultViewer from "../components/VaultViewer.vue";

const emit = defineEmits<{ (e: "toast", msg: string): void }>();

const viewer = ref<number | null>(null);
const err = ref("");

// 设置密码表单
const pw1 = ref("");
const pw2 = ref("");
const hint = ref("");
const busy = ref(false);

// 改密码 / 停用
const showChange = ref(false);
const oldPw = ref("");
const newPw = ref("");
const showDisable = ref(false);
const disablePw = ref("");

const selectedIds = computed(() => [...vaultSelected.value]);
const allSelected = computed(
  () => vaultEntries.value.length > 0 && vaultSelected.value.size === vaultEntries.value.length,
);

onMounted(async () => {
  if (vault.unlocked) {
    await refreshVaultEntries();
    await loadAllThumbs();
  }
});

async function doEnable() {
  err.value = "";
  if (pw1.value.length < 6) {
    err.value = "密码至少 6 位";
    return;
  }
  if (pw1.value !== pw2.value) {
    err.value = "两次输入的密码不一致";
    return;
  }
  busy.value = true;
  try {
    await enableVault(pw1.value, hint.value.trim());
    pw1.value = "";
    pw2.value = "";
    emit("toast", "隐私安全空间初始化完成，保护已生效");
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function doLock() {
  await lockVault();
  viewer.value = null;
  emit("toast", "安全空间已加锁，会话解密上下文已清除");
}

async function doMoveOut(ids: string[]) {
  if (ids.length === 0) return;
  err.value = "";
  busy.value = true;
  try {
    const paths = await moveOutOfVault(ids);
    viewer.value = null;
    emit("toast", `已成功解密导出 ${paths.length} 项影像资产至输出目录`);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function doDelete(ids: string[]) {
  if (ids.length === 0) return;
  err.value = "";
  busy.value = true;
  try {
    const n = await deleteFromVault(ids);
    viewer.value = null;
    emit("toast", `已彻底销毁 ${n} 项加密资产文件`);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function doDownload(id: string) {
  try {
    const p = await saveVaultImageAs(id);
    if (p) emit("toast", `已导出另存为：${p}`);
  } catch (e) {
    emit("toast", `另存失败：${e instanceof Error ? e.message : e}`);
  }
}

async function doChange() {
  err.value = "";
  busy.value = true;
  try {
    await changeVaultPassword(oldPw.value, newPw.value);
    showChange.value = false;
    oldPw.value = "";
    newPw.value = "";
    emit("toast", "主密码已更新，空间资产已完成重新加密封装");
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function doDisable() {
  err.value = "";
  busy.value = true;
  try {
    await disableVault(disablePw.value);
    showDisable.value = false;
    disablePw.value = "";
    emit("toast", "隐私安全空间已成功停用注销");
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function toggleAll() {
  if (allSelected.value) clearSelection();
  else selectAll();
}

function fmtTime(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <!-- 未启用：引导设置密码 -->
  <div v-if="!vault.enabled" style="max-width: 640px">
    <div class="card">
      <h3 class="card-title"><ShieldPlus :size="15" /> 初始化隐私安全空间</h3>
      <p style="font-size: 13px; color: var(--text-2); line-height: 1.75; margin: 0 0 14px">
        隐私空间基于高强度工业级 AES-256-GCM 算法对影像资产及索引元数据实施端到端加密保护。加密密钥通过 PBKDF2-HMAC-SHA256（200,000 次哈希迭代）自用户主密码派生，仅在会话内存中动态解密驻留。影像资产移入安全空间后，系统将自动抹除原输出目录中的原始明文文件，并同步剔除历史记录，确保存储介质上不保留任何未加密数据残留。
      </p>

      <div class="alert warn" style="margin-bottom: 14px">
        <AlertTriangle :size="14" />
        <div>
          <strong>安全提示：系统不提供密码重置或找回机制。</strong>
          主密码及派生密钥均不进行任何形式的持久化存储。若遗忘主密码，已加密的影像资产将处于不可逆的永久锁定状态，无法解密恢复。请务必牢记并妥善保管您的主密码。
        </div>
      </div>

      <div class="field">
        <label class="label">设置访问主密码<span class="req">*</span></label>
        <input
          v-model="pw1"
          class="input"
          type="password"
          placeholder="请输入至少 6 位主密码"
          @keyup.enter="doEnable"
        />
      </div>
      <div class="field">
        <label class="label">确认主密码<span class="req">*</span></label>
        <input v-model="pw2" class="input" type="password" placeholder="请再次输入主密码进行校验" @keyup.enter="doEnable" />
      </div>
      <div class="field">
        <label class="label">密码提示信息<span class="muted">（可选，明文保存，请勿直接包含密码本体）</span></label>
        <input v-model="hint" class="input" placeholder="例如：特定纪念年份与前缀组合" />
      </div>

      <div v-if="err" class="alert err" style="margin-bottom: 12px">{{ err }}</div>

      <button class="btn primary lg" style="width: 100%" :disabled="busy" @click="doEnable">
        <Loader2 v-if="busy" :size="15" class="spin" />
        <ShieldCheck v-else :size="15" />
        初始化隐私安全空间
      </button>
    </div>
  </div>

  <!-- 已启用但锁定 -->
  <div v-else-if="!vault.unlocked" class="empty" style="padding: 70px 20px">
    <Lock :size="40" />
    <div class="empty-title">隐私安全空间已加锁</div>
    <div class="empty-sub">
      安全空间入口已根据隐私保护策略隐蔽。<br />
      如需访问，请前往「系统设置」页面验证主密码进行解锁。
    </div>
  </div>

  <!-- 已解锁 -->
  <div v-else>
    <div class="flex wrap" style="margin-bottom: 14px">
      <span class="pill ok"><Unlock :size="11" /> 会话已解密</span>
      <span class="pill">{{ vaultEntries.length }} 项资产</span>
      <span class="pill">{{ formatBytes(totalVaultBytes()) }}</span>
      <div style="flex: 1"></div>

      <button class="btn sm" :disabled="vaultEntries.length === 0" @click="toggleAll">
        <component :is="allSelected ? CheckSquare : Square" :size="12" />
        {{ allSelected ? "取消全选" : "全选" }}
      </button>
      <button
        class="btn sm"
        :disabled="selectedIds.length === 0 || vaultBusy"
        @click="doMoveOut(selectedIds)"
      >
        <FolderOutput :size="12" /> 解密导出选中项（{{ selectedIds.length }}）
      </button>
      <button
        class="btn danger sm"
        :disabled="selectedIds.length === 0 || vaultBusy"
        @click="doDelete(selectedIds)"
      >
        <Trash2 :size="12" /> 永久销毁选中项
      </button>
      <button class="btn sm" @click="showChange = true"><KeyRound :size="12" /> 修改主密码</button>
      <button class="btn sm" @click="showDisable = true"><ShieldOff :size="12" /> 停用空间</button>
      <button class="btn primary sm" @click="doLock"><Lock :size="12" /> 立即加锁</button>
    </div>

    <div class="alert info" style="margin-bottom: 14px">
      <Info :size="14" />
      <div>
        当前呈现的影像资产均在运行时动态解密至系统内存，未向本地磁盘写入任何明文缓存。
        导出操作将把选定资产解密并转存至 <span class="mono">{{ settings.outputDir }}\隐私空间移出</span>，并同步重建历史生成索引。
      </div>
    </div>

    <div v-if="err" class="alert err" style="margin-bottom: 14px">{{ err }}</div>

    <div v-if="vaultEntries.length === 0" class="empty">
      <ImageOff :size="36" />
      <div class="empty-title">安全空间当前暂无归档资产</div>
      <div class="empty-sub">
        在「生成历史」或图片全屏预览中选择「移入隐私空间」，即可将指定影像加密封存，<br />
        系统将同步销毁输出目录中的原始明文文件及历史索引记录。
      </div>
    </div>

    <div v-else class="result-grid">
      <div
        v-for="(e, i) in vaultEntries"
        :key="e.id"
        class="result-item vault-item"
        :class="{ picked: vaultSelected.has(e.id) }"
        @click="viewer = i"
      >
        <img v-if="vaultThumbs[e.id]" :src="vaultThumbs[e.id]" alt="" />
        <div v-else-if="vaultThumbFailed.has(e.id)" class="thumb-loading">
          <AlertTriangle :size="18" style="color: var(--err)" />
          <span style="font-size: 11px">解密失败</span>
        </div>
        <div v-else class="thumb-loading">
          <Loader2 :size="18" class="spin" />
        </div>

        <span class="dims">{{ e.width }}×{{ e.height }}</span>
        <span class="vault-lock"><Lock :size="10" /></span>

        <div class="pick" @click.stop="toggleSelect(e.id)">
          <component :is="vaultSelected.has(e.id) ? CheckSquare : Square" :size="17" />
        </div>

        <div class="overlay" @click.stop>
          <button class="btn sm" @click="viewer = i"><Eye :size="12" /> 查看</button>
          <button class="btn sm" @click="doDownload(e.id)"><Download :size="12" /></button>
          <button class="btn sm" @click="doMoveOut([e.id])"><FolderOutput :size="12" /></button>
          <button class="btn danger sm" @click="doDelete([e.id])"><Trash2 :size="12" /></button>
        </div>

        <div class="vault-meta">{{ fmtTime(e.added_at) }}</div>
      </div>
    </div>
  </div>

  <VaultViewer
    v-if="viewer !== null && vaultEntries.length > 0"
    :entries="vaultEntries"
    :index="Math.min(viewer, vaultEntries.length - 1)"
    @update:index="(i) => (viewer = i)"
    @close="viewer = null"
    @move-out="doMoveOut([$event])"
    @remove="doDelete([$event])"
    @toast="emit('toast', $event)"
  />

  <!-- 改密码 -->
  <div v-if="showChange" class="overlay-mask" @click.self="showChange = false">
    <div class="modal" style="width: 420px">
      <div class="modal-head"><span class="modal-title">修改安全空间主密码</span></div>
      <div class="modal-body">
        <div class="field">
          <label class="label">当前主密码</label>
          <input v-model="oldPw" class="input" type="password" placeholder="请输入当前主密码" />
        </div>
        <div class="field">
          <label class="label">新主密码<span class="req">*</span></label>
          <input v-model="newPw" class="input" type="password" placeholder="请输入至少 6 位新主密码" />
        </div>
        <div class="hint">
          修改密码将基于全新随机盐重新派生加密主密钥，并对空间内所有已归档影像资产执行重新加密。数据量较大时处理可能需要少量时间。
        </div>
        <div v-if="err" class="alert err" style="margin-top: 12px">{{ err }}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="showChange = false">取消</button>
        <button class="btn primary" :disabled="busy" @click="doChange">确认更新密钥</button>
      </div>
    </div>
  </div>

  <!-- 停用 -->
  <div v-if="showDisable" class="overlay-mask" @click.self="showDisable = false">
    <div class="modal" style="width: 420px">
      <div class="modal-head"><span class="modal-title">停用隐私安全空间</span></div>
      <div class="modal-body">
        <div class="alert warn" style="margin-bottom: 12px">
          <AlertTriangle :size="14" />
          <div>
            停用操作将注销安全空间加密体系。为防止数据意外丢失，仅在空间内<strong>无任何未解密资产</strong>时方可执行停用。请先将资产全部解密导出。此操作不可逆。
          </div>
        </div>
        <div class="field">
          <label class="label">验证主密码以确认操作</label>
          <input v-model="disablePw" class="input" type="password" placeholder="请输入主密码确认注销" />
        </div>
        <div v-if="err" class="alert err" style="margin-top: 12px">{{ err }}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="showDisable = false">取消</button>
        <button class="btn danger" :disabled="busy" @click="doDisable">确认停用空间</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vault-item {
  cursor: pointer;
}
.vault-item.picked {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.vault-lock {
  position: absolute;
  top: 7px;
  left: 7px;
  background: rgba(0, 0, 0, 0.66);
  color: var(--accent-hover);
  padding: 3px 5px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  backdrop-filter: blur(4px);
}
.pick {
  position: absolute;
  bottom: 7px;
  right: 7px;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 4px;
  padding: 2px;
  display: grid;
  place-items: center;
  backdrop-filter: blur(4px);
}
.vault-meta {
  position: absolute;
  bottom: 7px;
  left: 7px;
  font-size: 10px;
  color: var(--text-2);
  background: rgba(0, 0, 0, 0.55);
  padding: 2px 6px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
}
.thumb-loading {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.spin {
  animation: rot 1s linear infinite;
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}
</style>

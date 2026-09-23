<script setup lang="ts">
/** 设置：目录、默认参数、2K 精修参数、模型自检。 */

import { onMounted, onUnmounted, ref } from "vue";
import {
  FolderOpen,
  RotateCcw,
  CheckCircle2,
  XCircle,
  HardDrive,
  AlertTriangle,
  ScanLine,
  Loader2,
  Sparkles,
  Eye,
  EyeOff,
  RefreshCw,
  Lock,
  ShieldCheck,
  Plug,
  Smartphone,
  Copy,
  Trash2,
} from "lucide-vue-next";
import {
  pickDirectory,
  openPath,
  comfyModels,
  dirStats,
  formatBytes,
  storeDirPath,
  appPaths,
  deepseekModels,
  lanPairingCode,
  lanDevices,
  lanRevokeDevice,
} from "../api/tauri";
import { settings, saveSettings, resetSettings, SIZE_PRESETS, dataDir } from "../stores/settings";
import { backend, refreshLogs } from "../stores/backend";
import { vault } from "../stores/vault";
import { UPSCALE_DEFAULTS } from "../api/graphs";

const emit = defineEmits<{
  (e: "toast", msg: string): void;
  (e: "unlockVault"): void;
}>();

const checking = ref(false);
const checkResult = ref<{ name: string; folder: string; ok: boolean }[]>([]);
const stats = ref("");
const storeDir = ref("");
const version = ref("");
const pairingCode = ref("");
const pairedDevices = ref<Array<{ deviceId: string; deviceName: string; appInstanceId: string; createdAt: number; lastSeenAt: number }>>([]);

// DeepSeek
const showKey = ref(false);
const probing = ref(false);
const probeErr = ref("");
const probeOk = ref("");

// 版本号连点计数（隐私空间的隐藏入口）
const taps = ref(0);
let tapTimer: number | null = null;
let pairingRefreshTimer: number | null = null;

/** 应用依赖的模型文件，缺任何一个对应功能就跑不起来 */
const REQUIRED: { folder: string; name: string }[] = [
  { folder: "diffusion_models", name: "qwen_image_2.1_int8_convrot.safetensors" },
  { folder: "diffusion_models", name: "z_image_turbo_int8_convrot.safetensors" },
  { folder: "text_encoders", name: "qwen3vl_8b_int8_convrot.safetensors" },
  { folder: "text_encoders", name: "qwen_3_4b_fp8_mixed.safetensors" },
  { folder: "vae", name: "qwen_image_2.1_vae_bf16.safetensors" },
  { folder: "vae", name: "ae.safetensors" },
  { folder: "upscale_models", name: "RealESRGAN_x4.pth" },
  { folder: "diffusion_models", name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors" },
  { folder: "text_encoders", name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" },
  { folder: "vae", name: "minimax_h3_video_vae_fp16.safetensors" },
  { folder: "vae", name: "minimax_h3_audio_vae_fp32.safetensors" },
  { folder: "loras", name: "minimax_h3_turbo_4step_ckpt500.safetensors" },
];

onMounted(async () => {
  storeDir.value = await storeDirPath().catch(() => "");
  try {
    version.value = (await appPaths()).version;
  } catch {
    version.value = "1.1.1";
  }
  await refreshStats();
  try {
    pairingCode.value = await lanPairingCode();
    pairedDevices.value = await lanDevices();
  } catch { /* older backend */ }
  pairingRefreshTimer = window.setInterval(async () => {
    try { pairedDevices.value = await lanDevices(); } catch { /* backend may be stopping */ }
  }, 2000);
});

onUnmounted(() => {
  if (pairingRefreshTimer !== null) window.clearInterval(pairingRefreshTimer);
  pairingRefreshTimer = null;
});

async function revokeDevice(deviceId: string) {
  if (!(await lanRevokeDevice(deviceId))) return;
  pairedDevices.value = pairedDevices.value.filter((d) => d.deviceId !== deviceId);
  emit("toast", "已删除调用端");
}

async function copyPairingCode() {
  if (!pairingCode.value) return;
  await navigator.clipboard?.writeText(pairingCode.value);
  emit("toast", "配对码已复制");
}

/**
 * 连点版本号 5 下唤出隐私空间解锁框。
 * 这是隐私空间开启后唯一的入口 —— 侧栏入口会隐藏，所以这里必须「几步操作」才出。
 */
function tapVersion() {
  taps.value += 1;
  if (tapTimer !== null) window.clearTimeout(tapTimer);
  if (taps.value >= 5) {
    taps.value = 0;
    emit("unlockVault");
    return;
  }
  // 停手 1.6 秒就重新计数，避免慢慢点也凑够 5 下
  tapTimer = window.setTimeout(() => (taps.value = 0), 1600);
}

async function probeModels() {
  probeErr.value = "";
  probeOk.value = "";
  if (!settings.deepseekKey.trim()) {
    probeErr.value = "先填 API Key";
    return;
  }
  probing.value = true;
  try {
    const list = await deepseekModels(settings.deepseekKey);
    settings.deepseekModels = list.map((m) => m.id);
    // 之前选的模型如果已经不在列表里，自动切到第一个
    if (!settings.deepseekModels.includes(settings.deepseekModel)) {
      settings.deepseekModel = settings.deepseekModels[0] ?? "";
    }
    await saveSettings();
    probeOk.value = `连接正常，探测到 ${list.length} 个模型`;
    emit("toast", probeOk.value);
  } catch (e) {
    probeErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    probing.value = false;
  }
}

async function refreshStats() {
  try {
    const [bytes, count] = await dirStats(settings.outputDir);
    stats.value = count > 0 ? `${count} 个文件 · ${formatBytes(bytes)}` : "目录为空";
  } catch {
    stats.value = "读取失败";
  }
}

async function pickOutput() {
  const d = await pickDirectory("选择生成结果的保存位置");
  if (!d) return;
  settings.outputDir = d;
  await saveSettings();
  await refreshStats();
  emit("toast", "输出目录已更新");
}

async function pickRoot() {
  const d = await pickDirectory("选择 ComfyUI 根目录（里面有 main.py 和 venv）");
  if (!d) return;
  settings.comfyRoot = d;
  await saveSettings();
  emit("toast", "ComfyUI 根目录已更新");
}

async function persist(msg = "设置已保存") {
  await saveSettings();
  emit("toast", msg);
}

async function doReset() {
  await resetSettings();
  await refreshStats();
  emit("toast", "已恢复默认设置");
}

async function selfCheck() {
  checking.value = true;
  checkResult.value = [];
  try {
    const folders = [...new Set(REQUIRED.map((r) => r.folder))];
    const lists: Record<string, string[]> = {};
    for (const f of folders) {
      try {
        lists[f] = await comfyModels(f);
      } catch {
        lists[f] = [];
      }
    }
    checkResult.value = REQUIRED.map((r) => ({
      ...r,
      ok: (lists[r.folder] ?? []).includes(r.name),
    }));
    const missing = checkResult.value.filter((c) => !c.ok).length;
    emit("toast", missing === 0 ? "全部模型都在位" : `缺少 ${missing} 个模型文件`);
  } catch (e) {
    emit("toast", `自检失败：${e}`);
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div style="max-width: 780px">
    <!-- 目录 -->
    <div class="card">
      <h3 class="card-title"><HardDrive :size="14" /> 目录</h3>

      <div class="field">
        <label class="label">生成结果保存位置</label>
        <div class="flex">
          <input v-model="settings.outputDir" class="input mono" spellcheck="false" />
          <button class="btn" @click="pickOutput"><FolderOpen :size="13" /> 选择</button>
          <button class="btn ghost" @click="openPath(settings.outputDir)">
            <FolderOpen :size="13" />
          </button>
        </div>
        <div class="hint">
          每次生成完自动复制到这里，按功能分子目录（文生图 / 单图编辑 / 多参考图 …）。
          当前：{{ stats }}
        </div>
      </div>

      <div class="field">
        <label class="label">ComfyUI 根目录</label>
        <div class="flex">
          <input v-model="settings.comfyRoot" class="input mono" spellcheck="false" />
          <button class="btn" @click="pickRoot"><FolderOpen :size="13" /> 选择</button>
        </div>
        <div class="hint">
          里面应当有 main.py、venv\Scripts\python.exe、start_comfy.py。改完会自动生效。
        </div>
      </div>

      <div class="field">
        <label class="label">应用数据目录</label>
        <div class="flex">
          <input :value="dataDir || storeDir" class="input mono" readonly />
          <button class="btn ghost" @click="openPath(dataDir || storeDir)">
            <FolderOpen :size="13" />
          </button>
        </div>
        <div class="hint">设置、历史记录、图库索引和缩略图缓存在这里。</div>
      </div>
    </div>

    <!-- RolePlayChat LAN bridge -->
    <div class="card">
      <h3 class="card-title"><Smartphone :size="14" /> RolePlayChat 局域网调用</h3>
      <div class="hint" style="margin-bottom: 10px">
        服务随 Huajing 启动，监听本机局域网端口 17890。RolePlayChat 首次配对后可长期调用，删除调用端后令牌立即失效。
      </div>
      <div class="field">
        <label class="label">首次配对码</label>
        <div class="flex">
          <input :value="pairingCode || '读取中…'" class="input mono" readonly />
          <button class="btn ghost" @click="copyPairingCode"><Copy :size="13" /> 复制</button>
        </div>
      </div>
      <div class="field" v-if="pairedDevices.length">
        <label class="label">已配对调用端</label>
        <div v-for="device in pairedDevices" :key="device.deviceId" class="flex" style="margin-top: 6px">
          <span class="mono" style="flex: 1">{{ device.deviceName }} · {{ device.deviceId.slice(0, 8) }}</span>
          <button class="btn ghost" @click="revokeDevice(device.deviceId)"><Trash2 :size="13" /> 删除</button>
        </div>
      </div>
      <div class="hint">电脑端删除调用端后，手机需要重新配对；日常生成不需要重复扫码。</div>
    </div>

    <!-- 界面视觉风格 -->
    <div class="card">
      <h3 class="card-title"><Sparkles :size="14" /> 界面视觉与美学风格</h3>

      <div class="field">
        <label class="label">工作台外观模式</label>
        <div class="seg" style="width: 100%">
          <button
            style="flex: 1"
            :class="{ on: settings.themeEdition !== 'v1' }"
            @click="settings.themeEdition = 'v2'; persist('已启用 2.0 灵境美学工作室')"
          >
            ✨ 2.0 灵境美学版 (Studio Next)
          </button>
          <button
            style="flex: 1"
            :class="{ on: settings.themeEdition === 'v1' }"
            @click="settings.themeEdition = 'v1'; persist('已切回 1.0 经典工作台')"
          >
            1.0 经典工作台 (Classic)
          </button>
        </div>
        <div class="hint">
          {{
            settings.themeEdition !== "v1"
              ? "灵境美学版：极简深空黑、微发光边框、玻璃态拟物、视觉比例卡片、运镜时间线工坊。"
              : "经典版：双栏紧凑排布、原生控制流。"
          }}
        </div>
      </div>
    </div>

    <!-- 默认参数 -->
    <div class="card">
      <h3 class="card-title">默认参数</h3>

      <div class="field">
        <label class="label">文生图默认模型</label>
        <div class="seg">
          <button
            :class="{ on: settings.defaultModel === 'qwen' }"
            @click="settings.defaultModel = 'qwen'; persist()"
          >
            Qwen-Image 2.1
          </button>
          <button
            :class="{ on: settings.defaultModel === 'zimage' }"
            @click="settings.defaultModel = 'zimage'; persist()"
          >
            Z-Image Turbo
          </button>
        </div>
        <div class="hint">只影响新开页面的初始值，单次生成仍可在页面上切换。</div>
      </div>

      <div class="field">
        <label class="label">文生图默认尺寸</label>
        <div class="flex wrap" style="gap: 6px">
          <button
            v-for="p in SIZE_PRESETS"
            :key="p.value"
            class="btn sm"
            :class="{ primary: settings.defaultSize === p.value }"
            @click="settings.defaultSize = p.value; persist()"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <div class="field">
        <label class="label">历史记录条数上限</label>
        <input
          v-model.number="settings.historyLimit"
          class="input"
          type="number"
          min="50"
          max="5000"
          style="width: 160px"
          @change="persist()"
        />
        <div class="hint">超出后自动丢弃最老的记录。图片文件不会被删除。</div>
      </div>
    </div>

    <!-- 2K 精修 -->
    <div class="card">
      <h3 class="card-title">
        2K 精修参数
        <span class="muted">用于「2K 放大」和「多参考图 + 2K」</span>
      </h3>

      <div class="field">
        <label class="label">精修提示词</label>
        <input
          v-model="settings.upscalePrompt"
          class="input"
          spellcheck="false"
          @change="persist()"
        />
        <div class="hint">
          Z-Image 在放大后会用这段提示词做一次低降噪重绘来补细节。默认值够用，
          想更锐利可以加 detail、sharp focus 之类。
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label class="label">降噪强度：{{ settings.upscaleDenoise }}</label>
          <input
            v-model.number="settings.upscaleDenoise"
            type="range"
            min="0.1"
            max="0.7"
            step="0.01"
            style="width: 100%"
            @change="persist()"
          />
          <div class="hint">
            0.33 是保守值，只补细节不改构图；超过 0.5 会明显改动画面内容。
          </div>
        </div>
        <div class="field">
          <label class="label">精修步数</label>
          <input
            v-model.number="settings.upscaleSteps"
            class="input"
            type="number"
            min="1"
            max="20"
            @change="persist()"
          />
          <div class="hint">官方工作流用 {{ UPSCALE_DEFAULTS.steps }} 步。</div>
        </div>
      </div>
    </div>

    <!-- 自检 -->
    <div class="card">
      <h3 class="card-title">
        <ScanLine :size="14" /> 模型自检
        <div style="flex: 1"></div>
        <button class="btn sm" :disabled="!backend.running || checking" @click="selfCheck">
          <Loader2 v-if="checking" :size="12" class="spin" />
          开始检查
        </button>
      </h3>

      <div v-if="!backend.running" class="alert warn">
        <AlertTriangle :size="14" />
        <div>需要先启动 ComfyUI 后端才能检查。自检会向它查询各模型目录的文件列表。</div>
      </div>

      <div v-else-if="checkResult.length === 0" class="hint">
        点「开始检查」确认七个必需的模型文件都在位。
      </div>

      <div v-else class="check-list">
        <div v-for="c in checkResult" :key="c.folder + c.name" class="check-row">
          <CheckCircle2 v-if="c.ok" :size="14" style="color: var(--ok)" />
          <XCircle v-else :size="14" style="color: var(--err)" />
          <span class="mono" style="flex: 1">{{ c.name }}</span>
          <span class="muted" style="font-size: 11px">{{ c.folder }}</span>
        </div>
      </div>
    </div>

    <!-- DeepSeek 提示词优化 -->
    <div class="card">
      <h3 class="card-title">
        <Sparkles :size="14" /> DeepSeek 提示词优化
        <span class="muted">用于「优化提示词」按钮</span>
      </h3>

      <div class="field">
        <label class="label">API Key</label>
        <div class="flex">
          <input
            v-model="settings.deepseekKey"
            class="input mono"
            :type="showKey ? 'text' : 'password'"
            placeholder="sk-..."
            spellcheck="false"
            @change="persist('API Key 已保存')"
          />
          <button class="btn ghost" :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
            <component :is="showKey ? EyeOff : Eye" :size="13" />
          </button>
          <button class="btn" :disabled="probing" @click="probeModels">
            <Loader2 v-if="probing" :size="13" class="spin" />
            <Plug v-else :size="13" />
            获取模型列表
          </button>
        </div>
        <div class="hint">
          Key 明文存在应用数据目录的 settings.json 里。不想落盘的话，改用环境变量
          <span class="mono">DEEPSEEK_API_KEY</span>，应用会自动优先读它。
        </div>
      </div>

      <div class="field">
        <label class="label">模型</label>
        <div v-if="settings.deepseekModels.length > 0" class="flex">
          <select
            v-model="settings.deepseekModel"
            class="select"
            @change="persist('模型已切换')"
          >
            <option v-for="m in settings.deepseekModels" :key="m" :value="m">{{ m }}</option>
          </select>
          <button class="btn ghost" title="重新探测" @click="probeModels">
            <RefreshCw :size="13" />
          </button>
        </div>
        <div v-else class="flex">
          <input
            v-model="settings.deepseekModel"
            class="input mono"
            placeholder="还没探测到模型，也可以手动填模型 id"
            spellcheck="false"
            @change="persist('模型已保存')"
          />
        </div>
        <div class="hint">
          模型名不写死 —— 点「获取模型列表」从接口实时拉，DeepSeek 换模型名不用改应用。
        </div>
      </div>

      <div v-if="probeErr" class="alert err">{{ probeErr }}</div>
      <div v-else-if="probeOk" class="alert info">{{ probeOk }}</div>
    </div>

    <!--
      隐私空间卡片只在两种情况下出现：
      - 还没启用：正常的功能引导，没什么可藏的；
      - 本次已解锁：用户已经证明知道密码，显示出来方便管理。
      已启用但锁定 —— 整张卡片消失，界面上不留任何痕迹。
    -->
    <div v-if="!vault.enabled || vault.unlocked" class="card">
      <h3 class="card-title"><Lock :size="14" /> 隐私空间</h3>

      <div class="flex wrap" style="margin-bottom: 10px">
        <span class="pill" :class="vault.enabled ? 'ok' : ''">
          <ShieldCheck :size="11" />
          {{ vault.enabled ? "已启用" : "未启用" }}
        </span>
        <span v-if="vault.unlocked" class="pill accent">本次会话已解锁</span>
        <span v-if="vault.unlocked && vault.count !== null" class="pill">
          {{ vault.count }} 张
        </span>
      </div>

      <div class="hint" style="margin-bottom: 10px">
        隐私空间采用高强度工业级 AES-256-GCM 算法对影像资产及索引元数据实施端到端加密保护。加密密钥通过 PBKDF2-HMAC-SHA256 算法（{{ vault.iterations || 200000 }} 次哈希迭代）自用户主密码派生，仅在会话内存中动态解密驻留。影像资产移入安全空间后，系统将自动抹除原输出目录中的原始明文文件，并同步剔除历史记录，确保存储介质上不保留任何未加密数据残留。
      </div>

      <div class="hint">
        <template v-if="!vault.enabled">
          前往导航栏「隐私空间」完成访问主密码初始化即可启用。
          <strong>启用后安全空间入口将自动隐蔽</strong>。
        </template>
        <template v-else>
          当前会话处于已解锁状态。可在安全空间管理面板中执行主密码更新、即时加锁或停用注销。
          <strong>加锁后，空间入口将自动隐藏。</strong>
        </template>
      </div>
    </div>

    <!-- 危险区 -->
    <div class="card">
      <h3 class="card-title">重置</h3>
      <button class="btn danger" @click="doReset">
        <RotateCcw :size="13" /> 恢复默认设置
      </button>
      <div class="hint">
        只重置设置项，不会删除历史记录、图库索引，也不会动任何图片文件。
      </div>
    </div>

    <div style="height: 20px"></div>
    <div class="flex" style="justify-content: space-between; align-items: center">
      <button class="btn ghost sm" @click="refreshLogs">刷新后端日志缓存</button>
      <!--
        隐藏入口。刻意做成完全静默：没有 tooltip、没有高亮、点错了也没有任何反馈 ——
        任何"你点对了"的提示都等于告诉别人这里有名堂。
      -->
      <span class="version" @click="tapVersion">画境 v{{ version }}</span>
    </div>
    <div style="height: 20px"></div>
  </div>
</template>

<style scoped>
.check-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 9px;
  background: var(--bg-2);
  border-radius: var(--radius-sm);
}
.spin {
  animation: rot 1s linear infinite;
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}

/* 版本号看着是普通文字，其实藏着隐私空间的入口 —— 所以不能有任何视觉提示 */
.version {
  font-size: 11px;
  color: var(--text-3);
  cursor: default;
  user-select: none;
  padding: 2px 6px;
  border-radius: 5px;
}
</style>

<script setup lang="ts">
/**
 * 解锁 / 设置密码弹框。
 *
 * 由设置页「连点版本号 5 下」的手势唤出（见 App.vue）。已启用则问密码，
 * 未启用则提示先到隐私空间页启用。
 */

import { computed, onMounted, ref } from "vue";
import { Lock, Unlock, Loader2, X, KeyRound, AlertTriangle } from "lucide-vue-next";
import { vault, unlockVault } from "../stores/vault";

const emit = defineEmits<{
  (e: "close"): void;
  (e: "unlocked"): void;
  (e: "toast", msg: string): void;
}>();

const pw = ref("");
const err = ref("");
const busy = ref(false);
const shake = ref(false);
const input = ref<HTMLInputElement | null>(null);

const isEnabled = computed(() => vault.enabled);

onMounted(() => {
  // 手势唤出来的，直接聚焦省一次点击
  window.setTimeout(() => input.value?.focus(), 60);
});

async function submit() {
  if (!isEnabled.value) return;
  if (!pw.value) {
    err.value = "请输入安全主密码";
    return;
  }
  err.value = "";
  busy.value = true;
  try {
    const ok = await unlockVault(pw.value);
    if (ok) {
      emit("toast", "安全空间验证通过，会话已解锁");
      emit("unlocked");
      emit("close");
    } else {
      err.value = "主密码验证失败，请重新输入";
      pw.value = "";
      // 抖一下，给个明确的失败反馈
      shake.value = true;
      window.setTimeout(() => (shake.value = false), 420);
      input.value?.focus();
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="overlay-mask" @click.self="emit('close')">
    <div class="modal" :class="{ shake }" style="width: 400px">
      <div class="modal-head">
        <component :is="isEnabled ? Lock : KeyRound" :size="15" />
        <span class="modal-title">{{ isEnabled ? "解锁隐私安全空间" : "隐私空间尚未初始化" }}</span>
        <div style="flex: 1"></div>
        <button class="btn ghost sm" @click="emit('close')"><X :size="15" /></button>
      </div>

      <div class="modal-body">
        <template v-if="isEnabled">
          <div v-if="vault.hint" class="alert info" style="margin-bottom: 12px">
            <AlertTriangle :size="14" />
            <div>密码提示信息：{{ vault.hint }}</div>
          </div>

          <div class="field">
            <label class="label">安全主密码</label>
            <input
              ref="input"
              v-model="pw"
              class="input"
              type="password"
              placeholder="请输入安全空间主密码"
              @keyup.enter="submit"
            />
          </div>

          <div v-if="err" class="alert err">{{ err }}</div>
        </template>

        <div v-else class="alert warn">
          <AlertTriangle :size="14" />
          <div>
            隐私安全空间尚未初始化配置。请前往功能导航中的「隐私空间」设置主密码完成初始化，
            启用后系统将对指定影像资产实施端到端强加密保护。
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button v-if="isEnabled" class="btn primary" :disabled="busy" @click="submit">
          <Loader2 v-if="busy" :size="13" class="spin" />
          <Unlock v-else :size="13" />
          解锁
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shake {
  animation: shake 0.4s;
}
@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20% {
    transform: translateX(-9px);
  }
  40% {
    transform: translateX(8px);
  }
  60% {
    transform: translateX(-5px);
  }
  80% {
    transform: translateX(3px);
  }
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

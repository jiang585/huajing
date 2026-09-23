/**
 * Node 下跑 store 测试的最小浏览器垫片。
 *
 * store 里用到 `window.setTimeout` / `setInterval` 做轮询与防抖。测试环境没有 DOM，
 * 这里补一个同名对象；同时把长延时压短 —— 任务引擎的轮询是 1.2 秒一次，
 * 真实等待会让回归测试慢到没人愿意跑。
 */

const MAX_DELAY_MS = 20;

function clamp(ms?: number): number | undefined {
  if (typeof ms !== "number" || ms <= MAX_DELAY_MS) return ms;
  return MAX_DELAY_MS;
}

const timers = {
  setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    setTimeout(fn, clamp(ms), ...args),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    setInterval(fn, clamp(ms), ...args),
  clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
};

const shim = {
  ...timers,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const globals = globalThis as unknown as Record<string, unknown>;
if (typeof globals.window === "undefined") {
  globals.window = shim;
}

/** 等到条件成立（或超时）。用于等异步流程推进到某个可观察点。 */
export async function waitFor(condition: () => boolean, label = "条件", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`等待「${label}」超时`);
}

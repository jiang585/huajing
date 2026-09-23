/**
 * Bug 2 回归：启动后端与视频能力检测的竞态。
 *
 * 旧实现里 `startBackend()` 遇到"已经在启动"就直接返回，第二个调用者不会等第一次
 * 完成；`refreshVideoCapability()` 同理，遇到"正在检测"直接返回 —— 生成流程因此
 * 可能拿到空的能力值，报出「工作流未就绪」，其实只是没等那次检测做完。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { backend, busy, startBackend } from "../../src/stores/backend";
import {
  ensureVideoCapability,
  refreshVideoCapability,
  runVideo,
  videoCapability,
  videoChecking,
  videoError,
  videoForm,
} from "../../src/stores/video";
import { job } from "../../src/stores/job";
import {
  CAPS,
  STATUS,
  completedRecord,
  count,
  defer,
  handlers,
  resetFakes,
} from "./harness/fakeTauri";
import { settleJob } from "./harness/settle";
import { waitFor } from "./harness/env";

afterEach(async () => {
  await settleJob();
});

beforeEach(() => {
  resetFakes();
  backend.running = false;
  job.running = false;
  job.preparing = false;
  job.error = null;
  job.warning = "";
  videoCapability.value = null;
  videoChecking.value = false;
  videoError.value = "";
  videoForm.firstFrame = null;
  videoForm.prompt = "";
});

describe("启动后端", () => {
  it("并发调用只发一次启动请求，所有人都等到真正就绪", async () => {
    const gate = defer<typeof STATUS>();
    handlers.comfyStart = (() => gate.promise) as never;

    const first = startBackend();
    const second = startBackend();
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });

    assert.equal(count("comfyStart"), 1, "启动请求应当只有一个");
    assert.equal(busy.starting, true);
    assert.equal(backend.running, false, "还没就绪时不能报告 running");

    // 让微任务跑完：第二个调用者绝不能在这时候就已经返回 ——
    // 旧实现遇到"正在启动"就直接返回，调用方会拿着还没监听 8188 的后端继续提交，
    // 然后收到「ComfyUI 尚未运行」这种自相矛盾的报错。
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(secondDone, false, "后端还没就绪，第二个调用者就返回了");

    gate.resolve({ ...STATUS });
    await Promise.all([first, second]);

    assert.equal(backend.running, true, "等待的调用者应当拿到已就绪的状态");
    assert.equal(count("comfyStart"), 1);
    assert.equal(busy.starting, false);
  });

  it("启动失败时所有调用者都拿到原因，之后可以重试", async () => {
    handlers.comfyStart = (() => Promise.reject(new Error("找不到 Python 解释器"))) as never;
    const first = startBackend();
    const second = startBackend();

    // 同时挂上处理函数：两个调用者共用一个会失败的 Promise，
    // 晚处理的那次会被 Node 当成未捕获拒绝而判测试失败
    const settled = await Promise.allSettled([first, second]);
    assert.equal(settled[0].status, "rejected");
    assert.equal(settled[1].status, "rejected");
    assert.match(String((settled[0] as PromiseRejectedResult).reason), /找不到 Python 解释器/);
    assert.match(String((settled[1] as PromiseRejectedResult).reason), /找不到 Python 解释器/);
    assert.equal(busy.starting, false, "失败后必须松开启动锁");

    // 共享的失败 Promise 不能一直留着，重试要能重新发起
    handlers.comfyStart = (async () => ({ ...STATUS })) as never;
    await startBackend();
    assert.equal(count("comfyStart"), 2);
  });
});

describe("视频能力检测", () => {
  it("自动检测与生成前检测共用同一次调用", async () => {
    backend.running = true;
    const gate = defer<typeof CAPS>();
    handlers.comfyVideoCapabilities = (() => gate.promise) as never;

    const auto = refreshVideoCapability();
    const beforeRun = ensureVideoCapability();
    assert.equal(count("comfyVideoCapabilities"), 1, "两次检测应当合并成一次");

    gate.resolve({ ...CAPS });
    await Promise.all([auto, beforeRun]);

    assert.equal(videoCapability.value?.ready, true);
    assert.equal(videoError.value, "");
    assert.equal(videoChecking.value, false);
  });

  it("检测进行中提交视频：等检测结果，而不是报「工作流未就绪」", async () => {
    backend.running = true;
    const gate = defer<typeof CAPS>();
    handlers.comfyVideoCapabilities = (() => gate.promise) as never;
    handlers.fetchHistory = (async () => completedRecord("video")) as never;

    videoForm.firstFrame = "G:\\refs\\frame.png";
    videoForm.prompt = "镜头缓慢推近";
    videoForm.length = 124;

    const auto = refreshVideoCapability();
    const submission = runVideo();
    assert.equal(count("comfyVideoCapabilities"), 1);

    gate.resolve({ ...CAPS });
    await auto;
    await submission;

    assert.equal(videoError.value, "", `不该报错：${videoError.value}`);
    assert.equal(count("queuePrompt"), 1, "视频任务应当被提交");
    assert.equal(job.preparing, false, "准备阶段结束后要松开引擎锁");
  });

  it("后端没起来时生成会先启动后端再检测", async () => {
    handlers.comfyStart = (async () => ({ ...STATUS })) as never;
    handlers.fetchHistory = (async () => completedRecord("video")) as never;
    videoForm.firstFrame = "G:\\refs\\frame.png";
    videoForm.prompt = "风吹动发梢";

    await runVideo();

    assert.equal(count("comfyStart"), 1, "应当先启动后端");
    assert.equal(count("comfyVideoCapabilities"), 1, "启动后再检测能力");
    assert.equal(count("queuePrompt"), 1);
  });

  it("能力未就绪时给出明确原因", async () => {
    backend.running = true;
    handlers.comfyVideoCapabilities = (async () => ({
      ...CAPS,
      ready: false,
      missing_models: ["minimax_h3_audio_vae_fp32.safetensors"],
      message: "缺少模型：minimax_h3_audio_vae_fp32.safetensors",
    })) as never;
    videoForm.firstFrame = "G:\\refs\\frame.png";
    videoForm.prompt = "镜头缓慢推近";

    await assert.rejects(() => runVideo(), /缺少模型/);
    assert.equal(count("queuePrompt"), 0);
    assert.equal(job.preparing, false);
  });
});

describe("检测结果缓存", () => {
  it("检测完成后再次调用会重新检测（不复用过期结果）", async () => {
    backend.running = true;
    await refreshVideoCapability();
    assert.equal(count("comfyVideoCapabilities"), 1);
    await waitFor(() => !videoChecking.value, "检测结束");
    await refreshVideoCapability();
    assert.equal(count("comfyVideoCapabilities"), 2);
  });
});

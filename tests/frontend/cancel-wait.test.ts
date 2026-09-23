/**
 * Bug 5 回归：取消必须等到任务真的停了才解锁。
 *
 * `/queue delete` 或定向 `/interrupt` 返回成功，只说明请求递过去了，
 * ComfyUI 可能仍在清理采样、写文件。此时如果前端立刻松开运行锁，用户再提交一次
 * 就会两个任务叠在一起抢显存。Rust 侧已经在确认任务离开队列后才返回，
 * 这里钉住前端：拿到取消结果之前绝不解锁；取消没确认成功就继续跟踪原任务。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { backend } from "../../src/stores/backend";
import { CANCELED } from "../../src/api/jobCore";
import { cancelJob, generate, job, type GenerateRequest, type GenerateResult } from "../../src/stores/job";
import {
  completedRecord,
  count,
  defer,
  handlers,
  interruptedRecord,
  last,
  resetFakes,
} from "./harness/fakeTauri";
import { settleJob } from "./harness/settle";
import { waitFor } from "./harness/env";

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    mode: "txt2img",
    prompt: "一只猫坐在窗台上",
    negative: "",
    refPaths: [],
    model: "qwen",
    size: "1024x1024",
    resolution: 1024,
    steps: 20,
    cfg: 4,
    seed: 999,
    sampler: "euler",
    scheduler: "simple",
    ...overrides,
  };
}

afterEach(async () => {
  await settleJob();
});

beforeEach(() => {
  resetFakes();
  backend.running = true;
  job.running = false;
  job.preparing = false;
  job.warning = "";
  job.error = null;
});

/**
 * 起一个永远"还在跑"的任务。
 *
 * 注意返回的是任务 Promise 本身，不能写成 `return run`（async 函数会把 Promise 拆开，
 * 于是调用方的 await 会一直等到任务结束）。
 */
function beginRunningJob(): Promise<GenerateResult> {
  handlers.fetchHistory = (async () => null) as never;
  return generate(request());
}

/** 等到任务已经提交并进入结果轮询 */
async function waitUntilPolling() {
  await waitFor(() => count("queuePrompt") === 1, "任务提交");
  await waitFor(() => count("fetchHistory") >= 1, "进入结果轮询");
}

describe("取消确认", () => {
  it("确认返回之前保持运行锁", async () => {
    const run = beginRunningJob();
    await waitUntilPolling();
    const gate = defer<string>();
    handlers.comfyCancelPrompt = (() => gate.promise) as never;

    const canceling = cancelJob();
    await waitFor(() => count("comfyCancelPrompt") === 1, "发出取消请求");

    assert.equal(job.running, true, "取消还没确认就解锁了运行状态");
    assert.equal(job.canceling, true);
    assert.equal(last("comfyCancelPrompt")?.[0], "prompt-test", "取消要针对本次 prompt");

    gate.resolve("interrupted");
    await canceling;

    const result = await run;
    assert.equal(result.ok, false);
    assert.equal(result.error, CANCELED);
    assert.equal(job.running, false);
    assert.equal(job.canceling, false);
  });

  it("确认后按中断记录收尾，不保存半成品", async () => {
    const run = beginRunningJob();
    await waitUntilPolling();
    handlers.comfyCancelPrompt = (async () => "interrupted") as never;
    // 中断之后 ComfyUI 会在历史里记一条 execution_interrupted
    handlers.fetchHistory = (async () => interruptedRecord()) as never;

    await cancelJob();
    const result = await run;

    assert.equal(result.error, CANCELED);
    assert.equal(count("fetchImage"), 0);
    assert.equal(count("saveDataUrl"), 0);
  });

  it("取消没确认成功时继续跟踪原任务，并如实报告最终结果", async () => {
    const run = beginRunningJob();
    await waitUntilPolling();
    handlers.comfyCancelPrompt = (async () => {
      throw new Error("已发出取消请求，但 90 秒内任务仍在 ComfyUI 队列中。");
    }) as never;
    let polls = 0;
    handlers.fetchHistory = (async () => (++polls >= 2 ? completedRecord("image") : null)) as never;

    await cancelJob();

    assert.match(job.warning, /取消未确认/, "要让用户知道取消没有生效");
    assert.equal(job.canceling, false, "取消标记要松开，否则进度事件会被忽略");
    assert.equal(job.running, true, "任务还在跑，运行锁不能放");

    const result = await run;
    assert.equal(result.ok, true, "取消没成功时应当继续等任务完成并保存结果");
    assert.equal(result.images.length, 1);
  });

  it("没有提交成功（还没有 prompt id）时取消只标记，不误发请求", async () => {
    handlers.fetchHistory = (async () => null) as never;
    // 用带参考图的模式：上传阶段就发生在拿到 prompt id 之前
    const run = generate(request({ mode: "edit", refPaths: ["G:\\refs\\a.png"] }));
    handlers.uploadImage = (async () => {
      await cancelJob();
      return { name: "ref.png", subfolder: "", kind: "input" };
    }) as never;

    const result = await run;
    assert.equal(result.error, CANCELED);
    assert.equal(count("comfyCancelPrompt"), 0, "没有 prompt id 就不该发定向取消");
  });
});

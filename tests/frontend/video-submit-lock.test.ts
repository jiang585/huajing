/**
 * Bug 3 回归：准备阶段切页后重复提交。
 *
 * 准备阶段（启动后端、检测能力、上传首尾帧、提交 prompt）原来靠组件内的 ref 加锁。
 * 用户在这期间切到图库或历史，组件卸载、锁一起消失，而 `job.running` 还没置位，
 * 回来再点一次就能起第二个任务 —— 两个任务抢同一块显存。
 * 现在锁在 store 上，覆盖整个准备过程。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { backend } from "../../src/stores/backend";
import { beginJobPrepare, engineBusy, job } from "../../src/stores/job";
import { runVideo, videoError, videoForm } from "../../src/stores/video";
import { CAPS, STATUS, completedRecord, count, defer, handlers, resetFakes } from "./harness/fakeTauri";
import { settleJob } from "./harness/settle";

afterEach(async () => {
  await settleJob();
});

beforeEach(() => {
  resetFakes();
  backend.running = true;
  job.running = false;
  job.preparing = false;
  job.error = null;
  videoError.value = "";
  videoForm.firstFrame = "G:\\refs\\frame.png";
  videoForm.prompt = "镜头缓慢推近";
});

describe("store 级提交锁", () => {
  it("准备阶段（后端启动未返回）再次提交会被拒绝", async () => {
    backend.running = false;
    const gate = defer<typeof STATUS>();
    handlers.comfyStart = (() => gate.promise) as never;

    const first = runVideo();
    assert.equal(job.preparing, true, "准备阶段必须占用引擎");
    assert.equal(engineBusy(), true);
    assert.equal(job.running, false);

    // 组件卸载后再点一次生成 —— 等价于直接再调一次 runVideo
    await assert.rejects(() => runVideo(), /准备中/);
    assert.equal(count("comfyStart"), 1, "第二次提交不该再发起一次启动");

    gate.resolve({ ...STATUS });
    handlers.fetchHistory = (async () => completedRecord("video")) as never;
    await first;

    assert.equal(count("queuePrompt"), 1, "最终只应提交一个任务");
    assert.equal(job.preparing, false);
    assert.equal(job.running, false);
  });

  it("准备阶段图片任务也被挡住（两边共用引擎）", async () => {
    const release = beginJobPrepare();
    assert.equal(engineBusy(), true, "参数表单要能看出引擎被占用");
    release();
    assert.equal(job.preparing, false);
    assert.equal(engineBusy(), false);
  });

  it("准备失败后锁会松开，可以重新提交", async () => {
    handlers.comfyVideoCapabilities = (async () => ({
      ...CAPS,
      ready: false,
      message: "缺少节点：MiniMaxH3TurboSampler",
    })) as never;

    await assert.rejects(() => runVideo(), /缺少节点/);
    assert.equal(job.preparing, false, "失败也要释放引擎锁");

    handlers.comfyVideoCapabilities = (async () => ({ ...CAPS })) as never;
    handlers.fetchHistory = (async () => completedRecord("video")) as never;
    await runVideo();
    assert.equal(count("queuePrompt"), 1);
  });

  it("嵌套占用的计数是平衡的（release 幂等）", () => {
    const outer = beginJobPrepare();
    const inner = beginJobPrepare();
    assert.equal(job.preparing, true);
    inner();
    assert.equal(job.preparing, true, "还有一层没释放");
    inner();
    assert.equal(job.preparing, true, "重复释放不该把锁减成负数");
    outer();
    assert.equal(job.preparing, false);
  });
});

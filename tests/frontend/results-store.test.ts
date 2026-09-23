/**
 * Bug 4 回归：任务运行期间切页，结果要照样进结果面板。
 *
 * 原来图片任务完成后由参数表单组件 `emit('done')` 写入当前页面的 `lastResults`。
 * 用户在任务跑的时候切到图库或历史，组件已卸载，事件没有接收者 —— 文件保存了，
 * 回到生成页结果面板却是空的。现在由任务 store 在落盘成功后直接写入。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { backend } from "../../src/stores/backend";
import { job, generate, type GenerateRequest } from "../../src/stores/job";
import { lastResults, setLastResults } from "../../src/stores/results";
import { videoResults } from "../../src/stores/video";
import { CAPS, completedRecord, count, handlers, resetFakes } from "./harness/fakeTauri";
import { settleJob } from "./harness/settle";

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
    seed: 777,
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
  for (const mode of Object.keys(lastResults) as (keyof typeof lastResults)[]) {
    lastResults[mode] = [];
  }
});

describe("结果写入 store", () => {
  it("没有组件监听 done 事件，结果也进面板", async () => {
    handlers.fetchHistory = (async () => completedRecord("image")) as never;

    const result = await generate(request());

    assert.equal(result.ok, true, `生成失败：${result.error ?? ""}`);
    assert.equal(result.images.length, 1);
    assert.deepEqual(lastResults.txt2img, result.images, "结果没有写进按模式分组的状态");
  });

  it("视频结果与图片结果共用同一张表（视频面板读得到）", async () => {
    handlers.fetchHistory = (async () => completedRecord("video")) as never;

    const result = await generate(
      request({
        mode: "video",
        refPaths: ["G:\\refs\\frame.png"],
        size: "864x480",
        sampler: "minimax_h3_turbo",
        steps: 12,
        cfg: 1,
        video: { length: 124, capabilities: CAPS },
      }),
    );

    assert.equal(result.ok, true, `生成失败：${result.error ?? ""}`);
    assert.deepEqual([...videoResults.value], result.images);
    assert.deepEqual([...lastResults.video], result.images);
  });

  it("各模式互不覆盖", async () => {
    setLastResults("txt2img", ["G:\\out\\a.png"]);
    handlers.fetchHistory = (async () => completedRecord("image")) as never;

    await generate(request({ mode: "edit", refPaths: ["G:\\refs\\a.png"] }));

    assert.deepEqual(lastResults.txt2img, ["G:\\out\\a.png"], "别的模式的结果被冲掉了");
    assert.equal(lastResults.edit.length, 1);
  });

  it("取消且没有产出时，不会把上一次的结果清空", async () => {
    setLastResults("txt2img", ["G:\\out\\previous.png"]);
    handlers.fetchHistory = (async () => ({
      status: { completed: false, status_str: "error", messages: [["execution_interrupted", {}]] },
      outputs: {},
    })) as never;

    const result = await generate(request());

    assert.equal(result.ok, false);
    assert.deepEqual(lastResults.txt2img, ["G:\\out\\previous.png"], "取消把上次的成果抹掉了");
    assert.equal(count("fetchImage"), 0);
  });

  it("部分保存的结果也要显示（多图任务中途失败）", async () => {
    handlers.fetchHistory = (async () => ({
      status: { completed: true, status_str: "success" },
      outputs: {
        9: {
          images: [
            { filename: "a.png", subfolder: "画境/文生图", type: "output" },
            { filename: "b.png", subfolder: "画境/文生图", type: "output" },
          ],
        },
      },
    })) as never;
    let saved = 0;
    handlers.fetchImage = (async (filename: string) => {
      if (++saved === 2) throw new Error("磁盘写入失败");
      return `G:\\画境输出\\${filename}`;
    }) as never;

    const result = await generate(request());

    assert.equal(result.ok, false);
    assert.deepEqual(result.images, ["G:\\画境输出\\a.png"]);
    assert.deepEqual(lastResults.txt2img, ["G:\\画境输出\\a.png"], "已经存下来的那张要能看到");
  });
});

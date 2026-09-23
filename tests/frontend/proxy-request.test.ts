/**
 * Bug 1 回归：请求里带着 Vue 响应式代理时，首次生成会直接失败。
 *
 * 实际复现过的报错：`DataCloneError: #<Object> could not be cloned.`
 * 原因是 `generate()` 用 `structuredClone(request)` 固定参数，而视频表单把
 * `videoCapability.value`（ref 取出来的响应式 Proxy）直接放进了请求；
 * 历史恢复出来的 `upscaleOverride` 同理。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { reactive, ref } from "vue";

import { snapshotVideoOptions } from "../../src/api/video";
import type { VideoCapabilities } from "../../src/api/tauri";
import { backend } from "../../src/stores/backend";
import { generate, snapshotRequest, type GenerateRequest } from "../../src/stores/job";
import { CAPS, completedRecord, count, handlers, last, resetFakes } from "./harness/fakeTauri";
import { settleJob } from "./harness/settle";

function imageRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
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
    seed: 12345,
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
  handlers.buildOutputPath = (async (...args: unknown[]) =>
    `G:\\画境输出\\out-${(args[1] as string) ?? "x"}-${count("buildOutputPath")}.png`) as never;
  handlers.fetchHistory = (async () => completedRecord("image")) as never;
});

describe("请求快照", () => {
  it("响应式代理不能交给 structuredClone —— 这正是要防住的情况", () => {
    const capability = ref<VideoCapabilities>({ ...CAPS });
    assert.throws(
      () => structuredClone(capability.value),
      /could not be cloned|DataCloneError/,
      "如果这条不再抛错，说明复现前提变了，请复查快照是否还有必要",
    );
  });

  it("把响应式请求摊平成只含普通值的快照", () => {
    const request = reactive({
      ...imageRequest({ mode: "multiref2k" }),
      refPaths: ["G:\\refs\\a.png", "G:\\refs\\b.png"],
      upscaleOverride: { prompt: "masterpiece", steps: 8, denoise: 0.4 },
      video: undefined,
    });

    const snapshot = snapshotRequest(request);

    assert.doesNotThrow(() => structuredClone(snapshot), "快照必须能被结构化克隆");
    assert.deepEqual(snapshot.refPaths, ["G:\\refs\\a.png", "G:\\refs\\b.png"]);
    assert.deepEqual(snapshot.upscaleOverride, { prompt: "masterpiece", steps: 8, denoise: 0.4 });
    assert.equal(snapshot.mode, "multiref2k");
    // 快照与表单解耦：之后再改表单，不影响已经提交的这次任务
    request.prompt = "改过的提示词";
    assert.equal(snapshot.prompt, "一只猫坐在窗台上");
  });

  it("视频能力对象（含嵌套 models）被完整摊平", () => {
    const capability = reactive({
      ...CAPS,
      missing_models: ["a.safetensors"],
      models: { ...CAPS.models },
    });

    const snapshot = snapshotVideoOptions({ length: 124, capabilities: capability });

    assert.doesNotThrow(() => structuredClone(snapshot));
    assert.equal(snapshot.capabilities.models.unet, CAPS.models.unet);
    assert.equal(snapshot.capabilities.supports_last_frame, true);
    assert.deepEqual(snapshot.capabilities.missing_models, ["a.safetensors"]);
  });

  it("缺字段的能力对象按「不支持」处理，而不是发出一个坏图", () => {
    const partial = { ready: true } as unknown as VideoCapabilities;
    const snapshot = snapshotVideoOptions({ length: 124, capabilities: partial });
    assert.equal(snapshot.capabilities.supports_last_frame, false);
    assert.equal(snapshot.capabilities.save_video_dynamic, false);
    assert.equal(snapshot.capabilities.models.unet, "");
  });
});

describe("带代理的请求真的能提交", () => {
  it("视频任务：能力值来自 ref，提交时要拿到普通值而不是 Proxy", async () => {
    const capability = ref<VideoCapabilities>({ ...CAPS, models: { ...CAPS.models } });
    handlers.fetchHistory = (async () => completedRecord("video")) as never;

    const result = await generate(
      imageRequest({
        mode: "video",
        refPaths: ["G:\\refs\\frame.png"],
        size: "864x480",
        sampler: "minimax_h3_turbo",
        steps: 12,
        cfg: 1,
        video: { length: 124, capabilities: capability.value },
      }),
    );

    assert.equal(result.ok, true, `生成失败：${result.error ?? ""}`);
    assert.equal(count("queuePrompt"), 1);
    const graph = last("queuePrompt")?.[0] as Record<string, { inputs: Record<string, unknown> }>;
    assert.equal(graph["1"].inputs.unet_name, CAPS.models.unet, "能力值没有传进工作流图");
    assert.doesNotThrow(() => structuredClone(graph), "提交给 Rust 的图里仍然有不可克隆的对象");
    assert.equal(count("fetchVideo"), 1);
  });

  it("历史恢复的 2K 参数（响应式对象）同样能提交", async () => {
    const request = reactive(imageRequest({ mode: "multiref2k" }));
    // 多参考图 + 2K 有两个必填槽位
    request.refPaths = ["G:\\refs\\a.png", "G:\\refs\\b.png"];
    request.upscaleOverride = reactive({ prompt: "masterpiece", steps: 8, denoise: 0.35 });

    const result = await generate(request);
    assert.equal(result.ok, true, `生成失败：${result.error ?? ""}`);
    assert.equal(count("queuePrompt"), 1);
  });
});

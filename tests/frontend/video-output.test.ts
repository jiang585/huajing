/**
 * 视频产出的识别。
 *
 * 这里用的是本机 ComfyUI 真实跑出来的记录形状：`SaveVideo` 节点把 mp4 放在 `images`
 * 字段里（还带一个 `animated: [true]`），并不是 `videos`。任务引擎必须能认出来，
 * 否则视频生成完了却报"任务结束但没有可保存的视频"。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractError, extractOutputs, recordComplete } from "../../src/api/jobCore";

/** 直接抄自本机 ComfyUI 的 /history 响应（864×480、124 帧）。 */
const REAL_VIDEO_RECORD = {
  status: { completed: true, status_str: "success", messages: [] },
  outputs: {
    "18": {
      images: [{ filename: "huajing_live_video_00001_.mp4", subfolder: "画境", type: "output" }],
      animated: [true],
    },
  },
};

const REAL_IMAGE_RECORD = {
  status: { completed: true, status_str: "success", messages: [] },
  outputs: {
    "9": { images: [{ filename: "画境_00001_.png", subfolder: "画境/文生图", type: "output" }] },
  },
};

describe("视频产出识别", () => {
  it("SaveVideo 把 mp4 放在 images 字段里也能认出来", () => {
    assert.deepEqual(extractOutputs(REAL_VIDEO_RECORD, true), [
      { filename: "huajing_live_video_00001_.mp4", subfolder: "画境", type: "output" },
    ]);
    assert.equal(recordComplete(REAL_VIDEO_RECORD), true);
    assert.equal(extractError(REAL_VIDEO_RECORD), null);
  });

  it("图片记录不会被当成视频", () => {
    assert.deepEqual(extractOutputs(REAL_IMAGE_RECORD, true), []);
    assert.deepEqual(extractOutputs(REAL_IMAGE_RECORD, false), [
      { filename: "画境_00001_.png", subfolder: "画境/文生图", type: "output" },
    ]);
  });

  it("视频记录不会被当成图片", () => {
    assert.deepEqual(extractOutputs(REAL_VIDEO_RECORD, false), []);
  });

  it("同一节点里图片和视频混在一起时各取所需", () => {
    const mixed = {
      status: { completed: true, status_str: "success" },
      outputs: {
        "18": {
          images: [
            { filename: "preview.png", subfolder: "", type: "output" },
            { filename: "clip.webm", subfolder: "", type: "output" },
          ],
        },
      },
    };
    assert.deepEqual(extractOutputs(mixed, true), [
      { filename: "clip.webm", subfolder: "", type: "output" },
    ]);
    assert.deepEqual(extractOutputs(mixed, false), [
      { filename: "preview.png", subfolder: "", type: "output" },
    ]);
  });

  it("重复的输出只保存一次", () => {
    const duplicated = {
      status: { completed: true, status_str: "success" },
      outputs: {
        "18": { images: [{ filename: "a.mp4", subfolder: "画境", type: "output" }] },
        "19": { images: [{ filename: "a.mp4", subfolder: "画境", type: "output" }] },
      },
    };
    assert.equal(extractOutputs(duplicated, true).length, 1);
  });
});

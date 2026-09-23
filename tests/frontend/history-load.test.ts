/**
 * 历史记录首次加载：读不到或内容损坏时按空历史处理。
 *
 * 每个文件跑在独立进程里，历史 store 的「已加载」标记是模块级的，
 * 所以"首次加载"的不同情形要各自单独一个文件。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { history, loadHistory, pushHistory } from "../../src/stores/history";
import { handlers } from "./harness/fakeTauri";

describe("历史首次加载", () => {
  it("文件损坏（不是数组）时用空历史，随后写入仍然正常", async () => {
    handlers.storeLoad = (async () => ({ oops: "不是历史数组" })) as never;

    await loadHistory();
    assert.deepEqual(history.value, [], "损坏的内容不该被当成历史");

    await pushHistory({
      id: "after-corrupt",
      mode: "txt2img",
      prompt: "提示词",
      negative: "",
      params: {},
      images: [],
      createdAt: 1,
      durationMs: 1,
      status: "failed",
    });
    assert.deepEqual(history.value.map((e) => e.id), ["after-corrupt"], "损坏的文件应当被新记录覆盖");
  });
});

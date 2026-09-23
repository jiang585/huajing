/**
 * 历史记录首次加载：从磁盘读回上次的记录，且只读一次。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { history, loadHistory, type HistoryEntry } from "../../src/stores/history";
import { count, handlers } from "./harness/fakeTauri";

function entry(id: string): HistoryEntry {
  return {
    id,
    mode: "txt2img",
    prompt: `提示词 ${id}`,
    negative: "",
    params: {},
    images: [`G:\out\${id}.png`],
    createdAt: 1,
    durationMs: 1,
    status: "done",
  };
}

describe("历史恢复", () => {
  it("启动时读回上次的历史，并且只读一次", async () => {
    handlers.storeLoad = (async (name: string) =>
      name === "history" ? [entry("saved")] : null) as never;

    await loadHistory();
    assert.deepEqual(history.value.map((e) => e.id), ["saved"]);

    await loadHistory();
    assert.equal(count("storeLoad"), 1, "第二次调用应当走内存，不再读盘");
  });
});

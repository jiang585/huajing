/**
 * Bug 11 回归：隐私空间移入必须走历史的串行队列。
 *
 * 旧实现直接改 `history.value` 再调 `saveHistory()`。任务完成时的 `pushHistory()`
 * 可能正在读改同一份 JSON，两条写入交错就会互相覆盖 —— 历史记录凭空少一条。
 */

import "./harness/env";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  history,
  loadHistory,
  loadHistory as reloadHistory,
  pushHistory,
  removeHistoryPaths,
  type HistoryEntry,
} from "../../src/stores/history";
import { count, handlers, last, resetFakes } from "./harness/fakeTauri";

function entry(id: string, images: string[], status: HistoryEntry["status"] = "done"): HistoryEntry {
  return {
    id,
    mode: "txt2img",
    prompt: `提示词 ${id}`,
    negative: "",
    params: {},
    images,
    createdAt: Date.now(),
    durationMs: 1000,
    status,
  };
}

beforeEach(async () => {
  resetFakes();
  history.value = [];
  handlers.storeLoad = (async () => []) as never;
  await reloadHistory();
  resetFakes();
});

describe("历史串行队列", () => {
  it("生成完成与移入隐私空间并发时不互相覆盖", async () => {
    await pushHistory(entry("old", ["G:\\out\\a.png", "G:\\out\\b.png"]));

    // 并发的两条写入：新任务完成 + 把 a.png 移进隐私空间
    await Promise.all([
      pushHistory(entry("new", ["G:\\out\\c.png"])),
      removeHistoryPaths(["G:\\out\\a.png"]),
    ]);

    const ids = history.value.map((e) => e.id);
    assert.deepEqual(ids, ["new", "old"], "有一方的写入被另一方覆盖了");
    const old = history.value.find((e) => e.id === "old");
    assert.deepEqual(old?.images, ["G:\\out\\b.png"], "只该摘掉被移走的那一张");

    // 落盘的内容必须与内存一致（较旧的快照不能盖掉新的）
    const stored = last("storeSave")?.[1] as HistoryEntry[];
    assert.deepEqual(stored.map((e) => e.id), ids);
    assert.deepEqual(stored.find((e) => e.id === "old")?.images, ["G:\\out\\b.png"]);
  });

  it("图片被搬空的条目整条移除", async () => {
    await pushHistory(entry("only", ["G:\\out\\a.png"]));
    await removeHistoryPaths(["G:\\out\\a.png"]);
    assert.deepEqual(history.value.map((e) => e.id), []);
  });

  it("失败记录没有文件，不该被「搬空」规则误删", async () => {
    await pushHistory(entry("failed", [], "failed"));
    await removeHistoryPaths(["G:\\out\\whatever.png"]);
    assert.deepEqual(history.value.map((e) => e.id), ["failed"]);
  });

  it("连续并发写入不会丢失条目，也不会超过上限", async () => {
    handlers.storeLoad = (async () => []) as never;
    await Promise.all(Array.from({ length: 20 }, (_, i) => pushHistory(entry(`e${i}`, [`G:\\out\\${i}.png`]))));
    assert.equal(history.value.length, 20, "并发写入丢了条目");
    assert.equal(count("storeSave"), 20);

    const ids = new Set(history.value.map((e) => e.id));
    assert.equal(ids.size, 20, "出现了重复条目");
  });
});

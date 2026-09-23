/**
 * 用例收尾：把可能还在跑的任务引擎停干净。
 *
 * 任务引擎会一直轮询历史直到任务结束或取消。用例中途断言失败时，这个轮询循环还在跑，
 * Node 的测试进程就不会退出（`node --test` 会一直挂着）。每个用例结束都调一次这里，
 * 保证不留后台任务。
 */

import { cancelJob, job } from "../../../src/stores/job";
import { interruptedRecord, handlers } from "./fakeTauri";
import { waitFor } from "./env";

export async function settleJob() {
  if (!job.running && !job.preparing) return;
  // 让主循环立刻拿到"已中断"的结论，它会在下一轮自行收尾
  handlers.fetchHistory = (async () => interruptedRecord()) as never;
  handlers.comfyCancelPrompt = (async () => "interrupted") as never;
  try {
    await cancelJob();
  } catch {
    /* 取消失败也要继续等收尾 */
  }
  try {
    await waitFor(() => !job.running && !job.preparing, "任务收尾", 3000);
  } catch {
    job.running = false;
    job.preparing = false;
  }
}

/**
 * 各模式最近一次生成的结果。
 *
 * 单独放一个模块，是为了让「任务引擎」和「界面」都能写它，而两边不必互相 import：
 * 结果由任务引擎落盘成功后直接写入，不再经过组件的 `done` 事件 —— 用户中途切到
 * 图库或历史时组件会被卸载，事件没有接收者，成果就只在磁盘上、面板里空着。
 */

import { reactive } from "vue";
import { MODE_ORDER, type ModeId } from "../api/graphs";

export const lastResults = reactive(
  Object.fromEntries(MODE_ORDER.map((m) => [m, [] as string[]])) as Record<ModeId, string[]>,
);

/**
 * 写入某模式的结果。空数组直接忽略：取消或失败时 `saved` 可能为空，
 * 那不该把上一次的结果从面板上抹掉。
 */
export function setLastResults(mode: ModeId, images: string[]) {
  if (images.length === 0) return;
  lastResults[mode] = [...images];
}

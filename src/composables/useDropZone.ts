/**
 * 拖拽落图路由。
 *
 * Tauri 的窗口默认会拦截系统拖放（dragDropEnabled），HTML5 的 drop 事件拿不到
 * 本地路径，所以只能监听 Tauri 的 drag-drop 事件。代价是事件是全局的，得自己
 * 判断鼠标落在了哪个图槽上 —— 这里用 elementFromPoint 做命中测试。
 */

import { onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface DropZone {
  /** 元素上的 data-drop-zone 值 */
  key: string;
  onDrop: (paths: string[]) => void;
}

const zones = new Map<string, DropZone>();
/** 当前鼠标悬停的槽位 key，用于高亮 */
export const hoverZone = ref<string | null>(null);
/** 是否正有文件拖在窗口上方（用于显示全局遮罩） */
export const dragging = ref(false);

let inited = false;

/** 在组件里注册一个落图区，返回注销函数 */
export function useDropZone(key: string, onDrop: (paths: string[]) => void) {
  const register = () => zones.set(key, { key, onDrop });
  const unregister = () => zones.delete(key);

  onMounted(register);
  onBeforeUnmount(unregister);
  // 同一页面内 key 可能变（例如槽位复用），注册时再补一次
  register();

  return { unregister };
}

function zoneAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const holder = el?.closest("[data-drop-zone]") as HTMLElement | null;
  return holder?.dataset.dropZone ?? null;
}

/** 在 App 启动时调一次，挂上全局拖放监听 */
export async function initDropRouting() {
  if (inited) return;
  inited = true;

  const webview = getCurrentWebview();
  await webview.onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "leave") {
      hoverZone.value = null;
      dragging.value = false;
      return;
    }
    if (p.type === "enter" || p.type === "over") {
      dragging.value = true;
      const pos = p.position;
      // 事件给的是物理像素，elementFromPoint 要逻辑像素
      const dpr = window.devicePixelRatio || 1;
      hoverZone.value = zoneAt(pos.x / dpr, pos.y / dpr);
      return;
    }
    if (p.type === "drop") {
      const pos = p.position;
      const dpr = window.devicePixelRatio || 1;
      const key = zoneAt(pos.x / dpr, pos.y / dpr);
      dragging.value = false;
      hoverZone.value = null;
      if (!key) return;
      const zone = zones.get(key);
      if (!zone) return;
      // 只接图片，避免用户把文件夹或视频拖进来
      const imgs = p.paths.filter((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f));
      if (imgs.length > 0) zone.onDrop(imgs);
    }
  });
}

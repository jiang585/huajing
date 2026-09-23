<script setup lang="ts">
/**
 * 画面标注编辑器。
 *
 * 标记是**直接画进图片**的，不是另存一层矢量数据 —— 送进模型的就是你眼睛看到的
 * 同一张图，不会出现"我以为标了但模型没看到"的偏差。
 *
 * 每笔都先描一层半透明黑边再画彩色线，这样在亮背景和暗背景上都看得清。
 */

import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  X,
  Undo2,
  Eraser,
  Check,
  Loader2,
  Pencil,
  Circle as CircleIcon,
  Square as SquareIcon,
  MoveUpRight,
  Info,
} from "lucide-vue-next";
import { fileUrl, buildOutputPath, saveDataUrl, pruneDir } from "../api/tauri";
import { settings } from "../stores/settings";

const props = defineProps<{
  /** 原图本地路径 */
  src: string;
  /** 槽位名称，标题里显示 */
  label: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved", path: string): void;
  (e: "toast", msg: string): void;
}>();

type Tool = "pen" | "ellipse" | "rect" | "arrow";

interface Stroke {
  tool: Tool;
  color: string;
  width: number;
  /** 画笔存全部轨迹点；其余工具只用到首尾两点 */
  points: { x: number; y: number }[];
}

/** 长边上限。再大对 Qwen 也没意义（参考图本来就会被缩到约 1024），还费内存。 */
const MAX_DIM = 1600;

const COLORS = [
  { name: "红", value: "#ff3b30" },
  { name: "黄", value: "#ffd60a" },
  { name: "绿", value: "#32d74b" },
  { name: "青", value: "#40e0d0" },
  { name: "蓝", value: "#3b82f6" },
  { name: "洋红", value: "#ff2d95" },
  { name: "白", value: "#ffffff" },
];

const WIDTHS = [
  { name: "细", value: 5 },
  { name: "中", value: 10 },
  { name: "粗", value: 18 },
];

const canvas = ref<HTMLCanvasElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const err = ref("");
const tool = ref<Tool>("ellipse");
const color = ref(COLORS[0].value);
const width = ref(WIDTHS[1].value);

const strokes = ref<Stroke[]>([]);
let base: HTMLImageElement | null = null;
let drawing = false;
let current: Stroke | null = null;

const canUndo = computed(() => strokes.value.length > 0);

const TOOLS: { id: Tool; label: string; icon: unknown }[] = [
  { id: "ellipse", label: "圈选", icon: CircleIcon },
  { id: "pen", label: "画笔", icon: Pencil },
  { id: "rect", label: "方框", icon: SquareIcon },
  { id: "arrow", label: "箭头", icon: MoveUpRight },
];

function ctx(): CanvasRenderingContext2D | null {
  return canvas.value?.getContext("2d") ?? null;
}

/** 描一层黑边 + 画彩色线，保证任何底色上都看得见 */
function strokePath(
  c: CanvasRenderingContext2D,
  s: Stroke,
  trace: (c: CanvasRenderingContext2D) => void,
) {
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = "rgba(0,0,0,0.5)";
  c.lineWidth = s.width + 5;
  c.beginPath();
  trace(c);
  c.stroke();

  c.strokeStyle = s.color;
  c.lineWidth = s.width;
  c.beginPath();
  trace(c);
  c.stroke();
}

function drawStroke(c: CanvasRenderingContext2D, s: Stroke) {
  const pts = s.points;
  if (pts.length < 2) return;

  if (s.tool === "pen") {
    strokePath(c, s, (cc) => {
      cc.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) cc.lineTo(pts[i].x, pts[i].y);
    });
    return;
  }

  const a = pts[0];
  const b = pts[pts.length - 1];

  if (s.tool === "ellipse") {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    // 半径至少给到半个线宽。否则"几乎垂直/水平的拖拽"会算出 0 半径，
    // 椭圆退化成看不见的东西 —— 用户拖完一片空白，只会以为工具坏了。
    // 夹一下之后，这种拖拽会画出一条可见的竖线/横线，符合直觉。
    const minR = s.width / 2;
    const rx = Math.max(minR, Math.abs(b.x - a.x) / 2);
    const ry = Math.max(minR, Math.abs(b.y - a.y) / 2);
    strokePath(c, s, (cc) => cc.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2));
    return;
  }

  if (s.tool === "rect") {
    strokePath(c, s, (cc) => cc.rect(a.x, a.y, b.x - a.x, b.y - a.y));
    return;
  }

  // 箭头：先画杆，再画箭头两翼
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.max(18, s.width * 3.2);
  strokePath(c, s, (cc) => {
    cc.moveTo(a.x, a.y);
    cc.lineTo(b.x, b.y);
    cc.moveTo(b.x, b.y);
    cc.lineTo(b.x - head * Math.cos(ang - 0.42), b.y - head * Math.sin(ang - 0.42));
    cc.moveTo(b.x, b.y);
    cc.lineTo(b.x - head * Math.cos(ang + 0.42), b.y - head * Math.sin(ang + 0.42));
  });
}

/** 整幅重绘：底图 + 所有笔迹。撤销就是重放少一笔。 */
function redraw() {
  const c = ctx();
  const cv = canvas.value;
  if (!c || !cv || !base) return;
  c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(base, 0, 0, cv.width, cv.height);
  for (const s of strokes.value) drawStroke(c, s);
  if (current) drawStroke(c, current);
}

function toCanvasCoords(e: PointerEvent): { x: number; y: number } {
  const cv = canvas.value!;
  const r = cv.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * cv.width,
    y: ((e.clientY - r.top) / r.height) * cv.height,
  };
}

function onDown(e: PointerEvent) {
  if (loading.value || saving.value) return;
  canvas.value?.setPointerCapture(e.pointerId);
  drawing = true;
  const p = toCanvasCoords(e);
  current = {
    tool: tool.value,
    color: color.value,
    width: width.value,
    // 画笔要存起点，其余工具也要两点才能算出形状
    points: tool.value === "pen" ? [p] : [p, p],
  };
  redraw();
}

function onMove(e: PointerEvent) {
  if (!drawing || !current) return;
  const p = toCanvasCoords(e);
  if (current.tool === "pen") current.points.push(p);
  else current.points[1] = p;
  redraw();
}

function onUp(e: PointerEvent) {
  if (!drawing || !current) return;
  drawing = false;
  canvas.value?.releasePointerCapture(e.pointerId);

  const pts = current.points;
  // 只点了一下没拖动，丢掉，避免留下看不见的杂笔
  const moved =
    pts.length > 1 &&
    (Math.abs(pts[0].x - pts[pts.length - 1].x) > 3 ||
      Math.abs(pts[0].y - pts[pts.length - 1].y) > 3 ||
      pts.length > 3);
  if (moved) strokes.value = [...strokes.value, current];
  current = null;
  redraw();
}

function undo() {
  if (strokes.value.length === 0) return;
  strokes.value = strokes.value.slice(0, -1);
  redraw();
}

function clearAll() {
  strokes.value = [];
  redraw();
}

async function save() {
  const cv = canvas.value;
  if (!cv) return;
  if (strokes.value.length === 0) {
    err.value = "还没有画任何标记";
    return;
  }
  saving.value = true;
  err.value = "";
  try {
    const dest = await buildOutputPath(settings.outputDir, "_标注", "", "png");
    const dataUrl = cv.toDataURL("image/png");
    const path = await saveDataUrl(dataUrl, dest);
    // 标注副本会持续产生，按设置回收旧的
    pruneDir(`${settings.outputDir}\\_标注`, settings.annotationKeep).catch(() => undefined);
    emit("saved", path);
    emit("toast", "标注已应用，生成时会用这张带标记的图");
    emit("close");
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  const img = new Image();
  img.onload = () => {
    base = img;
    const cv = canvas.value;
    if (!cv) return;
    const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    cv.width = Math.max(32, Math.round(img.naturalWidth * scale));
    cv.height = Math.max(32, Math.round(img.naturalHeight * scale));
    loading.value = false;
    redraw();
  };
  img.onerror = () => {
    loading.value = false;
    err.value = "图片加载失败，可能文件已被移动或删除。";
  };
  img.src = fileUrl(props.src);
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="overlay-mask" style="padding: 20px" @click.self="emit('close')">
    <div class="modal" style="width: min(1180px, 96vw); height: min(880px, 94vh)">
      <div class="modal-head">
        <span class="modal-title">标注 · {{ label }}</span>
        <span class="pill accent">标记会直接画进图片</span>
        <div style="flex: 1"></div>
        <button class="btn ghost sm" @click="emit('close')"><X :size="15" /></button>
      </div>

      <div class="anno-toolbar">
        <div class="seg">
          <button
            v-for="t in TOOLS"
            :key="t.id"
            :class="{ on: tool === t.id }"
            @click="tool = t.id"
          >
            <component :is="t.icon" :size="12" />
            {{ t.label }}
          </button>
        </div>

        <div class="anno-colors">
          <button
            v-for="c in COLORS"
            :key="c.value"
            class="swatch"
            :class="{ on: color === c.value }"
            :style="{ background: c.value }"
            :title="c.name"
            @click="color = c.value"
          />
        </div>

        <div class="seg">
          <button
            v-for="w in WIDTHS"
            :key="w.value"
            :class="{ on: width === w.value }"
            @click="width = w.value"
          >
            {{ w.name }}
          </button>
        </div>

        <div style="flex: 1"></div>
        <button class="btn sm" :disabled="!canUndo" @click="undo">
          <Undo2 :size="12" /> 撤销
        </button>
        <button class="btn sm" :disabled="!canUndo" @click="clearAll">
          <Eraser :size="12" /> 清空
        </button>
      </div>

      <div class="anno-stage">
        <div v-if="loading" class="empty">
          <Loader2 :size="28" class="spin" />
          <div style="margin-top: 8px">正在载入图片…</div>
        </div>
        <canvas
          v-show="!loading"
          ref="canvas"
          class="anno-canvas"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        />
      </div>

      <div class="modal-foot" style="justify-content: space-between">
        <div class="flex" style="gap: 6px; align-items: center; min-width: 0">
          <Info :size="13" style="color: var(--text-3); flex: 0 0 auto" />
          <span class="muted" style="font-size: 12px">
            圈出要改的位置，然后在提示词里说清改成什么 —— 标记负责指位置，提示词负责说意图。
            画笔 Ctrl+Z 撤销。
          </span>
        </div>
        <div v-if="err" class="pill err">{{ err }}</div>
        <div class="flex" style="flex: 0 0 auto">
          <button class="btn" @click="emit('close')">取消</button>
          <button class="btn primary" :disabled="saving || loading" @click="save">
            <Loader2 v-if="saving" :size="13" class="spin" />
            <Check v-else :size="13" />
            应用标注
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.anno-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  flex: 0 0 auto;
}
.anno-toolbar .seg button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.anno-colors {
  display: flex;
  gap: 5px;
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  box-shadow: 0 0 0 1px var(--border-strong);
}
.swatch.on {
  border-color: var(--text);
  transform: scale(1.14);
}
/* 和预览窗同样的原因：grid 的 auto 行高会让 max-height:100% 失效 */
.anno-stage {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  padding: 14px;
  background: repeating-conic-gradient(#1b1e25 0% 25%, #171a20 0% 50%) 50% / 22px 22px;
  overflow: hidden;
}
.anno-canvas {
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  cursor: crosshair;
  touch-action: none;
  border-radius: 4px;
  box-shadow: 0 4px 22px rgba(0, 0, 0, 0.5);
}
.spin {
  animation: rot 1s linear infinite;
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}
</style>

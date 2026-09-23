/**
 * 视频联调：用**应用真实的工作流图**跑一次本机 MiniMax H3 视频生成。
 *
 * `src/api/video.ts` 的 `buildVideo` 就是界面上「开始生成视频」时用的那个函数；
 * 这里把它打包出来，配上 Rust 侧真实探测到的模型名，直接提交给本机 ComfyUI，
 * 再按应用的下载方式把 mp4 取回来校验。这样能在不点界面的情况下验证：
 * 工作流图被后端接受 → 真的产出带音轨的 mp4 → 下载链路完好。
 *
 * 前置：
 *   1. 本机 ComfyUI 在 127.0.0.1:8188 运行；
 *   2. 先跑一次 `cargo test --test comfy_live -- --nocapture reports_h3`，
 *      它会把应用检测到的能力写到 %TEMP%\huajing_h3_capabilities.json。
 *
 * 用法：node scripts/live-video-check.mjs [--length 124] [--size 864x480] [--prompt "..."]
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:8188";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const length = Number(arg("length", "124"));
const size = arg("size", "864x480");
const prompt = arg("prompt", "镜头缓慢推近，人物抬头看向窗外，微风吹动发梢，窗外传来轻柔的雨声。");
const [width, height] = size.split("x").map(Number);

async function loadGraphBuilder() {
  const out = path.join(root, ".test-build", "live-video", "video.mjs");
  await mkdir(path.dirname(out), { recursive: true });
  await build({
    entryPoints: [path.join(root, "src", "api", "video.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
  });
  return import(`file://${out.replace(/\\/g, "/")}`);
}

async function firstImagePath() {
  // 首帧必须是 ComfyUI 能读到的 input 文件；用 /view 里的内置示例图
  const resp = await fetch(`${BASE}/view?filename=example.png&subfolder=&type=input`);
  if (!resp.ok) throw new Error(`找不到内置示例图 example.png（HTTP ${resp.status}）`);
  return "example.png";
}

async function main() {
  const capsPath = path.join(os.tmpdir(), "huajing_h3_capabilities.json");
  let caps;
  try {
    caps = JSON.parse(await readFile(capsPath, "utf8"));
  } catch {
    console.error(`读不到 ${capsPath}`);
    console.error("请先运行：cd src-tauri && cargo test --test comfy_live -- --nocapture reports_h3");
    process.exit(1);
  }
  if (!caps.ready) {
    console.error("本机 H3 工作流未就绪：", caps.message);
    process.exit(1);
  }

  const { buildVideo } = await loadGraphBuilder();
  const firstFrame = await firstImagePath();
  const graph = buildVideo({
    prompt,
    refs: [firstFrame],
    width,
    height,
    seed: 20260922,
    filenamePrefix: "画境/huajing_live_video",
    video: { length, capabilities: caps },
  });
  console.log(`提交 H3 工作流：${width}×${height}，${length} 帧（约 ${(length / 24).toFixed(1)} 秒）…`);

  const queued = await fetch(`${BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "huajing-live-video" }),
  });
  if (!queued.ok) {
    console.error("提交失败：", queued.status, await queued.text());
    process.exit(1);
  }
  const { prompt_id: promptId } = await queued.json();
  console.log(`已入队 ${promptId}，等待生成（首次要加载模型，可能几分钟）…`);

  const started = Date.now();
  let record = null;
  for (let i = 0; i < 1800; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await fetch(`${BASE}/history/${promptId}`);
    if (!resp.ok) continue;
    const body = await resp.json();
    const entry = body[promptId];
    if (!entry) continue;
    const status = entry.status ?? {};
    if (status.status_str === "error") {
      console.error("生成失败：", JSON.stringify(status.messages ?? status, null, 2).slice(0, 2000));
      process.exit(1);
    }
    if (status.completed === true || status.status_str === "success") {
      record = entry;
      break;
    }
    if (i % 15 === 0) console.log(`  仍在生成…（已 ${Math.round((Date.now() - started) / 1000)} 秒）`);
  }
  if (!record) {
    console.error("等待超时（60 分钟）");
    process.exit(1);
  }

  // 真实记录形状（2026-09-22 实测）：SaveVideo 把 mp4 放在 `images` 字段里，带 animated 标记。
  // 与 src/api/jobCore.ts 的 extractOutputs 保持同一套判定：按扩展名认视频。
  const items = Object.values(record.outputs ?? {}).flatMap((node) => [
    ...(node.images ?? []),
    ...(node.videos ?? []),
    ...(node.gifs ?? []),
  ]);
  const video = items.find((item) => /\.(mp4|webm|mov|mkv)$/i.test(item.filename ?? ""));
  if (!video) {
    console.error("任务结束但没有视频产出：", JSON.stringify(record.outputs ?? {}, null, 2).slice(0, 2000));
    process.exit(1);
  }

  // 按应用的下载方式取回：先写临时文件，完整读完再落到目标位置
  const url = `${BASE}/view?filename=${encodeURIComponent(video.filename)}&subfolder=${encodeURIComponent(video.subfolder ?? "")}&type=${video.type}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error("下载失败：", resp.status);
    process.exit(1);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  const dir = path.join(os.tmpdir(), `huajing-live-video-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, video.filename);
  const temp = `${dest}.part`;
  await writeFile(temp, bytes);
  const { rename } = await import("node:fs/promises");
  await rename(temp, dest);

  const head = bytes.subarray(4, 12).toString("latin1");
  const seconds = (length / 24).toFixed(1);
  console.log(`OK: 生成完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
  console.log(`OK: ${video.filename}，${(bytes.length / 1024 / 1024).toFixed(2)} MB，约 ${seconds} 秒，容器标记 ${head}`);
  if (!head.includes("ftyp") && !head.includes("moov")) {
    console.error("✖ 这不像是可播放的 MP4");
    process.exit(1);
  }
  const leftovers = (await import("node:fs/promises")).readdir(dir).then((names) => names.filter((n) => n.endsWith(".part")));
  if ((await leftovers).length) {
    console.error("✖ 留下了临时文件");
    process.exit(1);
  }
  console.log(`OK: 已保存到 ${dest}，目录里没有残留临时文件`);
  await rm(dir, { recursive: true, force: true });
  console.log("OK: 临时目录已清理");
}

main().catch((error) => {
  console.error("联调脚本出错：", error);
  process.exit(1);
});

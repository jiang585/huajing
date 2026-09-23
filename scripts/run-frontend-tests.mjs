/**
 * 前端回归测试的运行器。
 *
 * 用项目里已有的 esbuild 把 `tests/frontend/*.test.ts` 连同 store 一起打包成 ESM，
 * 再用 Node 自带的测试运行器执行 —— 不引入 vitest / jsdom 这类额外依赖，
 * `pnpm test:ui` 一条命令就能重复跑。
 *
 * 关键一步是 onResolve 钩子：store 里的 `../api/tauri` 会被换成测试替身，
 * 于是测试可以完全控制后端响应与调用时序，不用真的起 ComfyUI。
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests", "frontend");
const outDir = path.join(root, ".test-build");

const entries = (await readdir(testDir)).filter((name) => name.endsWith(".test.ts")).sort();
if (entries.length === 0) {
  console.error("没有找到前端测试文件");
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: entries.map((name) => path.join(testDir, name)),
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  logLevel: "warning",
  define: {
    "process.env.NODE_ENV": '"production"',
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  plugins: [
    {
      name: "fake-tauri",
      setup(plugin) {
        plugin.onResolve({ filter: /^\.\.\/api\/tauri$/ }, (args) => {
          const importer = args.importer.replace(/\\/g, "/");
          if (!importer.includes("/src/")) return null;
          return { path: path.join(testDir, "harness", "fakeTauri.ts") };
        });
      },
    },
  ],
});

const outputs = entries.map((name) => path.join(outDir, name.replace(/\.ts$/, ".js")));
console.log(`运行 ${outputs.length} 个前端回归测试文件…`);

const child = spawn(process.execPath, ["--test", ...outputs], { stdio: "inherit", cwd: root });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

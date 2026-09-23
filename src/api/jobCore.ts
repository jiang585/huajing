import type { OutputImage } from "./tauri";

export const CANCELED = "已取消";
export function parseSize(size: string): { width: number; height: number } {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  if (!m) throw new Error("尺寸格式应为宽×高，例如 1024x1024。");
  const [width, height] = [Number(m[1]), Number(m[2])];
  if ([width, height].some(n => !Number.isInteger(n) || n < 64 || n > 4096 || n % 8 !== 0)) {
    throw new Error("宽高需要是 64–4096 范围内的 8 的倍数。");
  }
  return { width, height };
}

export function extractOutputs(record: Record<string, unknown>, video = false): OutputImage[] {
  const outputs = record.outputs as Record<string, Record<string, unknown>> | undefined;
  const out: OutputImage[] = [];
  const seen = new Set<string>();
  for (const node of Object.values(outputs ?? {})) {
    for (const field of ["images", "videos", "gifs"]) {
      const items = node?.[field];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item.filename !== "string" || item.type !== "output") continue;
        const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(item.filename);
        if (isVideo !== video || (!video && !/\.(png|jpe?g|webp|bmp)$/i.test(item.filename))) continue;
        const key = `${item.type}/${item.subfolder ?? ""}/${item.filename}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ filename: item.filename, subfolder: item.subfolder ?? "", type: item.type });
      }
    }
  }
  return out;
}

export function extractError(record: Record<string, unknown>): string | null {
  const status = record.status as { status_str?: string; messages?: unknown[] } | undefined;
  for (const m of status?.messages ?? []) {
    if (!Array.isArray(m)) continue;
    if (m[0] === "execution_interrupted") return CANCELED;
    if (m[0] === "execution_error") {
      const d = m[1] as Record<string, unknown> | undefined;
      return `${d?.exception_type ?? "执行错误"}: ${d?.exception_message ?? ""}`.trim();
    }
  }
  return status?.status_str === "error" ? "执行过程中出错，请查看后端日志。" : null;
}

export function recordComplete(record: Record<string, unknown>): boolean {
  const status = record.status as { completed?: boolean; status_str?: string } | undefined;
  return status?.completed === true || status?.status_str === "success" || status?.status_str === "error";
}

import * as fs from "node:fs/promises";
import { checkRead } from "./path-policy.ts";

export interface ReadParams { path: string; offset?: number; limit?: number }
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export async function runRead(
  policy: Parameters<typeof checkRead>[0],
  readFiles: Set<string>,
  params: ReadParams,
): Promise<{ content: string; isError: boolean }> {
  const denied = checkRead(policy, params.path);
  if (denied) return { content: `read failed: ${denied}`, isError: true };
  try {
    const buffer = await fs.readFile(params.path);
    if (buffer.subarray(0, 8192).includes(0)) {
      return { content: `read failed: ${params.path} is binary`, isError: true };
    }
    const content = buffer.toString("utf-8");
    readFiles.add(require("node:path").resolve(params.path));
    const offset = params.offset ?? 0;
    const lines = content.split("\n").slice(offset, offset + MAX_LINES);
    let out = "";
    for (let i = 0; i < lines.length; i++) {
      const lineNo = offset + i + 1;
      const clamped = lines[i].length > MAX_LINE_CHARS
        ? lines[i].slice(0, MAX_LINE_CHARS) + "…" : lines[i];
      out += `${String(lineNo).padStart(6)}\t${clamped}\n`;
    }
    return { content: out, isError: false };
  } catch (e) {
    return { content: `read failed: ${params.path}: ${e}`, isError: true };
  }
}

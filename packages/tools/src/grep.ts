import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  max_results?: number;
}

export async function runGrep(
  cwd: string,
  params: GrepParams,
): Promise<{ content: string; isError: boolean }> {
  const root = params.path ?? ".";
  const args = ["--", params.pattern, root];
  if (params.glob) args.splice(1, 0, "--glob", params.glob);
  try {
    const { stdout } = await exec("rg", ["--line-number", "--max-count", "200", ...args], {
      cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
    });
    return { content: stdout || "no matches", isError: false };
  } catch (e: any) {
    if (e.code === 1) return { content: "no matches", isError: false };
    if (e.code === "ENOENT") {
      return { content: "grep failed: ripgrep (rg) not found in PATH", isError: true };
    }
    return { content: `grep failed: ${e.message}`, isError: true };
  }
}

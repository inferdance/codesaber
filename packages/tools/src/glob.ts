import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export interface GlobParams { pattern: string; path?: string }

export async function runGlob(
  cwd: string,
  params: GlobParams,
): Promise<{ content: string; isError: boolean }> {
  const root = params.path ?? ".";
  try {
    const { stdout } = await exec("find", [root, "-type", "f", "-name", params.pattern], {
      cwd, maxBuffer: 10 * 1024 * 1024, timeout: 15_000,
    });
    const files = stdout.trim().split("\n").filter(Boolean).slice(0, 200);
    return { content: files.length ? files.join("\n") : `no files matching ${params.pattern}`, isError: false };
  } catch (e: any) {
    return { content: `glob failed: ${e.message}`, isError: true };
  }
}

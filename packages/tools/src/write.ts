import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkWrite } from "./path-policy.ts";

export interface WriteParams { path: string; content: string }

export async function runWrite(
  policy: Parameters<typeof checkWrite>[0],
  readFiles: Set<string>,
  params: WriteParams,
): Promise<{ content: string; isError: boolean }> {
  const denied = checkWrite(policy, params.path);
  if (denied) return { content: `write failed: ${denied}`, isError: true };
  const resolved = path.resolve(params.path);
  const existed = await fs.stat(resolved).then(() => true, () => false);
  if (existed && !readFiles.has(resolved)) {
    return { content: `write failed: ${params.path} exists; read it first`, isError: true };
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  // Atomic write: tmp + rename
  const tmp = resolved + `.sabertmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, params.content);
  if (existed) {
    const stat = await fs.stat(resolved);
    await fs.chmod(tmp, stat.mode);
  }
  await fs.rename(tmp, resolved);
  return {
    content: `${existed ? "overwrote" : "created"} ${params.path} (${params.content.length} bytes)`,
    isError: false,
  };
}

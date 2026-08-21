import { createPathPolicy, checkRead, checkWrite } from "./path-policy.ts";
import { createDirectExecutor, createSeatbeltExecutor, renderBashOutput, SANDBOX_DENIAL_MARKER, type BashExecutor } from "./bash.ts";
import { applyEdit } from "./edit.ts";
import { runRead } from "./read.ts";
import { runWrite } from "./write.ts";
import { runGrep } from "./grep.ts";
import { runGlob } from "./glob.ts";

export { createPathPolicy, checkRead, checkWrite };
export { createDirectExecutor, createSeatbeltExecutor, renderBashOutput, SANDBOX_DENIAL_MARKER };
export { applyEdit };
export type { BashExecutor };

// Tool registry & scheduler will be added here
export interface ToolResult { content: string; isError: boolean }
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  concurrency: "read_only" | "exclusive";
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  sessionId: string;
  cwd: string;
  dataDir: string;
  policy: ReturnType<typeof createPathPolicy>;
  readFiles: Set<string>;
  bashExecutor: BashExecutor;
  lastDenial: { command: string; count: number };
}

export function createToolContext(
  sessionId: string,
  cwd: string,
  dataDir: string,
  bashExecutor?: BashExecutor,
): ToolContext {
  return {
    sessionId, cwd, dataDir,
    policy: createPathPolicy(cwd, dataDir),
    readFiles: new Set(),
    bashExecutor: bashExecutor ?? createDirectExecutor(),
    lastDenial: { command: "", count: 0 },
  };
}

export function createBuiltinTools(): ToolDefinition[] {
  return [
    {
      name: "bash",
      description: "Runs a bash command in the workspace. Non-interactive. Output truncated head+tail.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
          timeout_ms: { type: "number", description: "Timeout in ms (default 120000)" },
        },
        required: ["command"],
      },
      concurrency: "exclusive",
      async execute(args, ctx) {
        const result = await ctx.bashExecutor.execute(
          { cwd: ctx.cwd, dataDir: ctx.dataDir, sessionId: ctx.sessionId },
          args.command as string,
          (args.timeout_ms as number) ?? 120_000,
        );
        let rendered = renderBashOutput(result);
        if (rendered.includes(SANDBOX_DENIAL_MARKER)) {
          if (ctx.lastDenial.command === args.command) ctx.lastDenial.count++;
          else { ctx.lastDenial.command = args.command as string; ctx.lastDenial.count = 1; }
          if (ctx.lastDenial.count >= 2) {
            rendered += "\n[saber] SAME denial repeated — stop retrying. Boundary is intentional.";
            return { content: rendered, isError: true };
          }
        } else {
          ctx.lastDenial = { command: "", count: 0 };
        }
        return { content: rendered, isError: false };
      },
    },
    {
      name: "read",
      description: "Reads a file with line numbers (max 2000 lines). Must read before editing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
      concurrency: "read_only",
      async execute(args, ctx) {
        return runRead(ctx.policy, ctx.readFiles, args as any);
      },
    },
    {
      name: "write",
      description: "Creates or overwrites a file atomically. Must read existing files first.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      concurrency: "exclusive",
      async execute(args, ctx) {
        return runWrite(ctx.policy, ctx.readFiles, args as any);
      },
    },
    {
      name: "edit",
      description: "Replaces old_string with new_string (6-level fallback). Must read first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
      concurrency: "exclusive",
      async execute(args, ctx) {
        const denied = checkWrite(ctx.policy, args.path as string);
        if (denied) return { content: `edit failed: ${denied}`, isError: true };
        const resolved = require("node:path").resolve(args.path as string);
        if (!ctx.readFiles.has(resolved)) {
          return { content: `edit failed: must read ${args.path} first`, isError: true };
        }
        try {
          const content = await require("node:fs/promises").readFile(args.path as string, "utf-8");
          const { content: newContent, summary } = applyEdit(content, args as any);
          await require("node:fs/promises").writeFile(args.path as string, newContent);
          return { content: `${summary} in ${args.path}`, isError: false };
        } catch (e) {
          return { content: `edit failed: ${e}`, isError: true };
        }
      },
    },
    {
      name: "grep",
      description: "Content search via ripgrep. Returns path:line:text matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
        },
        required: ["pattern"],
      },
      concurrency: "read_only",
      async execute(args, ctx) {
        return runGrep(ctx.cwd, args as any);
      },
    },
    {
      name: "glob",
      description: "File-path glob matching. Returns matching file paths.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      },
      concurrency: "read_only",
      async execute(args, ctx) {
        return runGlob(ctx.cwd, args as any);
      },
    },
  ];
}

/** Executes a batch: read-only tools concurrently, exclusive serialized. */
export async function executeBatch(
  tools: ToolDefinition[],
  ctx: ToolContext,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): Promise<ToolResult[]> {
  const readOnly: Array<{ index: number; promise: Promise<ToolResult> }> = [];
  const exclusive: Array<{ index: number; call: { name: string; args: Record<string, unknown> } }> = [];
  calls.forEach((call, index) => {
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      readOnly.push({ index, promise: Promise.resolve({ content: `unknown tool: ${call.name}`, isError: true }) });
    } else if (tool.concurrency === "read_only") {
      readOnly.push({ index, promise: tool.execute(call.args, ctx) });
    } else {
      exclusive.push({ index, call });
    }
  });
  const readResults = await Promise.all(readOnly.map((r) => r.promise));
  const results: ToolResult[] = new Array(calls.length);
  readOnly.forEach((slot, i) => { results[slot.index] = readResults[i]; });
  for (const slot of exclusive) {
    const tool = tools.find((t) => t.name === slot.call.name)!;
    results[slot.index] = await tool.execute(slot.call.args, ctx);
  }
  return results;
}

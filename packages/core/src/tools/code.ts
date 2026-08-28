/**
 * run_code execution runtime: a fresh worker thread per run.
 *
 * The worker bootstrap below is plain JS shipped as a string and written to
 * a temp file at first use — deliberately decoupled from the build output
 * so dev (tsx), tests (vitest from source), and dist all behave identically.
 *
 * Containment, NOT a security boundary: the code runs with the same trust
 * as the bash tool (a determined program can reach worker globals). The
 * sandbox story for both is SABER_SANDBOX / future work.
 */

import { Worker } from "node:worker_threads";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";
import { truncateMiddle } from "./index.js";

const WORKER_BOOTSTRAP = `
import { parentPort } from "node:worker_threads";

const calls = new Map();
let counter = 0;

const tools = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== "string") return undefined;
    return async (args = {}) => {
      const id = "rc-" + (++counter) + "-" + name;
      const response = await new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject });
        parentPort.postMessage({ type: "call", id, name, args });
      });
      if (response.isError) {
        const err = new Error(name + " failed: " + response.content);
        err.toolName = name;
        throw err;
      }
      return response.content;
    };
  },
});

parentPort.on("message", async (msg) => {
  if (msg.type === "run") {
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction("tools", msg.code);
      const value = await fn(tools);
      parentPort.postMessage({ type: "done", value: render(value) });
    } catch (e) {
      parentPort.postMessage({ type: "error", message: String((e && e.stack) || e) });
    }
  } else if (msg.type === "result") {
    const pending = calls.get(msg.id);
    if (!pending) return;
    calls.delete(msg.id);
    if (msg.isError) {
      const err = new Error(msg.content);
      err.toolName = msg.toolName;
      pending.reject(err);
    } else {
      pending.resolve({ content: msg.content, isError: false });
    }
  }
});

function render(value) {
  if (value === undefined) return "(no return value)";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

parentPort.postMessage({ type: "ready" });
`;

let workerFilePromise: Promise<string> | null = null;

async function ensureWorkerFile(): Promise<string> {
  workerFilePromise ??= (async () => {
    const dir = path.join(tmpdir(), "saber-code-workers");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `bootstrap-${randomUUID().slice(0, 8)}.mjs`);
    await writeFile(file, WORKER_BOOTSTRAP, "utf-8");
    return file;
  })();
  return workerFilePromise;
}

export interface RunCodeOptions {
  /** Complete TypeScript program; top-level await allowed; `tools` binding. */
  code: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

interface Subcall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Runs the program in a fresh worker, bridging `tools.*` calls back to the
 * parent registry. Sub-calls execute serially (conservative but correct for
 * exclusive tools) and are recorded to the WAL via ctx.dispatch when the
 * engine provided one, preserving "model-visible ⟺ logged".
 */
export async function runCode(
  options: RunCodeOptions,
  tools: ToolDefinition[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let javascript: string;
  try {
    // strip requires a valid module: top-level `return` is only legal inside
    // a function body, so wrap first and slice the body out after stripping
    const wrapperHead = "async function __saberProgram(tools) {";
    const wrapped = stripTypeScriptTypes(`${wrapperHead}\n${options.code}\n}`, { mode: "strip" });
    javascript = wrapped.slice(wrapperHead.length, wrapped.lastIndexOf("}"));
  } catch (e) {
    return { content: `code transform failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }

  const file = await ensureWorkerFile();
  const worker = new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: 256 } });

  // serialize sub-call execution: model code may fire Promise.all, the
  // parent still runs them one at a time so exclusive tools never overlap
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    queue = queue.then(fn, fn);
    return queue;
  };

  const done = new Promise<ToolResult>((resolve) => {
    const finish = (result: ToolResult): void => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ content: `run_code timed out after ${timeoutMs}ms (worker terminated)`, isError: true });
    }, timeoutMs);

    worker.on("message", (msg: { type: string; value?: string; message?: string } & Subcall) => {
      if (msg.type === "ready") {
        worker.postMessage({ type: "run", code: javascript });
        return;
      }
      if (msg.type === "done") {
        finish({ content: truncateMiddle(msg.value ?? "(no return value)", 20_000), isError: false });
        return;
      }
      if (msg.type === "error") {
        finish({ content: truncateMiddle(msg.message ?? "unknown error", 20_000), isError: true });
        return;
      }
      if (msg.type === "call") {
        void enqueue(async () => {
          const tool = tools.find((t) => t.name === msg.name) ?? null;
          if (!tool) {
            worker.postMessage({ type: "result", id: msg.id, isError: true, content: `unknown tool: ${msg.name}` });
            return;
          }
          ctx.dispatch?.({ type: "tool_call", callId: msg.id, name: msg.name, args: msg.args }, { sync: true });
          let result: ToolResult;
          try {
            const args = (typeof msg.args === "object" && msg.args !== null ? msg.args : {}) as Record<string, unknown>;
            result = await tool.execute(args, ctx);
          } catch (e) {
            result = { content: `tool crashed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
          }
          ctx.dispatch?.({ type: "tool_result", callId: msg.id, name: msg.name, content: result.content, isError: result.isError });
          worker.postMessage({ type: "result", id: msg.id, isError: result.isError, content: result.content, toolName: msg.name });
        });
      }
    });

    worker.on("error", (e) => {
      finish({ content: `worker crashed: ${e.message}`, isError: true });
    });
  });

  return done;
}

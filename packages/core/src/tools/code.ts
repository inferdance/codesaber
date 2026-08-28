/**
 * run_code execution runtime: a fresh worker thread per run.
 *
 * The worker bootstrap below is plain JS shipped as a string and written to
 * a temp file at first use — deliberately decoupled from the build output
 * so dev (tsx), tests (vitest from source), and dist all behave identically.
 *
 * Trust model: the program runs with full Node capabilities (dynamic import
 * included) — the SAME trust as the bash tool, NOT the PathPolicy-confined
 * trust of native tools. That is why run_code is opt-in (SABER_CODE=1).
 *
 * TypeScript contract: erasable syntax only (annotations, generics) —
 * enums/namespaces/parameter properties are rejected by the stripper.
 */

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
      const id = globalThis.__idPrefix + "-" + (++counter) + "-" + name;
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
    globalThis.__idPrefix = msg.idPrefix;
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

async function ensureWorkerFile(imports: { writeFile: typeof import("node:fs/promises")["writeFile"]; mkdir: typeof import("node:fs/promises")["mkdir"] }, tmp: string, join: typeof import("node:path")["join"], uuid: string): Promise<string> {
  workerFilePromise ??= (async () => {
    const dir = join(tmp, "saber-code-workers");
    await imports.mkdir(dir, { recursive: true });
    const file = join(dir, `bootstrap-${uuid.slice(0, 8)}.mjs`);
    await imports.writeFile(file, WORKER_BOOTSTRAP, "utf-8");
    return file;
  })();
  try {
    return await workerFilePromise;
  } catch (e) {
    workerFilePromise = null; // a failed bootstrap must not poison later runs
    throw e;
  }
}

export interface RunCodeOptions {
  /** Complete erasable-TypeScript program; top-level await allowed. */
  code: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard cap on waiting for in-flight sub-calls after an error terminal —
 *  non-cooperative tools (e.g. a read stuck on a FIFO) must not hang the
 *  turn forever; leftover intents surface via WAL recovery. */
const DRAIN_CAP_MS = 10_000;

interface Subcall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Runs the program in a fresh worker, bridging `tools.*` calls back to the
 * parent registry. Sub-calls execute serially and are recorded to the WAL
 * via ctx.dispatch when the engine provided one. The run composes the turn
 * signal with its own timeout: abort/timeout cancels in-flight sub-tools
 * (bash kills its process group) and terminates the worker; the returned
 * promise never settles before every sub-call has a result.
 */
export async function runCode(
  options: RunCodeOptions,
  tools: ToolDefinition[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    // Node-only imports stay lazy: core must stay loadable under runtimes
    // without them (Bun dev) — code.ts is only reached when run_code runs
    const [{ stripTypeScriptTypes }, { Worker }, { writeFile, mkdir }, nodeOs, nodePath, nodeCrypto] = await Promise.all([
      import("node:module"),
      import("node:worker_threads"),
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
      import("node:crypto"),
    ]);

    let javascript: string;
    try {
      // strip requires a valid module: top-level `return` is only legal
      // inside a function body, so wrap first and slice the body out after
      const wrapperHead = "async function __saberProgram(tools) {";
      const wrapped = stripTypeScriptTypes(`${wrapperHead}\n${options.code}\n}`, { mode: "strip" });
      javascript = wrapped.slice(wrapperHead.length, wrapped.lastIndexOf("}"));
    } catch (e) {
      return { content: `code transform failed (erasable TypeScript only — no enums/namespaces): ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }

    const file = await ensureWorkerFile({ writeFile, mkdir }, nodeOs.tmpdir(), nodePath.join, nodeCrypto.randomUUID());
    const worker = new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: 256 } });

    // one signal to rule the run: caller abort OR wall clock
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const sources = [timeoutSignal];
    if (ctx.signal) sources.push(ctx.signal);
    const runSignal = sources.length === 1 ? timeoutSignal : AbortSignal.any(sources);

    // serialize sub-call execution: model code may fire Promise.all, the
    // parent still runs them one at a time so exclusive tools never overlap
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void>): Promise<void> => {
      queue = queue.then(fn, fn);
      return queue;
    };
    // sub-tools see the composed signal so abort/timeout reaches bash groups
    const subCtx: ToolContext = { ...ctx, signal: runSignal };

    const done = new Promise<ToolResult>((resolve) => {
      // ── single-terminal-state settlement ────────────────────────────
      // pending counts ACCEPTED sub-calls; `closed` stops new acceptance
      // (late worker messages get an error answer, never execution); an
      // error terminal OVERRIDES a staged success; settlement fires once,
      // only when closed && pending === 0 && a terminal exists. A hard
      // drain cap guarantees settlement even with non-cooperative tools.
      let pending = 0;
      let closed = false;
      let settledFlag = false;
      let terminal: ToolResult | null = null;
      let drainCap: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        if (drainCap !== null) clearTimeout(drainCap);
        runSignal.removeEventListener("abort", onAbort);
        void worker.terminate();
      };
      const maybeSettle = (): void => {
        if (settledFlag || !closed || terminal === null || pending > 0) return;
        settledFlag = true;
        cleanup();
        resolve(terminal);
      };
      const closeWith = (result: ToolResult, isError: boolean): void => {
        if (isError || terminal === null) terminal = result; // error overrides staged success
        if (!closed) {
          closed = true;
          void worker.terminate(); // no further program output can arrive
          // in-flight sub-calls get the signal; cap the wait for the rest
          drainCap = setTimeout(() => {
            if (!settledFlag) {
              settledFlag = true;
              cleanup();
              resolve({
                content: `run_code ended with sub-calls that never completed (drain deadline); ${terminal?.content ?? ""}`,
                isError: true,
              });
            }
          }, DRAIN_CAP_MS);
        }
        maybeSettle();
      };
      const accept = (fn: () => Promise<void>): boolean => {
        if (closed) return false;
        pending += 1;
        void enqueue(async () => {
          try {
            await fn();
          } finally {
            pending -= 1;
            maybeSettle();
          }
        });
        return true;
      };

      const onAbort = (): void => {
        const reason = timeoutSignal.aborted
          ? `run_code timed out after ${timeoutMs}ms (worker terminated; in-flight sub-calls aborted)`
          : "run_code aborted (worker terminated; in-flight sub-calls aborted)";
        closeWith({ content: reason, isError: true }, true);
      };
      if (runSignal.aborted) onAbort();
      else runSignal.addEventListener("abort", onAbort, { once: true });
      // wall-clock backstop slightly after the signal (signal is primary)
      setTimeout(() => {
        if (timeoutSignal.aborted) onAbort();
      }, timeoutMs + 50);

      worker.on("message", (msg: { type: string; value?: string; message?: string } & Subcall) => {
        if (msg.type === "ready") {
          worker.postMessage({ type: "run", code: javascript, idPrefix: `rc-${nodeCrypto.randomUUID().slice(0, 8)}` });
          return;
        }
        if (msg.type === "done") {
          closeWith({ content: truncateMiddle(msg.value ?? "(no return value)", 20_000), isError: false }, false);
          return;
        }
        if (msg.type === "error") {
          closeWith({ content: truncateMiddle(msg.message ?? "unknown error", 20_000), isError: true }, true);
          return;
        }
        if (msg.type === "call") {
          const accepted = accept(async () => {
            const tool = tools.find((t) => t.name === msg.name) ?? null;
            if (!tool) {
              worker.postMessage({ type: "result", id: msg.id, isError: true, content: `unknown tool: ${msg.name}` });
              return;
            }
            // WAL intent first; a failed intent write BLOCKS execution (the
            // sub-call answers with an error instead of running the tool)
            try {
              ctx.dispatch?.({ type: "tool_call", callId: msg.id, name: msg.name, args: msg.args }, { sync: true });
            } catch (e) {
              worker.postMessage({ type: "result", id: msg.id, isError: true, content: `WAL intent failed, tool not executed: ${e instanceof Error ? e.message : String(e)}` });
              return;
            }
            let result: ToolResult;
            try {
              const args = (typeof msg.args === "object" && msg.args !== null ? msg.args : {}) as Record<string, unknown>;
              result = await tool.execute(args, subCtx);
            } catch (e) {
              result = { content: `tool crashed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
            }
            ctx.dispatch?.({ type: "tool_result", callId: msg.id, name: msg.name, content: result.content, isError: result.isError });
            worker.postMessage({ type: "result", id: msg.id, isError: result.isError, content: result.content, toolName: msg.name });
          });
          if (!accepted) {
            // run already ended — answer so the (soon-dead) worker isn't stuck
            worker.postMessage({ type: "result", id: msg.id, isError: true, content: "run_code already ended; call not executed" });
          }
        }
      });

      worker.on("error", (e) => {
        closeWith({ content: `worker crashed: ${e.message}`, isError: true }, true);
      });
    });

    return await done;
  } catch (e) {
    return { content: `run_code failed to start: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

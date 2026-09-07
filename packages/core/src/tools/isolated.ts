/**
 * V8-isolate runtime for run_code (isolated-vm): a REAL security boundary,
 * unlike the worker mode ("containment, not security"). The guest sees no
 * process/fs/network — only the `tools` binding, bridged through a host
 * callback whose every execution is WAL-recorded and policy-checked exactly
 * like a native tool call.
 *
 * isolated-vm is an optional native dependency: when the import fails
 * (platform without a prebuilt/compilable binary), callers fall back to the
 * worker runtime.
 */

import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

export interface IsolatedRunOptions {
  code: string; // already TS-stripped JavaScript with top-level `return` legal
  timeoutMs: number;
}

interface IvmModule {
  Isolate: new (options: { memoryLimit: number }) => IvmIsolate;
  Reference: new (value: unknown) => unknown;
  Callback: new (fn: (...args: unknown[]) => unknown, options?: { async?: boolean; sync?: boolean; ignored?: boolean }) => unknown;
}

interface IvmRunOptions {
  timeout?: number;
  promise?: boolean;
  arguments?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface IvmScript {
  run: (context: IvmContext, options?: IvmRunOptions) => Promise<unknown>;
  runSync: (context: IvmContext, options?: IvmRunOptions) => unknown;
}

interface IvmIsolate {
  createContextSync: () => IvmContext;
  compileScript: (code: string) => Promise<IvmScript>;
  dispose: () => void;
}

interface IvmContext {
  global: IvmJail;
  evalSync: (code: string) => unknown;
}

interface IvmJail {
  setSync: (key: string, value: unknown) => void;
  derefInto: () => unknown;
}

export async function isIsolatedVmAvailable(): Promise<boolean> {
  try {
    await loadIvm();
    return true;
  } catch { return false; }
}

/**
 * isolated-vm must be required CJS-style: its exports are assigned via a
 * mutating getter (`lib`), which cannot run against a frozen ESM namespace —
 * a dynamic import() yields Isolate === undefined.
 */
let ivmCache: IvmModule | null = null;
async function loadIvm(): Promise<IvmModule> {
  if (ivmCache === null) {
    // 1) ESM namespace is frozen so the module's mutating `lib` getter never
    //    runs — a plain import() yields Isolate === undefined
    // 2) ESM files have no require global either — createRequire bridges
    const { createRequire } = await import("node:module");
    const nodeRequire = createRequire(import.meta.url);
    ivmCache = nodeRequire("isolated-vm") as IvmModule;
  }
  return ivmCache;
}

/**
 * Runs the program inside a fresh V8 isolate. Sub-calls execute on the HOST
 * through `dispatch` (serialized, WAL-recorded) — the guest cannot reach the
 * tools except through this bridge.
 */
export async function runCodeIsolated(
  options: IsolatedRunOptions,
  dispatch: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
  let ivm: IvmModule;
  try {
    ivm = await loadIvm();
  } catch (e) {
    return { content: `isolated runtime unavailable: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }

  const isolate = new ivm.Isolate({ memoryLimit: 128 });
  const context = isolate.createContextSync();
  const jail = context.global;
  jail.setSync("global", jail.derefInto());

  // the ONLY host capability the guest gets: a Reference the guest invokes
  // via applySyncPromise — the documented v7 pattern for "guest awaits host
  // async work". Values cross as JSON strings (structured-clone-safe).
  const hostFn = async (name: unknown, argsJson: unknown): Promise<string> => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(String(argsJson ?? "{}")) as Record<string, unknown>; } catch { /* empty */ }
    const result = await dispatch(typeof name === "string" ? name : "", args);
    return JSON.stringify({ content: result.content, isError: result.isError });
  };
  const hostRef = new ivm.Reference(hostFn);
  jail.setSync("__saberHostRef", hostRef);

  // guest-side bootstrap: tools proxy over the host bridge
  const bootstrap = `
    globalThis.tools = new Proxy({}, {
      get: (_t, name) => {
        if (typeof name !== "string") return undefined;
        return async (args = {}) => {
          const raw = await __saberHostRef.applySyncPromise(undefined, [name, JSON.stringify(args)]);
          const response = JSON.parse(raw);
          if (response.isError) {
            const err = new Error(name + " failed: " + response.content);
            err.toolName = name;
            throw err;
          }
          return response.content;
        };
      },
    });
  `;
  context.evalSync(bootstrap);

  // the program: compiled sync-first for syntax errors, then run async
  const wrapped = `(async () => { ${options.code}\n })()`;
  let script: IvmScript;
  try {
    script = await isolate.compileScript(wrapped);
  } catch (e) {
    isolate.dispose();
    return { content: `code compile failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }

  // wall clock: dispose the isolate when the deadline passes — an uncooperative
  // program (busy loop, deep await) cannot outlive it
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { isolate.dispose(); } catch { /* already gone */ }
  }, options.timeoutMs);

  try {
    const value = await script.run(context, { promise: true });
    const rendered = typeof value === "string" ? value : String(value);
    return { content: rendered.slice(0, 20_000) || "(no return value)", isError: false };
  } catch (e) {
    if (timedOut) {
      return { content: `run_code timed out after ${options.timeoutMs}ms (isolate disposed)`, isError: true };
    }
    return { content: String((e as Error)?.stack ?? e).slice(0, 20_000), isError: true };
  } finally {
    clearTimeout(timer);
    try { isolate.dispose(); } catch { /* already disposed */ }
  }
}

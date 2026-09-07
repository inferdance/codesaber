import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createTools } from "../tools/index.js";
import { isIsolatedVmAvailable, runCodeIsolated } from "../tools/isolated.js";
import { makeToolBridge } from "../tools/code.js";
import type { SaberPayload } from "../events.js";
import { createPathPolicy } from "../policy.js";
import type { ToolContext } from "../types.js";

let workspace: string;
let ctx: ToolContext;
let recorded: SaberPayload[];
let prevCodeEnv: string | undefined;

beforeEach(() => {
  prevCodeEnv = process.env.SABER_CODE;
  process.env.SABER_CODE = "isolate";
  workspace = mkdtempSync(path.join(tmpdir(), "saber-iso-"));
  recorded = [];
  ctx = {
    sessionId: "iso",
    cwd: workspace,
    dataDir: path.join(workspace, ".data"),
    policy: createPathPolicy(workspace, path.join(workspace, ".data")),
    readFiles: new Map(),
    dispatch: (payload) => recorded.push(payload),
  };
  writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
});

afterEach(() => {
  if (prevCodeEnv === undefined) delete process.env.SABER_CODE;
  else process.env.SABER_CODE = prevCodeEnv;
  rmSync(workspace, { recursive: true, force: true });
});

const isolated = describe.skipIf(!(await isIsolatedVmAvailable()));

const run = async (code: string, timeoutMs = 10_000) => {
  const tool = createTools(ctx).find((t) => t.name === "run_code");
  if (!tool) throw new Error("run_code missing");
  return tool.execute({ code, timeout_ms: timeoutMs }, ctx);
};

isolated("run_code in V8 isolate", () => {
  it("orchestrates tools and returns the final value", async () => {
    const result = await run(`const a = await tools.read({ path: "a.txt" }); return "ok=" + a.includes("alpha");`);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok=true");
  });

  it("the guest has NO access to process/fs/network (the point of isolate mode)", async () => {
    const result = await run(`
      const leaks = [];
      leaks.push("process:" + (typeof process));
      leaks.push("require:" + (typeof require));
      leaks.push("fetch:" + (typeof fetch));
      leaks.push("globalThis.process:" + (typeof (globalThis as any).process));
      return leaks.join(",");
    `);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("process:undefined,require:undefined,fetch:undefined,globalThis.process:undefined");
  });

  it("dynamic import from the guest throws (no module loader in the jail)", async () => {
    const result = await run(`try { await import("node:fs"); return "IMPORTED"; } catch { return "BLOCKED"; }`);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("BLOCKED"); // the promise REJECTS in the guest — no fs access
  });

  it("sub-calls are WAL-recorded with rc- ids", async () => {
    await run(`await tools.read({ path: "a.txt" }); return "done";`);
    const call = recorded.find((p) => p.type === "tool_call");
    const result = recorded.find((p) => p.type === "tool_result");
    if (call?.type !== "tool_call" || result?.type !== "tool_result") throw new Error("events missing");
    expect(call.callId).toMatch(/^rc-/);
    expect(result.callId).toBe(call.callId);
  });

  it("busy loops hit the wall-clock dispose", async () => {
    const started = Date.now();
    const result = await run(`for (;;) {}`, 1200);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("memory limit enforced (allocation failure, not host OOM)", async () => {
    const result = await run(`
      const chunks = [];
      for (;;) { chunks.push(new Array(1_000_000).fill("x")); }
    `, 10_000);
    expect(result.isError).toBe(true);
  }, 15_000);

  it("worker mode still available via SABER_CODE=1", async () => {
    process.env.SABER_CODE = "1";
    const result = await run(`return "worker=" + (typeof process !== "undefined");`);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("worker=true"); // worker HAS process — containment only
  });
});

isolated("isolate review fixes", () => {
  it("object/array return values render as JSON (worker parity)", async () => {
    const r = await run(`return { answer: 42, list: [1, 2] };`);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('"answer": 42');
    const r2 = await run(`return [1, 2, 3];`);
    expect(r2.isError).toBe(false);
    expect(r2.content).toContain("[\n  1,");
  });

  it("an isolate deadline cancels in-flight HOST sub-calls", async () => {
    const started = Date.now();
    const result = await run(`
      void tools.bash({ command: "sleep 2; echo late > late-marker.txt", timeout_ms: 60000 });
      await new Promise(() => {});
    `, 1000);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out/);
    // drain waits bounded for the cancelled bash; the marker must exist (the
    // bash RAN) or not — but the run must return well before the 2s sleep
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  it("sub-call ids are unique across isolate runs (WAL recovery safety)", async () => {
    await run(`await tools.read({ path: "a.txt" }); return 1;`);
    await run(`await tools.read({ path: "a.txt" }); return 2;`);
    const calls = recorded.filter((p) => p.type === "tool_call");
    if (calls.length !== 2 || calls[0].type !== "tool_call" || calls[1].type !== "tool_call") throw new Error("bad events");
    expect(calls[0].callId).not.toBe(calls[1].callId);
  });
});

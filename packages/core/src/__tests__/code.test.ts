import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createTools } from "../tools/index.js";
import type { SaberPayload } from "../events.js";
import { createPathPolicy } from "../policy.js";
import { SessionLog, recoverSession } from "../session.js";
import type { ToolContext } from "../types.js";

let workspace: string;
let ctx: ToolContext;
let recorded: SaberPayload[];

let prevCodeEnv: string | undefined;

beforeEach(() => {
  prevCodeEnv = process.env.SABER_CODE;
  process.env.SABER_CODE = "1"; // run_code is opt-in since the trust-model fix
  workspace = mkdtempSync(path.join(tmpdir(), "saber-code-"));
  recorded = [];
  ctx = {
    sessionId: "code-test",
    cwd: workspace,
    dataDir: path.join(workspace, ".data"),
    policy: createPathPolicy(workspace, path.join(workspace, ".data")),
    readFiles: new Map(),
    dispatch: (payload) => recorded.push(payload),
  };
  writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
  writeFileSync(path.join(workspace, "b.txt"), "beta\n");
});

afterEach(() => {
  if (prevCodeEnv === undefined) delete process.env.SABER_CODE;
  else process.env.SABER_CODE = prevCodeEnv;
  rmSync(workspace, { recursive: true, force: true });
});

const tool = () => {
  const t = createTools(ctx).find((t) => t.name === "run_code");
  if (!t) throw new Error("run_code not registered");
  return t;
};

const run = (code: string, timeout_ms?: number) =>
  tool().execute({ code, ...(timeout_ms ? { timeout_ms } : {}) }, ctx);

describe("run_code", () => {
  it("orchestrates tools and returns the final value", async () => {
    const result = await run(`
      const a = await tools.read({ path: "a.txt" });
      return "has-alpha=" + a.includes("alpha");
    `);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("has-alpha=true");
  });

  it("supports Promise.all over read-only tools", async () => {
    const result = await run(`
      const [a, b] = await Promise.all([
        tools.read({ path: "a.txt" }),
        tools.read({ path: "b.txt" }),
      ]);
      return "both=" + (a.includes("alpha") && b.includes("beta"));
    `);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("both=true");
  });

  it("surfaces tool failures as errors with the tool name", async () => {
    const result = await run(`await tools.read({ path: "missing.txt" })`);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read failed/);
  });

  it("rejects unknown tool names", async () => {
    const result = await run(`await tools.nope({})`);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unknown tool: nope/);
  });

  it("reports TypeScript syntax errors", async () => {
    const result = await run(`const x: = ;`);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/transform failed|SyntaxError/i);
  });

  it("times out runaway programs and terminates the worker", async () => {
    const started = Date.now();
    const result = await run(`await new Promise(() => {})`, 1500);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("records sub-calls to the WAL sink (model-visible ⟺ logged)", async () => {
    await run(`await tools.read({ path: "a.txt" }); return "ok";`);
    const call = recorded.find((p) => p.type === "tool_call");
    const result = recorded.find((p) => p.type === "tool_result");
    if (call?.type !== "tool_call" || result?.type !== "tool_result") throw new Error("sub-call events missing");
    expect(call.name).toBe("read");
    expect(call.callId).toMatch(/^rc-/);
    expect(result.callId).toBe(call.callId);
    expect(result.isError).toBe(false);
  });

  it("is NOT registered by default (opt-in only)", async () => {
    delete process.env.SABER_CODE;
    expect(createTools(ctx).find((t) => t.name === "run_code")).toBeUndefined();
  });

  it("does not return until a fire-and-forget sub-call's side effect landed", async () => {
    const result = await run(`
      void tools.bash({ command: "sleep 0.3; echo late > late.txt" });
      return "returned early";
    `);
    expect(result.isError).toBe(false);
    // the queue must drain before run_code settles — the file exists NOW
    expect(existsSync(path.join(workspace, "late.txt"))).toBe(true);
  }, 15_000);

  it("aborting the turn kills an in-flight sub-bash and ends the run", async () => {
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const pending = run(`
      await tools.bash({ command: "sleep 30", timeout_ms: 60000 });
      return "never";
    `);
    await new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = (): void => {
        if (recorded.some((p) => p.type === "tool_call")) return resolve();
        if (Date.now() - started > 4000) throw new Error("sub-call never dispatched");
        setTimeout(tick, 10);
      };
      tick();
    });
    const abortedAt = Date.now();
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/aborted/);
    expect(Date.now() - abortedAt).toBeLessThan(5_000); // not waiting on the 30s sleep
    delete ctx.signal;
  }, 15_000);

  it("sub-call ids are unique across runs (WAL recovery cannot be shadowed)", async () => {
    const sessionsDir = path.join(workspace, ".data", "sessions");
    const session = SessionLog.create(sessionsDir, "rc-ids", {});
    const ctx2: ToolContext = { ...ctx, dispatch: (payload, opts) => { session.record(payload, opts); } };
    const tools2 = createTools(ctx2);
    const rc = tools2.find((t) => t.name === "run_code");
    if (!rc) throw new Error("missing run_code");
    // run 1 completes fully; run 2 gets only its intent recorded (simulated
    // crash) — recovery must STILL flag run 2's call as unfinished
    await rc.execute({ code: 'await tools.read({ path: "a.txt" }); return "ok";' }, ctx2);
    const run2 = rc.execute({ code: 'await tools.read({ path: "a.txt" }); return "ok";' }, ctx2);
    const seen = new Set<SaberPayload>();
    const origDispatch = ctx2.dispatch;
    if (!origDispatch) throw new Error("dispatch missing");
    ctx2.dispatch = (payload, opts) => {
      seen.add(payload);
      if (payload.type === "tool_result") {
        // simulate crash right before run 2's result lands
        ctx2.dispatch = () => {};
        return;
      }
      origDispatch(payload, opts);
    };
    await run2;
    ctx2.dispatch = origDispatch;
    session.close();

    const recovered = recoverSession(session.path);
    expect(recovered.unfinishedToolCalls.length).toBe(1); // run 2's intent is flagged, not shadowed
  });

  it("rejects non-erasable TypeScript (enums) with a clear contract message", async () => {
    const result = await run("enum Mode { Read }\nreturn Mode.Read;");
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/erasable TypeScript|enum/i);
  });
});

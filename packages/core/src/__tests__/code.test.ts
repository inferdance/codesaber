import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createTools } from "../tools/index.js";
import type { SaberPayload } from "../events.js";
import { createPathPolicy } from "../policy.js";
import type { ToolContext } from "../types.js";

let workspace: string;
let ctx: ToolContext;
let recorded: SaberPayload[];

beforeEach(() => {
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

  it("SABER_CODE=0 unregisters the tool", async () => {
    const previous = process.env.SABER_CODE;
    process.env.SABER_CODE = "0";
    try {
      expect(createTools(ctx).find((t) => t.name === "run_code")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.SABER_CODE;
      else process.env.SABER_CODE = previous;
    }
  });
});

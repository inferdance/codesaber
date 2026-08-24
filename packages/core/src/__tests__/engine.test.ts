import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMockProvider, zeroUsage, type Provider, type ProviderEvent } from "@saber/ai";
import { Engine, SessionLog, createPathPolicy, createTools, type ToolContext } from "../index.js";

let workspace: string;
let dataDir: string;
let ctx: ToolContext;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "saber-engine-"));
  dataDir = path.join(workspace, ".data");
  ctx = {
    sessionId: "engine-test",
    cwd: workspace,
    dataDir,
    policy: createPathPolicy(workspace, dataDir),
    readFiles: new Map(),
  };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeEngine(steps: ProviderEvent[][]): Engine {
  const session = SessionLog.create(path.join(dataDir, "sessions"), `t-${Date.now()}-${Math.random()}`, {});
  return new Engine({
    provider: createMockProvider("mock", steps),
    tools: createTools(ctx),
    session,
    toolContext: ctx,
    model: "mock",
  });
}

const callStep = (id: string, name: string, args: Record<string, unknown>): ProviderEvent[] => [
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", id, arguments_delta: JSON.stringify(args) },
  { type: "finish", reason: "tool_calls", usage: zeroUsage() },
];

const textStep = (text: string): ProviderEvent[] => [
  { type: "text_delta", text_delta: text },
  { type: "finish", reason: "stop", usage: zeroUsage() },
];

describe("engine failure paths", () => {
  it("aborts a doom loop after three identical calls", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "content\n");
    const step = callStep("c1", "read", { path: "a.txt" });
    const engine = makeEngine([step, step, step, textStep("never reached")]);
    const { outcome } = await engine.runTurn({ userMessage: "loop forever" });
    expect(outcome.kind).toBe("doom_loop");
  });

  it("refuses tool calls when the model was truncated (length)", async () => {
    const engine = makeEngine([[
      { type: "tool_call_start", id: "c1", name: "read" },
      { type: "tool_call_delta", id: "c1", arguments_delta: JSON.stringify({ path: "a.txt" }) },
      { type: "finish", reason: "length", usage: zeroUsage() },
    ]]);
    const { outcome } = await engine.runTurn({ userMessage: "truncated" });
    expect(outcome.kind).toBe("length_refusal");
  });

  it("surfaces provider failure as a terminal outcome, not a throw", async () => {
    const engine = makeEngine([[
      { type: "error", message: "HTTP 401: bad key", retryable: "fatal" },
    ]]);
    const { outcome } = await engine.runTurn({ userMessage: "hi" });
    expect(outcome.kind).toBe("provider_failure");
    if (outcome.kind === "provider_failure") expect(outcome.message).toMatch(/401/);
  });

  it("aborts cleanly when the signal fires before a step", async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = makeEngine([textStep("never")]);
    const { outcome } = await engine.runTurn({ userMessage: "hi", signal: controller.signal });
    expect(outcome.kind).toBe("aborted");
  });

  it("rejects a concurrent second turn with busy (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: Provider = {
      name: "slow",
      async *stream(): AsyncGenerator<ProviderEvent> {
        await gate;
        yield { type: "finish", reason: "stop", usage: zeroUsage() };
      },
    };
    const session = SessionLog.create(path.join(dataDir, "sessions"), `busy-${Date.now()}`, {});
    const engine = new Engine({
      provider: slow, tools: createTools(ctx), session, toolContext: ctx, model: "mock",
    });

    const first = engine.runTurn({ userMessage: "one" });
    await new Promise((r) => setImmediate(r));
    const second = await engine.runTurn({ userMessage: "two" });
    expect(second.outcome.kind).toBe("busy");

    release();
    const settled = await first;
    expect(settled.outcome.kind).toBe("done");
  });
});

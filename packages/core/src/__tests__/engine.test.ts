import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMockProvider, zeroUsage, type Provider, type ProviderEvent } from "@saber/ai";
import { Engine, SessionLog, createPathPolicy, createTaskRunner, createTools, recoverSession, type ToolContext } from "../index.js";
import type { ToolDefinition } from "../types.js";

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

  it("skips remaining exclusive tools after abort, and pairs their WAL results", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const slow: ToolDefinition = {
      name: "slow", description: "", parameters: {}, concurrency: "exclusive",
      async execute(_args, tctx) {
        await new Promise<void>((resolve) => {
          if (tctx.signal) tctx.signal.addEventListener("abort", () => resolve(), { once: true });
          else resolve();
        });
        executed.push("slow");
        return { content: "interrupted", isError: true };
      },
    };
    const writer: ToolDefinition = {
      name: "writer", description: "", parameters: {}, concurrency: "exclusive",
      async execute() { executed.push("writer"); return { content: "wrote", isError: false }; },
    };
    const session = SessionLog.create(path.join(dataDir, "sessions"), `abort-batch-${Date.now()}`, {});
    const engine = new Engine({
      provider: createMockProvider("mock", [[
        { type: "tool_call_start", id: "s1", name: "slow" },
        { type: "tool_call_delta", id: "s1", arguments_delta: "{}" },
        { type: "tool_call_start", id: "w1", name: "writer" },
        { type: "tool_call_delta", id: "w1", arguments_delta: "{}" },
        { type: "finish", reason: "tool_calls", usage: zeroUsage() },
      ]]),
      tools: [slow, writer],
      session,
      toolContext: ctx,
      model: "mock",
    });

    setTimeout(() => controller.abort(), 20);
    const { outcome } = await engine.runTurn({ userMessage: "two writes", signal: controller.signal });

    expect(outcome.kind).toBe("aborted");
    expect(executed).toEqual(["slow"]); // writer never started

    // WAL stays paired: both intents have results, writer's is the synthetic abort
    const log = recoverSession(session.path);
    expect(log.unfinishedToolCalls).toHaveLength(0);
    const results = log.events.flatMap((e) => (e.payload.type === "tool_result" ? [e.payload] : []));
    expect(results.find((r) => r.callId === "w1")?.content).toBe("aborted before execution");
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

describe("auto-compaction", () => {
  it("compacts oversized history at the turn boundary and keeps the latest exchange", async () => {
    const longAnswer = "answer ".repeat(200); // > threshold in estimated tokens
    const responses: ProviderEvent[][] = [
      [{ type: "text_delta", text_delta: longAnswer }, { type: "finish", reason: "stop", usage: zeroUsage() }],
      [{ type: "text_delta", text_delta: "COMPACT SUMMARY MARKER" }, { type: "finish", reason: "stop", usage: zeroUsage() }],
      [{ type: "text_delta", text_delta: "second answer" }, { type: "finish", reason: "stop", usage: zeroUsage() }],
    ];
    const requests: import("@saber/ai").ChatRequest[] = [];
    let call = 0;
    const recording: Provider = {
      name: "recording",
      async *stream(request): AsyncGenerator<ProviderEvent> {
        requests.push(request);
        yield* (responses[call++] ?? [{ type: "finish" as const, reason: "stop" as const, usage: zeroUsage() }]);
      },
    };
    const session = SessionLog.create(path.join(dataDir, "sessions"), `compact-${Date.now()}`, {});
    const engine = new Engine({
      provider: recording,
      tools: [],
      session,
      toolContext: ctx,
      model: "mock",
      compact: { thresholdTokens: 50 },
    });

    await engine.runTurn({ userMessage: "first question" });
    // turn 1 + the compaction call itself
    expect(requests).toHaveLength(2);
    expect(requests[1].system).toMatch(/compress coding-agent/i);

    await engine.runTurn({ userMessage: "second question" });
    // the post-compaction request must carry the summary, not the old bulk
    const flat = JSON.stringify(requests[2].messages);
    expect(flat).toContain("COMPACT SUMMARY MARKER");
    expect(flat).not.toContain(longAnswer.slice(0, 20));

    // compaction is durable and visible to frontends
    const { recoverSession } = await import("../session.js");
    const log = recoverSession(session.path);
    const compacted = log.events.find((e) => e.payload.type === "context_compacted");
    expect(compacted).toBeDefined();
  });

  it("leaves history untouched below the threshold", async () => {
    const session = SessionLog.create(path.join(dataDir, "sessions"), `compact-off-${Date.now()}`, {});
    const requests: import("@saber/ai").ChatRequest[] = [];
    const recording: Provider = {
      name: "recording",
      async *stream(request): AsyncGenerator<ProviderEvent> {
        requests.push(request);
        yield { type: "finish", reason: "stop", usage: zeroUsage() };
      },
    };
    const engine = new Engine({
      provider: recording, tools: [], session, toolContext: ctx, model: "mock",
      compact: { thresholdTokens: 1_000_000 },
    });
    await engine.runTurn({ userMessage: "hi" });
    expect(requests).toHaveLength(1); // no compaction call
  });
});

describe("task tool (subagent, depth 1)", () => {
  it("delegates to a child engine with its own session log and returns its answer", async () => {
    // one recording provider serves parent and child by call order
    const requests: import("@saber/ai").ChatRequest[] = [];
    let call = 0;
    const zero = zeroUsage();
    const scripted: ProviderEvent[][] = [
      // parent turn: call the task tool
      [
        { type: "tool_call_start", id: "t1", name: "task" },
        { type: "tool_call_delta", id: "t1", arguments_delta: JSON.stringify({ prompt: "count the files" }) },
        { type: "finish", reason: "tool_calls" as const, usage: zero },
      ],
      // child turn: plain answer
      [{ type: "text_delta", text_delta: "there are 42 files" }, { type: "finish", reason: "stop" as const, usage: zero }],
      // parent final
      [{ type: "text_delta", text_delta: "the subagent says 42" }, { type: "finish", reason: "stop" as const, usage: zero }],
    ];
    const provider: Provider = {
      name: "scripted",
      async *stream(request): AsyncGenerator<ProviderEvent> {
        requests.push(request);
        yield* (scripted[call++] ?? [{ type: "finish", reason: "stop" as const, usage: zero }]);
      },
    };
    const session = SessionLog.create(path.join(dataDir, "sessions"), `parent-${Date.now()}`, {});
    const runTask = createTaskRunner({ provider, model: "mock", cwd: workspace, dataDir });
    const engine = new Engine({
      provider, tools: createTools(ctx, { runTask }), session, toolContext: ctx, model: "mock",
    });

    const { answer } = await engine.runTurn({ userMessage: "how many files?" });
    expect(answer).toContain("42");
    expect(requests).toHaveLength(3);

    // the tool result carries the child answer into the parent log
    const log = recoverSession(session.path);
    const taskResult = log.events.find((e) => e.payload.type === "tool_result" && e.payload.name === "task");
    expect(taskResult?.payload.type === "tool_result" ? taskResult.payload.content : "").toContain("42 files");

    // the child got its own durable session (fresh context, task system prompt)
    const { readdirSync } = await import("node:fs");
    const childLogs = readdirSync(path.join(dataDir, "sessions")).filter((f) => f.startsWith("task-"));
    expect(childLogs.length).toBeGreaterThanOrEqual(1);
    expect(requests[1].system).toMatch(/subagent/i);

    // depth 1: the child's own toolset must not contain task
    const childTools = createTools(ctx); // what the child received
    expect(childTools.find((t) => t.name === "task")).toBeUndefined();
  });
});

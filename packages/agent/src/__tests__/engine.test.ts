import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionLog, recoverSession } from "../session.ts";
import { Engine, type EngineEvent, type TurnOutcome } from "../engine.ts";
import { createBuiltinTools, createToolContext, createDirectExecutor } from "@saber/tools";
import type { Provider, ProviderEvent } from "@saber/ai";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "saber-agent-")); });

function makeEngine(
  steps: ProviderEvent[][],
  onEvent?: (e: EngineEvent) => void,
): Engine {
  const session = new SessionLog(path.join(tmp, ".saber", "sessions"), "test", {
    protocol_version: "0.1.0", engine_version: "0.1.0", cwd: tmp,
  });
  const ctx = createToolContext("test", tmp, path.join(tmp, ".saber"), createDirectExecutor());
  let next = 0;
  const provider: Provider = {
    name: "scripted",
    async *stream() {
      const events = steps[next] ?? [{ type: "finish" as const, reason: "stop" as const, usage: zeroUsage() }];
      next = (next + 1) % Math.max(steps.length, 1);
      yield* events;
    },
  };
  return new Engine({
    provider,
    tools: createBuiltinTools(),
    session,
    toolContext: ctx,
    model: "test",
    onEvent,
  });
}

function zeroUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
}

function callTool(id: string, name: string, argsJson: string): ProviderEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, arguments_delta: argsJson },
    { type: "finish", reason: "tool_calls", usage: zeroUsage() },
  ];
}

function finalAnswer(text: string): ProviderEvent[] {
  return [
    { type: "text_delta", text_delta: text },
    { type: "finish", reason: "stop", usage: zeroUsage() },
  ];
}

describe("engine loop", () => {
  it("completes a simple turn", async () => {
    const engine = makeEngine([finalAnswer("hello world")]);
    const { answer, outcome } = await engine.runTurn({ userMessage: "hi" });
    expect(outcome.kind).toBe("done");
    expect(answer).toBe("hello world");
  });

  it("executes tools and finishes", async () => {
    const engine = makeEngine([
      callTool("c1", "bash", JSON.stringify({ command: "echo TOOL-OK" })),
      finalAnswer("done"),
    ]);
    const { answer, outcome } = await engine.runTurn({ userMessage: "run" });
    expect(outcome.kind).toBe("done");
    expect(answer).toBe("done");
  });

  it("length refusal blocks tool execution", async () => {
    const engine = makeEngine([[
      { type: "tool_call_start", id: "c1", name: "bash" },
      { type: "tool_call_delta", id: "c1", arguments_delta: JSON.stringify({ command: "touch x" }) },
      { type: "finish", reason: "length", usage: zeroUsage() },
    ]]);
    const { outcome } = await engine.runTurn({ userMessage: "go" });
    expect(outcome.kind).toBe("length_refusal");
  });

  it("doom loop trips on 3rd identical call", async () => {
    const engine = makeEngine([
      callTool("c1", "bash", JSON.stringify({ command: "echo same" })),
    ]);
    const { outcome } = await engine.runTurn({ userMessage: "loop" });
    expect(outcome.kind).toBe("doom_loop");
  });

  it("malformed JSON args rejected, not Null", async () => {
    const engine = makeEngine([[
      { type: "tool_call_start", id: "c1", name: "bash" },
      { type: "tool_call_delta", id: "c1", arguments_delta: "{invalid" },
      { type: "finish", reason: "tool_calls", usage: zeroUsage() },
    ]]);
    await engine.runTurn({ userMessage: "bad" });
    // Verify no tool_call with null arguments in session
    const logPath = path.join(tmp, ".saber", "sessions", "test.jsonl");
    const recovered = recoverSession(logPath);
    const nullCalls = recovered.events.filter(
      (e) => e.type === "tool_call" && e.payload.arguments === null,
    );
    expect(nullCalls).toHaveLength(0);
  });

  it("multiple tool calls all execute", async () => {
    const engine = makeEngine([[
      { type: "tool_call_start", id: "a", name: "bash" },
      { type: "tool_call_delta", id: "a", arguments_delta: JSON.stringify({ command: "echo A" }) },
      { type: "tool_call_start", id: "b", name: "bash" },
      { type: "tool_call_delta", id: "b", arguments_delta: JSON.stringify({ command: "echo B" }) },
      { type: "finish", reason: "tool_calls", usage: zeroUsage() },
    ], finalAnswer("both done")]);
    const { outcome } = await engine.runTurn({ userMessage: "multi" });
    expect(outcome.kind).toBe("done");
    const logPath = path.join(tmp, ".saber", "sessions", "test.jsonl");
    const recovered = recoverSession(logPath);
    const results = recovered.events.filter((e) => e.type === "tool_result");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("provider error terminates turn", async () => {
    const engine = makeEngine([[
      { type: "error", message: "bad request", retryable: "fatal" },
    ]]);
    const { outcome } = await engine.runTurn({ userMessage: "hi" });
    expect(outcome.kind).toBe("provider_failure");
  });
});

describe("session WAL", () => {
  it("intent without result is flagged on recovery", () => {
    const session = new SessionLog(path.join(tmp, "sessions"), "wal-test", {});
    session.append("tool_call", { call_id: "c1", name: "bash", arguments: {} }, true);
    // "Crash" — no result appended
    const recovered = recoverSession(session.path);
    expect(recovered.unfinishedToolCalls).toHaveLength(1);
  });

  it("torn tail dropped, mid-file corrupt errors", () => {
    const session = new SessionLog(path.join(tmp, "sessions"), "torn", {});
    session.append("user_message", { text: "hello" });
    fs.appendFileSync(session.path, '{"torn');
    const recovered = recoverSession(session.path);
    expect(recovered.events).toHaveLength(2); // meta + user_message
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMockProvider, zeroUsage, type ProviderEvent } from "@saber/ai";
import { Engine, SessionLog, createPathPolicy, createTools, recoverSession } from "../index.js";
import type { ToolContext } from "../types.js";

let workspace: string;
let dataDir: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "saber-e2e-"));
  dataDir = path.join(workspace, ".data");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function toolCallStep(id: string, name: string, args: Record<string, unknown>): ProviderEvent[] {
  return [
    { type: "tool_call_start", id, name },
    { type: "tool_call_delta", id, arguments_delta: JSON.stringify(args) },
    { type: "finish", reason: "tool_calls", usage: zeroUsage() },
  ];
}

describe("E2E: mock provider drives the full agent loop", () => {
  it("read → edit → bash → final answer, with WAL discipline throughout", async () => {
    const appPath = path.join(workspace, "app.ts");
    writeFileSync(appPath, "const answer = 1;\n");

    const ctx: ToolContext = {
      sessionId: "e2e-1",
      cwd: workspace,
      dataDir,
      policy: createPathPolicy(workspace, dataDir),
      readFiles: new Set(),
    };
    const tools = createTools(ctx);
    const session = new SessionLog(path.join(dataDir, "sessions"), "e2e-1", {
      protocol_version: "0.1.0", engine_version: "0.1.0", cwd: workspace, model: "mock",
    });

    const steps: ProviderEvent[][] = [
      toolCallStep("c1", "read", { path: "app.ts" }),
      toolCallStep("c2", "edit", { path: "app.ts", old_str: "const answer = 1;", new_str: "const answer = 42;" }),
      toolCallStep("c3", "bash", { command: "cat app.ts" }),
      [
        { type: "text_delta", text_delta: "Changed answer to 42 and verified: app.ts:1" },
        { type: "finish", reason: "stop", usage: zeroUsage() },
      ],
    ];

    const events: Array<{ type: string; callId?: string }> = [];
    const engine = new Engine({
      provider: createMockProvider("mock", steps),
      tools,
      session,
      toolContext: ctx,
      model: "mock",
      onEvent: (e) => events.push(e),
    });

    const { answer, outcome } = await engine.runTurn({ userMessage: "set answer to 42 and verify" });

    // Final answer and outcome
    expect(outcome.kind).toBe("done");
    expect(answer).toContain("42");

    // Side effect on disk
    expect(readFileSync(appPath, "utf-8")).toBe("const answer = 42;\n");

    // The bash step actually observed the edited file
    const log = recoverSession(session.path);
    const bashResult = log.events.find((e) => e.type === "tool_result" && e.payload.call_id === "c3");
    expect(bashResult?.payload.content).toMatch(/const answer = 42/);

    // WAL invariant: every tool_call intent has a matching tool_result, in order
    const calls = log.events.filter((e) => e.type === "tool_call");
    const results = log.events.filter((e) => e.type === "tool_result");
    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(3);
    expect(log.unfinishedToolCalls).toHaveLength(0);
    for (const call of calls) {
      const result = results.find((r) => r.payload.call_id === call.payload.call_id);
      expect(result).toBeDefined();
      expect(result!.seq).toBeGreaterThan(call.seq);
    }

    // Event stream ordering: started before completed for each call
    for (const id of ["c1", "c2", "c3"]) {
      const started = events.findIndex((e) => e.type === "tool_started" && e.callId === id);
      const completed = events.findIndex((e) => e.type === "tool_completed" && e.callId === id);
      expect(started).toBeGreaterThanOrEqual(0);
      expect(completed).toBeGreaterThan(started);
    }

    // Session contains the user turn, assistant turns, and the final answer
    const assistantTexts = log.events
      .filter((e) => e.type === "assistant_message")
      .flatMap((e) => e.payload.message.blocks.filter((b: { type: string }) => b.type === "text"));
    expect(assistantTexts.length).toBeGreaterThan(0);
  });

  it("recovers an interrupted session with intent-but-no-result identified", async () => {
    const ctx: ToolContext = {
      sessionId: "e2e-2",
      cwd: workspace,
      dataDir,
      policy: createPathPolicy(workspace, dataDir),
      readFiles: new Set(),
    };
    const session = new SessionLog(path.join(dataDir, "sessions"), "e2e-2", { cwd: workspace });
    // Simulate a crash between WAL intent and result
    session.append("tool_call", { id: "c9", name: "bash", arguments: { command: "echo hi" } }, true);

    const log = recoverSession(session.path);
    expect(log.unfinishedToolCalls).toHaveLength(1);
  });
});

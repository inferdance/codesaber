import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { createMockProvider, zeroUsage, type ProviderEvent } from "@saber/ai";
import { createSaberServer } from "../index.js";

let workspace: string;
let dataDir: string;
let cleanup: Array<() => void> = [];

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "saber-server-"));
  dataDir = path.join(workspace, ".data");
});

afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
  rmSync(workspace, { recursive: true, force: true });
});

const toolCallStep = (id: string, name: string, args: Record<string, unknown>): ProviderEvent[] => [
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", id, arguments_delta: JSON.stringify(args) },
  { type: "finish", reason: "tool_calls", usage: zeroUsage() },
];

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    cleanup.push(() => socket.close());
  });
}

function once<T>(source: T[], predicate: (item: T) => boolean, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const found = source.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error("condition not met in time"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("server: WS round-trip with mock provider", () => {
  it("prompt → tool → events → projection, idempotent commands, replay on reconnect", async () => {
    const appPath = path.join(workspace, "app.ts");
    writeFileSync(appPath, "const answer = 1;\n");

    const steps: ProviderEvent[][] = [
      toolCallStep("c1", "read", { path: "app.ts" }),
      toolCallStep("c2", "edit", { path: "app.ts", old_str: "const answer = 1;", new_str: "const answer = 42;" }),
      [{ type: "text_delta", text_delta: "set to 42" }, { type: "finish", reason: "stop", usage: zeroUsage() }],
    ];

    const server = await createSaberServer({
      provider: createMockProvider("mock", steps),
      model: "mock",
      cwd: workspace,
      dataDir,
    });
    cleanup.push(() => server.close());

    const address = await server.listen();
    const wsUrl = `${address.replace("http", "ws")}/ws`;
    const socket = await openSocket(wsUrl);

    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    socket.send(JSON.stringify({ type: "prompt", commandId: "cmd-1", text: "set answer to 42" }));

    const ack = await once(messages, (m) => m.type === "ack" && m.commandId === "cmd-1") as { sessionId: string; started: boolean };
    expect(ack.started).toBe(true);
    const sessionId = ack.sessionId;
    expect(sessionId).toBeTruthy();

    // full event vocabulary flows over the wire
    await once(messages, (m) => m.type === "turn_complete");
    for (const type of ["user_message", "tool_call", "tool_result", "assistant_message", "turn_started", "turn_complete"]) {
      expect(messages.find((m) => m.type === type)).toBeDefined();
    }
    const toolResult = messages.find((m) => m.type === "tool_result") as { name?: string; sessionId?: string };
    expect(toolResult?.name).toBe("read");
    expect(toolResult?.sessionId).toBe(sessionId);

    // the side effect really happened
    expect(readFileSync(appPath, "utf-8")).toBe("const answer = 42;\n");

    // idempotency: the same commandId never starts a second turn
    socket.send(JSON.stringify({ type: "prompt", commandId: "cmd-1", text: "again" }));
    const dup = await once(messages, (m) => m.type === "ack" && m.commandId === "cmd-1" && m.duplicate === true);
    expect(dup).toBeDefined();

    // REST projection
    const projection = await server.app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(projection.statusCode).toBe(200);
    const body = projection.json() as { messages: Array<{ role: string; toolName?: string }>; isRunning: boolean };
    expect(body.isRunning).toBe(false);
    expect(body.messages.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(1);
    expect(body.messages.find((m) => m.role === "tool")?.toolName).toBe("read");

    // reconnect + replay from the log: durable events arrive again
    const socket2 = await openSocket(wsUrl);
    const replayed: Array<Record<string, unknown>> = [];
    socket2.on("message", (raw) => replayed.push(JSON.parse(raw.toString())));
    socket2.send(JSON.stringify({ type: "subscribe", sessionId, since: 0 }));
    await once(replayed, (m) => m.type === "turn_complete");
    expect(replayed.filter((m) => m.type === "user_message").length).toBeGreaterThanOrEqual(1);

    // health endpoint
    const health = await server.app.inject({ method: "GET", url: "/api/health" });
    expect(health.json()).toMatchObject({ ok: true, model: "mock" });
  });

  it("abort stops a running turn via WS command", async () => {
    const appPath = path.join(workspace, "app.ts");
    writeFileSync(appPath, "x\n");
    // bash sleeps long enough for the abort to land mid-turn
    const steps: ProviderEvent[][] = [
      toolCallStep("c1", "bash", { command: "sleep 30", timeout_ms: 60_000 }),
      [{ type: "text_delta", text_delta: "done" }, { type: "finish", reason: "stop", usage: zeroUsage() }],
    ];

    const server = await createSaberServer({
      provider: createMockProvider("mock", steps),
      model: "mock",
      cwd: workspace,
      dataDir,
    });
    cleanup.push(() => server.close());
    const address = await server.listen();
    const socket = await openSocket(`${address.replace("http", "ws")}/ws`);

    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ type: "prompt", commandId: "cmd-abort", text: "sleep" }));
    const ack = await once(messages, (m) => m.type === "ack" && m.kind === "prompt") as { sessionId: string };

    await once(messages, (m) => m.type === "tool_started");
    socket.send(JSON.stringify({ type: "abort", commandId: "cmd-abort-2", sessionId: ack.sessionId }));
    await once(messages, (m) => m.type === "ack" && m.kind === "abort" && m.ok === true);

    const complete = await once(messages, (m) => m.type === "turn_complete", 10_000) as { reason?: string };
    expect(complete.reason).toBe("aborted");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

  it("rejects session ids that try to escape the sessions directory", async () => {
    const server = await createSaberServer({
      provider: createMockProvider("mock", [[{ type: "finish", reason: "stop", usage: zeroUsage() }]]),
      model: "mock", cwd: workspace, dataDir,
    });
    cleanup.push(() => server.close());
    const address = await server.listen();
    const socket = await openSocket(`${address.replace("http", "ws")}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    socket.send(JSON.stringify({ type: "prompt", commandId: "evil-1", sessionId: "../../evil", text: "hi" }));
    // the zod protocol layer rejects the id before the manager ever sees it
    const err = await once(messages, (m) => m.type === "error") as { message?: string };
    expect(String(err.message)).toMatch(/sessionId/);
    expect(existsSync(path.join(workspace, "evil.jsonl"))).toBe(false);
    expect(existsSync(path.join(dataDir, "sessions", "..", "..", "evil.jsonl"))).toBe(false);
  });

  it("serializes prompts per session through the mailbox queue", async () => {
    // gate the first turn so the queueing is deterministic
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gated = {
      name: "gated",
      async *stream(): AsyncGenerator<ProviderEvent> {
        await gate;
        yield { type: "finish", reason: "stop" as const, usage: zeroUsage() };
      },
    };
    const server = await createSaberServer({
      provider: gated, model: "mock", cwd: workspace, dataDir,
    });
    cleanup.push(() => server.close());
    const address = await server.listen();
    const socket = await openSocket(`${address.replace("http", "ws")}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    socket.send(JSON.stringify({ type: "prompt", commandId: "q-1", text: "first" }));
    const ack1 = await once(messages, (m) => m.type === "ack" && m.commandId === "q-1") as { sessionId: string };
    socket.send(JSON.stringify({ type: "prompt", commandId: "q-2", sessionId: ack1.sessionId, text: "second" }));
    const ack2 = await once(messages, (m) => m.type === "ack" && m.commandId === "q-2") as { queued?: boolean };
    expect(ack2.queued).toBe(true);
    release();

    // both turns run, strictly one at a time, in order
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const completes = messages.filter((m) => m.type === "turn_complete");
        if (completes.length >= 2) return resolve();
        if (Date.now() - started > 5000) return reject(new Error("second turn never completed"));
        setTimeout(tick, 25);
      };
      tick();
    });
    const users = messages.filter((m) => m.type === "user_message");
    expect(users).toHaveLength(2);
    expect((users[0] as { message?: { blocks?: Array<{ text?: string }> } }).message?.blocks?.[0]?.text).toBe("first");
    expect((users[1] as { message?: { blocks?: Array<{ text?: string }> } }).message?.blocks?.[0]?.text).toBe("second");
  });

  it("reopens (never truncates) a session after server restart", async () => {
    const steps: ProviderEvent[][] = [
      [{ type: "text_delta", text_delta: "one" }, { type: "finish", reason: "stop", usage: zeroUsage() }],
    ];
    const provider = () => createMockProvider("mock", steps);
    const first = await createSaberServer({ provider: provider(), model: "mock", cwd: workspace, dataDir });
    const address = await first.listen();
    const socket = await openSocket(`${address.replace("http", "ws")}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ type: "prompt", commandId: "r-1", sessionId: "restart-test", text: "first" }));
    await once(messages, (m) => m.type === "turn_complete");
    await first.close();

    const second = await createSaberServer({ provider: provider(), model: "mock", cwd: workspace, dataDir });
    cleanup.push(() => second.close());
    const address2 = await second.listen();
    const socket2 = await openSocket(`${address2.replace("http", "ws")}/ws`);
    const messages2: Array<Record<string, unknown>> = [];
    socket2.on("message", (raw) => messages2.push(JSON.parse(raw.toString())));
    socket2.send(JSON.stringify({ type: "prompt", commandId: "r-2", sessionId: "restart-test", text: "second" }));
    await once(messages2, (m) => m.type === "turn_complete");

    // history survived the restart: both user turns present, seq continued
    const projection = await second.app.inject({ method: "GET", url: "/api/sessions/restart-test" });
    const body = projection.json() as { messages: Array<{ role: string; content: string }> };
    const userTexts = body.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toContain("first");
    expect(userTexts).toContain("second");
    const meta = await second.app.inject({ method: "GET", url: "/api/sessions" });
    expect((meta.json() as Array<{ id: string }>).some((s) => s.id === "restart-test")).toBe(true);
  });

  it("rejects browser sockets from foreign origins and malformed messages", async () => {
    const server = await createSaberServer({
      provider: createMockProvider("mock", [[{ type: "finish", reason: "stop", usage: zeroUsage() }]]),
      model: "mock", cwd: workspace, dataDir,
    });
    cleanup.push(() => server.close());
    const address = await server.listen();
    const wsUrl = `${address.replace("http", "ws")}/ws`;

    // foreign origin → the handshake completes but the handler immediately
    // closes with policy code 1008 before any message is processed
    await new Promise<void>((resolve, reject) => {
      const evil = new WebSocket(wsUrl, { headers: { Origin: "http://evil.example" } });
      const timer = setTimeout(() => reject(new Error("socket was not closed")), 5000);
      evil.once("close", (code) => {
        clearTimeout(timer);
        code === 1008 ? resolve() : reject(new Error(`unexpected close code ${code}`));
      });
    });

    // malformed / schema-invalid messages → error reply, socket stays open
    const socket = await openSocket(wsUrl);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    socket.send("this is not json");
    await once(messages, (m) => m.type === "error" && String(m.message).includes("malformed"));
    socket.send(JSON.stringify({ type: "prompt" }));
    await once(messages, (m) => m.type === "error" && String(m.message).includes("invalid message"));
  });

  it("a session is not poisoned by an earlier abort", async () => {
    const steps: ProviderEvent[][] = [
      toolCallStep("c1", "bash", { command: "sleep 30", timeout_ms: 60_000 }),
      [{ type: "text_delta", text_delta: "still alive" }, { type: "finish", reason: "stop", usage: zeroUsage() }],
    ];
    const server = await createSaberServer({
      provider: createMockProvider("mock", steps),
      model: "mock", cwd: workspace, dataDir,
    });
    cleanup.push(() => server.close());
    const address = await server.listen();
    const socket = await openSocket(`${address.replace("http", "ws")}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    socket.send(JSON.stringify({ type: "prompt", commandId: "p-1", sessionId: "poison-test", text: "sleep" }));
    await once(messages, (m) => m.type === "tool_started");
    socket.send(JSON.stringify({ type: "abort", commandId: "a-1", sessionId: "poison-test" }));
    const first = await once(messages, (m) => m.type === "turn_complete", 10_000) as { reason?: string };
    expect(first.reason).toBe("aborted");

    // a fresh turn on the same session must run to completion
    socket.send(JSON.stringify({ type: "prompt", commandId: "p-2", sessionId: "poison-test", text: "continue" }));
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const done = messages.filter((m) => m.type === "turn_complete");
        if (done.length >= 2) return resolve();
        if (Date.now() - started > 5000) return reject(new Error("second turn never completed"));
        setTimeout(tick, 25);
      };
      tick();
    });
    const second = messages.filter((m) => m.type === "turn_complete")[1];
    expect(second.reason).toBe("done");
  });

  it("SaberClient adopts the sessionId from a prompt ack and sees the full turn", async () => {
    const { SaberClient } = await import("@saber/core");
    const steps: ProviderEvent[][] = [
      [{ type: "text_delta", text_delta: "hi from core client" }, { type: "finish", reason: "stop", usage: zeroUsage() }],
    ];
    const server = await createSaberServer({
      provider: createMockProvider("mock", steps),
      model: "mock", cwd: workspace, dataDir,
    });
    cleanup.push(() => server.close());
    const address = await server.listen();

    const acks: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    let signalConnect: () => void = () => {};
    const connected = new Promise<void>((resolve) => { signalConnect = resolve; });
    const client = new SaberClient({
      url: `${address.replace("http", "ws")}/ws`,
      sessionId: "",
      onConnect: () => signalConnect(),
      onAck: (ack) => acks.push(ack as Record<string, unknown>),
      onEvent: (event) => events.push(event as Record<string, unknown>),
    });
    client.connect();
    await connected;

    client.send({ type: "prompt", commandId: "sc-1", text: "say hi" });
    await once(acks, (a) => a.kind === "prompt" && a.commandId === "sc-1");
    await once(events, (e) => e.type === "turn_complete");
    expect(client.sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    expect(events.find((e) => e.type === "assistant_message")).toBeDefined();
    client.disconnect();
  });
});

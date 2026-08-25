import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SaberClient, type SaberSocketLike } from "../client.js";

class FakeSocket implements SaberSocketLike {
  static created: FakeSocket[] = [];
  static reset(): void { FakeSocket.created = []; }
  static get last(): FakeSocket { return FakeSocket.created[FakeSocket.created.length - 1]; }

  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() { FakeSocket.created.push(this); }

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  serverAccept(): void { this.readyState = 1; this.onopen?.(); }
  serverMessage(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  serverDrop(): void { this.readyState = 3; this.onclose?.(); }
}

type ClientOptions = ConstructorParameters<typeof SaberClient>[0];

function makeClient(overrides: Partial<ClientOptions> = {}) {
  const onEvent = vi.fn();
  const onAck = vi.fn();
  const onConnect = vi.fn();
  const onDisconnect = vi.fn();
  const client = new SaberClient({
    url: "ws://test/ws",
    sessionId: "",
    onEvent,
    onAck,
    onConnect,
    onDisconnect,
    socketFactory: () => new FakeSocket(),
    ...overrides,
  } as ClientOptions);
  return { client, onEvent, onAck, onConnect, onDisconnect };
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SaberClient lifecycle", () => {
  it("disconnect is final: no reconnect is ever scheduled", () => {
    const { client, onDisconnect } = makeClient();
    client.connect();
    FakeSocket.last.serverAccept();
    client.disconnect();
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.created).toHaveLength(1); // nothing reconnected
    expect(client.send({ type: "abort", commandId: "x", sessionId: "s" })).toBe(false);
  });

  it("ignores callbacks from a replaced socket", () => {
    const { client, onConnect } = makeClient();
    client.connect();
    const stale = FakeSocket.created[0];
    client.disconnect();
    client.connect();
    const fresh = FakeSocket.created[1];

    stale.serverAccept(); // late open of the dead socket
    expect(onConnect).not.toHaveBeenCalled();
    expect(stale.sent).toHaveLength(0);

    fresh.serverAccept();
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("resets the reconnect backoff after a successful connection", () => {
    const { client } = makeClient();
    client.connect();
    FakeSocket.last.serverAccept();
    FakeSocket.last.serverDrop(); // schedules at 1000ms

    vi.advanceTimersByTime(1000);
    expect(FakeSocket.created).toHaveLength(2);
    FakeSocket.last.serverAccept();
    FakeSocket.last.serverDrop(); // success reset: next delay is 1000ms again

    vi.advanceTimersByTime(999);
    expect(FakeSocket.created).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.created).toHaveLength(3);
  });

  it("grows the backoff across consecutive failures, capped", () => {
    const { client } = makeClient();
    client.connect();
    FakeSocket.last.serverDrop(); // 1000
    vi.advanceTimersByTime(1000);
    FakeSocket.last.serverDrop(); // 2000
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.created).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.created).toHaveLength(3);
  });
});

describe("SaberClient session handling", () => {
  it("adopts the sessionId from a prompt ack and never subscribes with an empty id", () => {
    const { client, onAck } = makeClient();
    client.connect();
    const socket = FakeSocket.last;
    socket.serverAccept();
    expect(socket.sent).toHaveLength(0); // empty sessionId → no subscribe

    socket.serverMessage({ type: "ack", kind: "prompt", commandId: "c1", sessionId: "sess-1" });
    expect(client.sessionId).toBe("sess-1");
    expect(onAck).toHaveBeenCalledTimes(1);

    // reconnect resumes the adopted session; watermark may include ephemeral seqs
    socket.serverMessage({ type: "assistant_delta", seq: 5, sessionId: "sess-1", turnId: "t", stepId: "s", text: "x" });
    socket.serverMessage({ type: "user_message", seq: 6, sessionId: "sess-1", message: { role: "user", blocks: [] } });
    socket.serverDrop();
    vi.advanceTimersByTime(1000);
    FakeSocket.last.serverAccept();
    const subscribe = JSON.parse(FakeSocket.last.sent[0]);
    expect(subscribe).toEqual({ type: "subscribe", sessionId: "sess-1", since: 6 });
  });

  it("setSession unsubscribes the old session and resets the watermark", () => {
    const { client } = makeClient({ sessionId: "alpha" });
    client.connect();
    const socket = FakeSocket.last;
    socket.serverAccept();
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "subscribe", sessionId: "alpha", since: 0 });

    socket.serverMessage({ type: "tool_result", seq: 3, sessionId: "alpha", callId: "c", name: "bash", content: "x", isError: false });
    client.setSession("beta");
    const sent = socket.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: "unsubscribe", sessionId: "alpha" });
    expect(sent).toContainEqual({ type: "subscribe", sessionId: "beta", since: 0 });

    // reconnect subscribes to the new session from zero
    socket.serverDrop();
    vi.advanceTimersByTime(1000);
    FakeSocket.last.serverAccept();
    expect(JSON.parse(FakeSocket.last.sent[0])).toEqual({ type: "subscribe", sessionId: "beta", since: 0 });
  });
});

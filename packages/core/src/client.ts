import type { SaberCommand, WireEvent } from "./model.js";

export interface SaberAck {
  type: "ack";
  kind: string;
  commandId?: string;
  sessionId?: string;
  queued?: boolean;
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

/** Minimal socket surface SaberClient needs (satisfied by WebSocket). */
export interface SaberSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((msg: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export interface SaberClientOptions {
  url: string;
  sessionId: string;
  onEvent: (event: WireEvent) => void;
  /** Acks (prompt/steer/abort results); a prompt ack carries the sessionId. */
  onAck?: (ack: SaberAck) => void;
  onDisconnect?: () => void;
  onConnect?: () => void;
  /** Test seam; defaults to the platform WebSocket. */
  socketFactory?: (url: string) => SaberSocketLike;
}

/**
 * WebSocket client shared by the web UI and the TUI.
 *
 * Invariants:
 * - `disconnect()` is final: no reconnect is scheduled, pending timers die.
 * - Backoff resets to the base delay after a successful (re)connection.
 * - Stale-socket guards: callbacks from a replaced/closed socket are ignored.
 * - The `since` watermark may advance on ephemeral events too — ephemeral and
 *   durable events share one monotonic seq counter, so an ephemeral watermark
 *   can never skip an older durable event.
 */
export class SaberClient {
  private ws: SaberSocketLike | null = null;
  private lastSeq = 0;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  /** Updated from prompt acks so a client that started a new session
   *  reconnects (and resubscribes) to the right id after a drop. */
  sessionId: string;

  constructor(private opts: SaberClientOptions) {
    this.sessionId = opts.sessionId;
  }

  connect(): void {
    if (!this.stopped) return; // idempotent
    this.stopped = false;
    this.open();
  }

  /** Final stop: closes the socket and cancels any pending reconnect. */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Switches the subscription to another session; resets the watermark.
   *  An empty id only unsubscribes (new-chat state before the first prompt). */
  setSession(sessionId: string): void {
    const previous = this.sessionId;
    if (sessionId === previous) return;
    this.sessionId = sessionId;
    this.lastSeq = 0;
    const socket = this.ws;
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (previous) socket.send(JSON.stringify({ type: "unsubscribe", sessionId: previous }));
      if (sessionId) socket.send(JSON.stringify({ type: "subscribe", sessionId, since: 0 }));
    }
  }

  /** Returns false (and drops nothing silently) when the socket is not open. */
  send(command: SaberCommand): boolean {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(command));
    return true;
  }

  private open(): void {
    // WebSocket satisfies SaberSocketLike structurally; the cast only papers
    // over lib.dom's handler typings (we assign our own handlers below).
    const factory = this.opts.socketFactory
      ?? ((url: string) => new WebSocket(url) as unknown as SaberSocketLike);
    const socket = factory(this.opts.url);
    this.ws = socket;
    socket.onopen = () => {
      if (this.ws !== socket || this.stopped) return;
      this.reconnectDelay = 1000;
      this.opts.onConnect?.();
      if (this.sessionId) {
        socket.send(JSON.stringify({ type: "subscribe", sessionId: this.sessionId, since: this.lastSeq }));
      }
    };
    socket.onmessage = (msg) => {
      if (this.ws !== socket || this.stopped) return;
      try {
        const parsed = JSON.parse(String(msg.data)) as Record<string, unknown>;
        if (parsed.type === "ack") {
          if (parsed.kind === "prompt" && typeof parsed.sessionId === "string" && parsed.sessionId) {
            this.sessionId = parsed.sessionId;
          }
          this.opts.onAck?.(parsed as SaberAck);
          return;
        }
        const event = parsed as unknown as WireEvent;
        if (typeof event.seq === "number" && event.seq > this.lastSeq) this.lastSeq = event.seq;
        this.opts.onEvent(event);
      } catch { /* ignore malformed */ }
    };
    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.opts.onDisconnect?.();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }
}

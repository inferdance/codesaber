/**
 * Shared data model for Web UI and TUI.
 * Both frontends import from this package — they see the same events,
 * send the same commands, and project the same state.
 */

// ─── Events (server → client, append-only) ──────────────────────────

export interface SaberEvent {
  seq: number;
  sessionId: string;
  type: string;
  [key: string]: unknown;
}

// ─── Commands (client → server, with commandId for idempotency) ────

export type SaberCommand =
  | { type: "prompt"; commandId: string; text: string; sessionId?: string }
  | { type: "steer"; commandId: string; text: string; sessionId: string }
  | { type: "abort"; commandId: string; turnId: string; sessionId: string }
  | { type: "approve"; commandId: string; granted: boolean; requestId: string; sessionId: string };

// ─── Projection (fold events → current state) ──────────────────────

export interface MessageView {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  isError?: boolean;
  timestamp: number;
}

export interface SessionProjection {
  sessionId: string;
  messages: MessageView[];
  isRunning: boolean;
  currentTurn?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

export function projectSession(sessionId: string, events: SaberEvent[]): SessionProjection {
  const projection: SessionProjection = {
    sessionId,
    messages: [],
    isRunning: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };

  for (const event of events) {
    switch (event.type) {
      case "user_message": {
        const msg = (event as any).payload?.message;
        if (msg?.blocks) {
          const text = msg.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
          if (text) projection.messages.push({ role: "user", content: text, timestamp: event.seq });
        }
        break;
      }
      case "assistant_message": {
        const msg = (event as any).payload?.message;
        if (msg?.blocks) {
          const text = msg.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
          if (text) projection.messages.push({ role: "assistant", content: text, timestamp: event.seq });
        }
        break;
      }
      case "tool_result": {
        const payload = (event as any).payload;
        projection.messages.push({
          role: "tool",
          content: payload?.content ?? "",
          toolName: payload?.name,
          isError: payload?.is_error ?? false,
          timestamp: event.seq,
        });
        break;
      }
      case "turn_started":
        projection.isRunning = true;
        projection.currentTurn = (event as any).turnId;
        break;
      case "turn_complete":
        projection.isRunning = false;
        projection.currentTurn = undefined;
        break;
      case "step_finished": {
        const usage = (event as any).usage;
        if (usage) {
          projection.usage.inputTokens += usage.input_tokens ?? 0;
          projection.usage.outputTokens += usage.output_tokens ?? 0;
          projection.usage.costUsd += usage.cost_usd ?? 0;
        }
        break;
      }
    }
  }
  return projection;
}

// ─── WebSocket Client (shared by Web and TUI) ──────────────────────

export interface SaberClientOptions {
  url: string;
  sessionId: string;
  onEvent: (event: SaberEvent) => void;
  onDisconnect?: () => void;
  onConnect?: () => void;
}

export class SaberClient {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private reconnectDelay = 1000;

  constructor(private opts: SaberClientOptions) {}

  connect(): void {
    this.ws = new WebSocket(this.opts.url);
    this.ws.onopen = () => {
      this.opts.onConnect?.();
      this.ws?.send(JSON.stringify({
        type: "subscribe",
        sessionId: this.opts.sessionId,
        since: this.lastSeq,
      }));
    };
    this.ws.onmessage = (msg) => {
      try {
        const event: SaberEvent = JSON.parse(msg.data);
        if (event.seq > this.lastSeq) this.lastSeq = event.seq;
        this.opts.onEvent(event);
      } catch { /* ignore malformed */ }
    };
    this.ws.onclose = () => {
      this.opts.onDisconnect?.();
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    };
  }

  send(command: SaberCommand): void {
    this.ws?.send(JSON.stringify(command));
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}

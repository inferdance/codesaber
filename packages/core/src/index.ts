export { createPathPolicy, checkRead, checkWrite, isInside, SECRET_HOME_DIRS, SECRET_SUFFIXES, type PathPolicy } from "./policy.js";
export { SessionLog, recoverSession, type Recovered } from "./session.js";
export { Engine, type TurnOutcome, type TurnInput, type EngineOptions } from "./engine.js";
export type { ToolResult, ToolContext, ToolDefinition } from "./types.js";
export { EPHEMERAL_EVENT_TYPES, type SaberPayload, type SaberEvent, type SessionEventEnvelope } from "./events.js";
export { createTools, truncateMiddle } from "./tools/index.js";
export { applyEdit, type EditOutcome } from "./tools/edit.js";
export { globToRegExp } from "./tools/search.js";
export { zodToParameters, defineTool } from "./tools/schema.js";

import type { SaberPayload } from "./events.js";

/**
 * Shared data model for the web UI and TUI. Both frontends import from this
 * package — they see the same events (the SaberPayload vocabulary in
 * events.ts), send the same commands, and project the same state.
 */

// ─── Wire event: SaberPayload + transport envelope ──────────────────

export type WireEvent = { seq: number; sessionId: string } & SaberPayload;

// ─── Commands (client → server, with commandId for idempotency) ────
// (approve arrives in M2 together with the approval workflow — no phantom
// commands in the vocabulary until the server actually supports them)

export type SaberCommand =
  | { type: "prompt"; commandId: string; text: string; sessionId?: string }
  | { type: "steer"; commandId: string; text: string; sessionId: string }
  | { type: "abort"; commandId: string; turnId?: string; sessionId: string };

// ─── Projection (fold events → current state) ──────────────────────

export interface MessageView {
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  toolName?: string;
  isError?: boolean;
  /** True while the message is a live preview built from assistant_delta. */
  streaming?: boolean;
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

export function projectSession(sessionId: string, events: Array<{ seq: number } & SaberPayload>): SessionProjection {
  const projection: SessionProjection = {
    sessionId,
    messages: [],
    isRunning: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };

  for (const event of events) {
    switch (event.type) {
      case "user_message": {
        const text = event.message.blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) projection.messages.push({ role: "user", content: text, timestamp: event.seq });
        break;
      }
      case "assistant_message": {
        const text = event.message.blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) {
          // a durable assistant message replaces the streaming preview
          // built from assistant_delta events of the same step
          const last = projection.messages[projection.messages.length - 1];
          if (last && last.role === "assistant" && last.streaming) {
            projection.messages.pop();
          }
          projection.messages.push({ role: "assistant", content: text, timestamp: event.seq });
        }
        break;
      }
      case "assistant_delta": {
        const last = projection.messages[projection.messages.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          last.content += event.text;
        } else {
          projection.messages.push({ role: "assistant", content: event.text, timestamp: event.seq, streaming: true });
        }
        break;
      }
      case "tool_result": {
        projection.messages.push({
          role: "tool",
          content: event.content,
          toolName: event.name,
          isError: event.isError,
          timestamp: event.seq,
        });
        break;
      }
      case "error":
        projection.messages.push({ role: "error", content: event.message, timestamp: event.seq });
        break;
      case "turn_started":
        projection.isRunning = true;
        projection.currentTurn = event.turnId;
        break;
      case "turn_complete":
        projection.isRunning = false;
        projection.currentTurn = undefined;
        break;
      case "step_finished":
        projection.usage.inputTokens += event.usage.input_tokens ?? 0;
        projection.usage.outputTokens += event.usage.output_tokens ?? 0;
        projection.usage.costUsd += event.usage.cost_usd ?? 0;
        break;
    }
  }
  return projection;
}


// ─── WebSocket Client (shared by Web and TUI) ──────────────────────

export { SaberClient, type SaberClientOptions, type SaberAck } from "./client.js";

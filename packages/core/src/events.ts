import type { Message, Usage } from "@saber/ai";

/**
 * The single event vocabulary. Engine callbacks, session-log payloads, and
 * the M1 wire all speak SaberPayload — one discriminated union, no parallel
 * field-name dialects. Fields are camelCase on the wire and in the JSONL.
 *
 * Durable events rebuild any projection on recovery; ephemeral events are
 * streaming-only (derivable from their durable neighbours) and never written.
 */
export type SaberPayload =
  // session lifecycle (durable)
  | { type: "session_meta"; meta: Record<string, unknown> }
  // conversation — model-visible (durable)
  | { type: "user_message"; message: Message }
  | { type: "assistant_message"; message: Message; usage: Usage }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  // turn lifecycle (durable)
  | { type: "turn_started"; turnId: string }
  | { type: "turn_complete"; turnId: string; reason: string }
  | { type: "step_started"; turnId: string; stepId: string }
  | { type: "step_finished"; turnId: string; stepId: string; usage: Usage }
  // context management (durable)
  | { type: "context_compacted"; summary: string; droppedEvents: number }
  // audit (durable)
  | { type: "error"; message: string }
  // streaming-only (ephemeral)
  | { type: "assistant_delta"; turnId: string; stepId: string; text: string }
  | { type: "tool_started"; turnId: string; stepId: string; callId: string; name: string }
  | { type: "tool_completed"; callId: string; isError: boolean };

export const EPHEMERAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant_delta",
  "tool_started",
  "tool_completed",
]);

/** Event as handed to engine observers: payload + assigned sequence number. */
export type SaberEvent = { seq: number } & SaberPayload;

/** What goes on disk (and on the M1 wire, plus sessionId). */
export interface SessionEventEnvelope {
  ts: number;
  seq: number;
  sessionId: string;
  payload: SaberPayload;
}

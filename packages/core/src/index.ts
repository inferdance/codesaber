export { createPathPolicy, checkRead, checkWrite, isInside, SECRET_HOME_DIRS, SECRET_SUFFIXES, type PathPolicy } from "./policy.js";
export { SessionLog, recoverSession, type Recovered } from "./session.js";
export { Engine, type TurnOutcome, type TurnInput, type EngineOptions } from "./engine.js";
export type { ToolResult, ToolContext, ToolDefinition } from "./types.js";
export { EPHEMERAL_EVENT_TYPES, type SaberPayload, type SaberEvent, type SessionEventEnvelope } from "./events.js";
export { createTools, truncateMiddle } from "./tools/index.js";
export { applyEdit, type EditOutcome } from "./tools/edit.js";
export { globToRegExp } from "./tools/search.js";
export { zodToParameters, defineTool } from "./tools/schema.js";

/**
 * Shared data model for the web UI and TUI (browser-safe slice lives in
 * model.ts so frontends can import it without pulling in Node-only code).
 */

export {
  type WireEvent, type SaberCommand,
  type MessageView, type SessionProjection, projectSession,
} from "./model.js";

// ─── WebSocket Client (shared by Web and TUI) ──────────────────────

export { SaberClient, type SaberClientOptions, type SaberAck, type SaberSocketLike } from "./client.js";

import * as fs from "node:fs";
import * as path from "node:path";
import { EPHEMERAL_EVENT_TYPES, type SaberPayload, type SaberEvent, type SessionEventEnvelope } from "./events.js";

/**
 * Append-only session log. One entry point — record() — assigns sequence
 * numbers, persists durable events, and passes ephemeral events through so
 * observers still see a single ordered stream. JSONL on disk stores
 * SessionEventEnvelope lines; the payload is the shared SaberPayload union.
 */
export class SessionLog {
  private seq = 0;
  readonly path: string;
  readonly id: string;

  private constructor(dir: string, sessionId: string, fd: number) {
    this.id = sessionId;
    this.path = path.join(dir, `${sessionId}.jsonl`);
    this.fd = fd;
  }

  private fd: number;

  /** Creates a fresh log (truncating any existing file with this id). */
  static create(dir: string, sessionId: string, meta: Record<string, unknown>): SessionLog {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    const fd = fs.openSync(file, "w");
    const log = new SessionLog(dir, sessionId, fd);
    log.record({ type: "session_meta", meta }, { sync: true });
    return log;
  }

  /** Reopens an existing log for appending; throws if it does not exist.
   *  Recovers first: refuses mid-file corruption, and truncates a torn tail
   *  fragment so appended records never glue onto an unparseable line. */
  static open(dir: string, sessionId: string): SessionLog {
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`session not found: ${file}`);
    const recovered = recoverSession(file);
    if (recovered.tornAt !== undefined) {
      throw new Error(`session ${sessionId} has corruption at record ${recovered.tornAt}; refusing to append — repair or archive the log first`);
    }
    const raw = fs.readFileSync(file);
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      fs.truncateSync(file, raw.lastIndexOf(0x0a) + 1);
    }
    const fd = fs.openSync(file, "a");
    const log = new SessionLog(dir, sessionId, fd);
    log.seq = recovered.events.reduce((max, e) => Math.max(max, e.seq + 1), 0);
    return log;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  /**
   * Assigns a seq and persists unless the event type is ephemeral.
   * `sync` fsyncs after write — required for tool_call intents (WAL).
   */
  record(payload: SaberPayload, opts?: { sync?: boolean }): SaberEvent {
    const event = { seq: this.seq++, ...payload };
    if (!EPHEMERAL_EVENT_TYPES.has(payload.type)) {
      const envelope: SessionEventEnvelope = {
        ts: Date.now(), seq: event.seq, sessionId: this.id, payload,
      };
      const line = JSON.stringify(envelope) + "\n";
      fs.writeSync(this.fd, line);
      if (opts?.sync) fs.fsyncSync(this.fd);
    }
    return event;
  }

  nextSeq(): number {
    return this.seq;
  }
}

export interface Recovered {
  events: SessionEventEnvelope[];
  /** Seqs of tool_call intents with no matching tool_result. */
  unfinishedToolCalls: number[];
  /** Line index (0-based) where a corrupt record stopped replay, if any. */
  tornAt?: number;
}

function isEnvelope(v: unknown): v is SessionEventEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.ts === "number"
    && typeof e.seq === "number"
    && typeof e.sessionId === "string"
    && typeof e.payload === "object" && e.payload !== null
    && typeof (e.payload as Record<string, unknown>).type === "string";
}

/**
 * Replays a log. Tolerates a torn tail (crash mid-write). A corrupt record
 * mid-file degrades: replay stops there and `tornAt` reports the position —
 * one bad line must not void the whole transcript. Structurally invalid
 * records (valid JSON, wrong shape) degrade the same way instead of throwing.
 */
export function recoverSession(filePath: string): Recovered {
  const content = fs.readFileSync(filePath, "utf-8");
  const events: SessionEventEnvelope[] = [];
  const lines = content.split("\n");
  let tornAt: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { parsed = undefined; }
    if (isEnvelope(parsed)) {
      events.push(parsed);
    } else if (i === lines.length - 1) {
      break; // torn tail: expected after a crash
    } else {
      tornAt = i; // mid-file corruption: keep what we have
      break;
    }
  }
  type ToolCallEnvelope = SessionEventEnvelope & { payload: Extract<SaberPayload, { type: "tool_call" }> };
  type ToolResultEnvelope = SessionEventEnvelope & { payload: Extract<SaberPayload, { type: "tool_result" }> };
  const finished = new Set(
    events
      .filter((e): e is ToolResultEnvelope => e.payload.type === "tool_result")
      .map((e) => e.payload.callId),
  );
  const unfinished = events
    .filter((e): e is ToolCallEnvelope => e.payload.type === "tool_call" && !finished.has(e.payload.callId))
    .map((e) => e.seq);
  return { events, unfinishedToolCalls: unfinished, tornAt };
}

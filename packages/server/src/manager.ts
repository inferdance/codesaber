import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Provider } from "@saber/ai";
import {
  Engine,
  SessionLog,
  createPathPolicy,
  createTools,
  projectSession,
  recoverSession,
  type SaberEvent,
  type SessionProjection,
  type ToolContext,
  type WireEvent,
} from "@saber/core";

export interface AgentServerOptions {
  provider: Provider;
  model: string;
  cwd: string;
  dataDir: string;
  system?: string;
}

interface SessionHandle {
  id: string;
  engine: Engine;
  session: SessionLog;
  /** Serialized mailbox: texts waiting for the current turn to finish. */
  queue: string[];
  draining: boolean;
  closed: boolean;
  /** Fresh controller PER TURN — a session is never poisoned by an old abort. */
  current: AbortController | null;
  state: { activeTurnId?: string };
  drainPromise: Promise<void> | null;
}

export interface PromptResult {
  sessionId: string;
  duplicate: boolean;
  started: boolean;
  /** True when the text was queued behind a running turn. */
  queued?: boolean;
  error?: string;
}

/** Client-facing session ids are opaque filename-safe tokens, nothing more. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * Hosts one Engine per session on top of the shared core model: every engine
 * event is persisted (SessionLog) and fanned out to subscribers as a
 * WireEvent; subscriptions replay from the log since a given seq, so
 * reconnecting clients converge without missing durable events.
 *
 * Prompts per session run through a serialized mailbox (one turn at a time,
 * later prompts queue) as the design spec requires.
 */
export class AgentServer {
  private handles = new Map<string, SessionHandle>();
  private subscribers = new Map<string, Set<(event: WireEvent) => void>>();
  private seenCommands = new Set<string>();
  private readonly sessionsDir: string;

  constructor(private opts: AgentServerOptions) {
    this.sessionsDir = path.join(opts.dataDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  listSessions(): Array<{ id: string; projection: SessionProjection }> {
    return fs.readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .filter(isValidSessionId)
      .sort()
      .reverse()
      .map((id) => {
        try {
          return { id, projection: this.projection(id) };
        } catch {
          return { id, projection: projectSession(id, []) };
        }
      });
  }

  projection(sessionId: string): SessionProjection {
    if (!isValidSessionId(sessionId)) throw new Error("invalid session id");
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`session not found: ${sessionId}`);
    const recovered = recoverSession(file);
    return projectSession(sessionId, recovered.events.map((e) => ({ seq: e.seq, ...e.payload })));
  }

  /**
   * Starts (or queues into) a turn. Command ids are idempotent: a replayed
   * command is acknowledged as duplicate and never starts a second turn.
   * A prompt for an on-disk session (after a server restart) reopens the log
   * for appending — history is never truncated.
   */
  prompt(input: { sessionId?: string; text: string; commandId: string }): PromptResult {
    const sessionId = input.sessionId ?? `s-${randomUUID().slice(0, 8)}`;
    if (!isValidSessionId(sessionId)) {
      return { sessionId: "", duplicate: false, started: false, error: "invalid session id" };
    }
    if (this.seenCommands.has(input.commandId)) {
      return { sessionId, duplicate: true, started: false };
    }
    this.markCommand(input.commandId);
    let handle = this.handles.get(sessionId);
    if (!handle) {
      try {
        handle = this.createHandle(sessionId);
      } catch (e) {
        return { sessionId, duplicate: false, started: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (handle.draining) {
      handle.queue.push(input.text);
      return { sessionId, duplicate: false, started: true, queued: true };
    }
    handle.drainPromise = this.drain(handle, input.text);
    return { sessionId, duplicate: false, started: true };
  }

  steer(input: { sessionId: string; text: string; commandId: string }): boolean {
    const handle = this.handles.get(input.sessionId);
    if (!handle) return false;
    if (this.seenCommands.has(input.commandId)) return false;
    this.markCommand(input.commandId);
    handle.engine.steer(input.text);
    return true;
  }

  /**
   * Aborts the active turn. A `turnId` (when provided) must match the active
   * turn — a stale abort from a finished turn must never kill the next one.
   */
  abort(sessionId: string, turnId?: string): boolean {
    const handle = this.handles.get(sessionId);
    if (!handle) return false;
    if (turnId !== undefined && handle.state.activeTurnId !== turnId) return false;
    handle.current?.abort();
    return true;
  }

  /**
   * Replays durable events with seq > `since` from the log, then attaches a
   * live listener. Live events at or below the replayed watermark are
   * dropped, so a record-then-broadcast race cannot duplicate an event.
   */
  subscribe(sessionId: string, since: number, listener: (event: WireEvent) => void): () => void {
    let watermark = since;
    if (isValidSessionId(sessionId)) {
      const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) {
        for (const envelope of recoverSession(file).events) {
          if (envelope.seq > watermark) {
            watermark = envelope.seq;
            listener({ seq: envelope.seq, sessionId, ...envelope.payload });
          }
        }
      }
    }
    const live = (event: WireEvent): void => {
      if (event.seq <= watermark) return;
      watermark = event.seq;
      listener(event);
    };
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    const liveSet = set;
    liveSet.add(live);
    const subscribers = this.subscribers;
    return () => {
      liveSet.delete(live);
      if (liveSet.size === 0) subscribers.delete(sessionId);
    };
  }

  /** Aborts running turns, waits for them to settle, then closes log fds. */
  async close(): Promise<void> {
    for (const handle of this.handles.values()) {
      handle.closed = true;
      handle.queue.length = 0;
      handle.current?.abort();
    }
    // let aborted turns finish writing their turn_complete before closing fds
    await Promise.allSettled([...this.handles.values()].map((h) => h.drainPromise ?? Promise.resolve()));
    for (const handle of this.handles.values()) handle.session.close();
    this.handles.clear();
  }

  private createHandle(sessionId: string): SessionHandle {
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    const session = fs.existsSync(file)
      ? SessionLog.open(this.sessionsDir, sessionId) // server restart: append, never truncate
      : SessionLog.create(this.sessionsDir, sessionId, {
          protocol_version: "0.2.0", engine_version: "0.1.0",
          cwd: this.opts.cwd, model: this.opts.model,
        });
    const ctx: ToolContext = {
      sessionId,
      cwd: this.opts.cwd,
      dataDir: this.opts.dataDir,
      policy: createPathPolicy(this.opts.cwd, this.opts.dataDir),
      readFiles: new Map(),
    };
    const controllerState: { activeTurnId?: string } = {};
    const engine = new Engine({
      provider: this.opts.provider,
      tools: createTools(ctx),
      session,
      toolContext: ctx,
      model: this.opts.model,
      onEvent: (event) => {
        if (event.type === "turn_started") controllerState.activeTurnId = event.turnId;
        this.broadcast(sessionId, event);
      },
    });
    const handle: SessionHandle = {
      id: sessionId, engine, session,
      queue: [], draining: false, closed: false,
      current: null, state: controllerState, drainPromise: null,
    };
    this.handles.set(sessionId, handle);
    return handle;
  }

  /** One turn at a time, each with its own abort controller. */
  private async drain(handle: SessionHandle, firstText: string): Promise<void> {
    handle.draining = true;
    let text: string | undefined = firstText;
    try {
      while (text !== undefined && !handle.closed) {
        const controller = new AbortController();
        handle.current = controller;
        try {
          await handle.engine.runTurn({ userMessage: text, system: this.opts.system, signal: controller.signal });
        } catch (e) {
          const event = handle.session.record({
            type: "error",
            message: `turn crashed: ${e instanceof Error ? e.message : String(e)}`,
          });
          this.broadcast(handle.id, event);
        }
        handle.current = null;
        text = handle.closed ? undefined : handle.queue.shift();
      }
    } finally {
      handle.draining = false;
    }
  }

  private broadcast(sessionId: string, event: SaberEvent): void {
    const wire: WireEvent = { sessionId, ...event };
    for (const listener of this.subscribers.get(sessionId) ?? []) {
      try { listener(wire); } catch { /* listener errors must not break fan-out */ }
    }
  }

  private markCommand(commandId: string): void {
    this.seenCommands.add(commandId);
    if (this.seenCommands.size > 10_000) {
      // crude cap: Set preserves insertion order; keep the newest half
      this.seenCommands = new Set([...this.seenCommands].slice(5_000));
    }
  }
}

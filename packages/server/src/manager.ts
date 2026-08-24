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
  controller: AbortController;
}

export interface PromptResult {
  sessionId: string;
  duplicate: boolean;
  started: boolean;
}

/**
 * Hosts one Engine per session on top of the shared core model: every engine
 * event is persisted (SessionLog) and fanned out to subscribers as a
 * WireEvent; subscriptions replay from the log since a given seq, so
 * reconnecting clients converge without missing durable events.
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
      .sort()
      .reverse()
      .map((id) => ({ id, projection: this.projection(id) }));
  }

  projection(sessionId: string): SessionProjection {
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`session not found: ${sessionId}`);
    const recovered = recoverSession(file);
    return projectSession(sessionId, recovered.events.map((e) => ({ seq: e.seq, ...e.payload })));
  }

  /**
   * Starts (or steers into) a turn. Command ids are idempotent: a replayed
   * command is acknowledged as duplicate and never starts a second turn.
   * Prompting a session whose engine is mid-turn defers to the engine's
   * single-flight guard (busy outcome) rather than queueing.
   */
  prompt(input: { sessionId?: string; text: string; commandId: string }): PromptResult {
    if (this.seenCommands.has(input.commandId)) {
      return { sessionId: input.sessionId ?? "", duplicate: true, started: false };
    }
    this.markCommand(input.commandId);
    const sessionId = input.sessionId ?? `s-${Date.now()}`;
    let handle = this.handles.get(sessionId);
    if (!handle) handle = this.createHandle(sessionId);
    void this.runTurn(handle, input.text);
    return { sessionId, duplicate: false, started: true };
  }

  steer(input: { sessionId: string; text: string; commandId: string }): boolean {
    if (this.seenCommands.has(input.commandId)) return false;
    this.markCommand(input.commandId);
    const handle = this.handles.get(input.sessionId);
    if (!handle) return false;
    handle.engine.steer(input.text);
    return true;
  }

  abort(sessionId: string): boolean {
    const handle = this.handles.get(sessionId);
    if (!handle) return false;
    handle.controller.abort();
    return true;
  }

  /**
   * Replays durable events with seq > `since` from the log, then attaches a
   * live listener. Live events at or below the replayed watermark are
   * dropped, so the record-then-broadcast race cannot duplicate an event.
   */
  subscribe(sessionId: string, since: number, listener: (event: WireEvent) => void): () => void {
    let watermark = since;
    const file = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) {
      for (const envelope of recoverSession(file).events) {
        if (envelope.seq > watermark) {
          watermark = envelope.seq;
          listener({ seq: envelope.seq, sessionId, ...envelope.payload });
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
    set.add(live);
    return () => {
      set!.delete(live);
      if (set!.size === 0) this.subscribers.delete(sessionId);
    };
  }

  private createHandle(sessionId: string): SessionHandle {
    const session = SessionLog.create(this.sessionsDir, sessionId, {
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
    const controller = new AbortController();
    const engine = new Engine({
      provider: this.opts.provider,
      tools: createTools(ctx),
      session,
      toolContext: ctx,
      model: this.opts.model,
      onEvent: (event) => this.broadcast(sessionId, event),
    });
    const handle: SessionHandle = { id: sessionId, engine, session, controller };
    this.handles.set(sessionId, handle);
    return handle;
  }

  private async runTurn(handle: SessionHandle, text: string): Promise<void> {
    try {
      await handle.engine.runTurn({ userMessage: text, system: this.opts.system, signal: handle.controller.signal });
    } catch (e) {
      const event = handle.session.record({
        type: "error",
        message: `turn crashed: ${e instanceof Error ? e.message : String(e)}`,
      });
      this.broadcast(handle.id, event);
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

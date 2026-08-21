import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionEventEnvelope {
  ts: number;
  seq: number;
  session_id: string;
  type: string;
  payload: any;
}

export class SessionLog {
  private seq = 0;
  readonly path: string;
  readonly id: string;

  constructor(dir: string, sessionId: string, meta: Record<string, unknown>) {
    fs.mkdirSync(dir, { recursive: true });
    this.id = sessionId;
    this.path = path.join(dir, `${sessionId}.jsonl`);
    const fd = fs.openSync(this.path, "w");
    fs.closeSync(fd);
    this.append("session_meta", meta, true);
  }

  append(type: string, payload: unknown, sync = false): number {
    const envelope: SessionEventEnvelope = {
      ts: Date.now(), seq: this.seq++, session_id: this.id, type, payload,
    };
    const line = JSON.stringify(envelope) + "\n";
    if (sync) {
      const fd = fs.openSync(this.path, "a");
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } else {
      fs.appendFileSync(this.path, line);
    }
    return envelope.seq;
  }

  nextSeq(): number { return this.seq; }
}

export interface Recovered {
  events: SessionEventEnvelope[];
  unfinishedToolCalls: number[];
}

export function recoverSession(filePath: string): Recovered {
  const content = fs.readFileSync(filePath, "utf-8");
  const events: SessionEventEnvelope[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (e) {
      if (i === lines.length - 1) break; // torn tail
      throw new Error(`corrupt at line ${i + 1}: ${e}`);
    }
  }
  const finished = new Set(
    events.filter((e) => e.type === "tool_result").map((e) => e.payload.call_id),
  );
  const unfinished = events
    .filter((e) => e.type === "tool_call" && !finished.has(e.payload.call_id))
    .map((e) => e.seq);
  return { events, unfinishedToolCalls: unfinished };
}

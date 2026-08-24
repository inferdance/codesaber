import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionLog, recoverSession } from "../session.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "saber-s-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("session WAL", () => {
  it("intent without result flagged as unfinished", () => {
    const log = SessionLog.create(tmp, "s1", {});
    log.record({ type: "tool_call", callId: "c1", name: "bash", args: {} }, { sync: true });
    const r = recoverSession(log.path);
    expect(r.unfinishedToolCalls).toHaveLength(1);
  });

  it("completed tool not flagged", () => {
    const log = SessionLog.create(tmp, "s2", {});
    log.record({ type: "tool_call", callId: "c1", name: "bash", args: {} }, { sync: true });
    log.record({ type: "tool_result", callId: "c1", name: "bash", content: "ok", isError: false });
    const r = recoverSession(log.path);
    expect(r.unfinishedToolCalls).toHaveLength(0);
  });

  it("torn tail dropped, mid-file corruption degrades with tornAt", () => {
    const log = SessionLog.create(tmp, "s3", {});
    log.record({ type: "user_message", message: { role: "user", blocks: [{ type: "text", text: "hi" }] } });
    fs.appendFileSync(log.path, '{"torn'); // torn tail: expected after a crash
    let r = recoverSession(log.path);
    expect(r.events).toHaveLength(2); // meta + user_message
    expect(r.tornAt).toBeUndefined();

    const log2 = SessionLog.create(tmp, "s4", {});
    log2.record({ type: "user_message", message: { role: "user", blocks: [{ type: "text", text: "a" }] } });
    log2.record({ type: "user_message", message: { role: "user", blocks: [{ type: "text", text: "b" }] } });
    const lines = fs.readFileSync(log2.path, "utf-8").split("\n");
    lines[1] = "{corrupt middle line";
    fs.writeFileSync(log2.path, lines.join("\n"));
    r = recoverSession(log2.path);
    expect(r.events).toHaveLength(1); // only session_meta survived
    expect(r.tornAt).toBe(1);
  });

  it("reopen appends without truncating and continues the seq", () => {
    const log = SessionLog.create(tmp, "s5", {});
    log.record({ type: "user_message", message: { role: "user", blocks: [{ type: "text", text: "one" }] } });
    log.close();
    const reopened = SessionLog.open(tmp, "s5");
    reopened.record({ type: "user_message", message: { role: "user", blocks: [{ type: "text", text: "two" }] } });
    const r = recoverSession(reopened.path);
    expect(r.events.map((e) => e.payload.type)).toEqual(["session_meta", "user_message", "user_message"]);
    expect(r.events[2].seq).toBe(2);
    expect(r.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    reopened.close();
  });

  it("open throws for a missing session", () => {
    expect(() => SessionLog.open(tmp, "nope")).toThrow(/session not found/);
  });

  it("ephemeral events pass through with seq but are not persisted", () => {
    const log = SessionLog.create(tmp, "s6", {});
    const event = log.record({ type: "assistant_delta", turnId: "t1", stepId: "t1-s0", text: "hi" });
    expect(event.seq).toBe(1);
    const r = recoverSession(log.path);
    expect(r.events).toHaveLength(1); // only session_meta
    log.close();
  });
});

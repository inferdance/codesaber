import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionLog, recoverSession } from "../session.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "saber-s-")); });

describe("session WAL", () => {
  it("intent without result flagged as unfinished", () => {
    const log = new SessionLog(tmp, "s1", {});
    log.append("tool_call", { call_id: "c1", name: "bash", arguments: {} }, true);
    const r = recoverSession(log.path);
    expect(r.unfinishedToolCalls).toHaveLength(1);
  });

  it("completed tool not flagged", () => {
    const log = new SessionLog(tmp, "s2", {});
    log.append("tool_call", { call_id: "c1", name: "bash", arguments: {} }, true);
    log.append("tool_result", { call_id: "c1", content: "ok", is_error: false });
    const r = recoverSession(log.path);
    expect(r.unfinishedToolCalls).toHaveLength(0);
  });

  it("torn tail dropped, mid-file errors", () => {
    const log = new SessionLog(tmp, "s3", {});
    log.append("user_message", { text: "hi" });
    fs.appendFileSync(log.path, '{"torn');
    const r = recoverSession(log.path);
    expect(r.events).toHaveLength(2); // meta + user_message
  });
});

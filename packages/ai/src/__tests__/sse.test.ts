import { describe, it, expect } from "vitest";
import { SseParser } from "../sse.js";

describe("SseParser", () => {
  it("parses events split across chunks", () => {
    const p = new SseParser();
    const out = [...p.feed(`data: {"a":`), ...p.feed(`1}\n\n`), ...p.feed(`data: [DONE]\n`), ...p.feed(`\n`)];
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("handles CRLF and comments", () => {
    const p = new SseParser();
    const out = [...p.feed(`: ping\r\ndata: hello\r\ndata: world\r\n\r\n`)];
    expect(out).toEqual(["hello\nworld"]);
  });

  it("drops incomplete trailing on finish", () => {
    const p = new SseParser();
    const out = [...p.feed(`data: {"trunc`), ...p.finish()];
    expect(out).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { SseParser } from "../sse.ts";

describe("SseParser", () => {
  it("parses events split across chunks", () => {
    const p = new SseParser();
    const out = [
      ...p.feed(`data: {"a":`),
      ...p.feed(`1}\n\n`),
      ...p.feed(`data: [DONE]\n`),
      ...p.feed(`\n`),
    ];
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("handles CRLF, comments, and multi-line data", () => {
    const p = new SseParser();
    const out = [
      ...p.feed(`: keep-alive\r\nevent: msg\r\ndata: hello\r\ndata: world\r\n\r\n`),
    ];
    expect(out).toEqual(["hello\nworld"]);
  });

  it("drops incomplete trailing line on finish", () => {
    const p = new SseParser();
    const out = [...p.feed(`data: {"trunc`), ...p.finish()];
    expect(out).toEqual([]);
  });
});

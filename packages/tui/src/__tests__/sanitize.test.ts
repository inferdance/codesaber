import { describe, it, expect } from "vitest";
import { sanitizeTerminalText } from "../sanitize.js";

describe("sanitizeTerminalText", () => {
  it("strips OSC 52 clipboard-injection sequences", () => {
    expect(sanitizeTerminalText("before\x1b]52;c;QUJD\x07after")).toBe("beforeafter");
  });

  it("strips CSI sequences and C0 controls but keeps newline and tab", () => {
    expect(sanitizeTerminalText("a\x1b[2Jb\x00c\x07d\ne\tf")).toBe("abcd\ne\tf");
  });

  it("keeps CJK and normal text intact", () => {
    expect(sanitizeTerminalText("你好 saber ⚔️\nline2")).toBe("你好 saber ⚔️\nline2");
  });
});

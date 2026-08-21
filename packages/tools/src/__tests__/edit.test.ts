import { describe, it, expect } from "vitest";
import { applyEdit } from "../edit.ts";

describe("edit fallback chain", () => {
  it("simple exact match", () => {
    const { content, summary } = applyEdit("fn main() {}\n", {
      path: "x", old_string: "fn main() {}", new_string: "fn main() { todo!() }",
    });
    expect(content).toBe("fn main() { todo!() }\n");
    expect(summary).toContain("simple");
  });

  it("trailing context is never swallowed", () => {
    const { content } = applyEdit("a  b c", {
      path: "x", old_string: "a b", new_string: "X",
    });
    expect(content).toBe("X c");
  });

  it("whitespace-normalized fallback", () => {
    const { content, summary } = applyEdit("value = compute(x,\n y)\n", {
      path: "x", old_string: "value = compute(x, y)", new_string: "value = 0",
    });
    expect(content).toContain("value = 0");
    expect(summary).toContain("whitespace_normalized");
  });

  it("ambiguous match rejected", () => {
    expect(() => applyEdit("a\na\n", { path: "x", old_string: "a", new_string: "b" }))
      .toThrow("2 locations");
  });

  it("replace_all works", () => {
    const { content } = applyEdit("x\nx\nx\n", {
      path: "x", old_string: "x", new_string: "y", replace_all: true,
    });
    expect(content).toBe("y\ny\ny\n");
  });

  it("not found throws with all levels listed", () => {
    expect(() => applyEdit("abc", { path: "x", old_string: "ghost", new_string: "y" }))
      .toThrow("not found");
  });

  it("disproportionate match rejected", () => {
    const long = "start alpha beta gamma delta epsilon zeta end\n".repeat(6);
    expect(() => applyEdit(long, { path: "x", old_string: "start end", new_string: "X" }))
      .toThrow("not found");
  });

  it("CRLF preserved", () => {
    const { content } = applyEdit("line one\r\nline two\r\n", {
      path: "x", old_string: "line one", new_string: "LINE ONE",
    });
    expect(content).toBe("LINE ONE\r\nline two\r\n");
  });

  it("BOM preserved", () => {
    const { content } = applyEdit("\uFEFFhello\n", {
      path: "x", old_string: "hello", new_string: "world",
    });
    expect(content).toBe("\uFEFFworld\n");
  });
});

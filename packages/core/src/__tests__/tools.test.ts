import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createTools, applyEdit } from "../tools.js";
import { createPathPolicy } from "../policy.js";
import type { ToolContext } from "../types.js";

let workspace: string;
let ctx: ToolContext;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "saber-tools-"));
  ctx = {
    sessionId: "test",
    cwd: workspace,
    dataDir: path.join(workspace, ".data"),
    policy: createPathPolicy(workspace, path.join(workspace, ".data")),
    readFiles: new Set(),
  };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const tool = (name: string) => {
  const t = createTools(ctx).find((t) => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
};

describe("applyEdit levels", () => {
  it("replaces an exact unique match", () => {
    const out = applyEdit("const a = 1;\nconst b = 2;\n", "const a = 1;", "const a = 42;", false);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("const a = 42;\nconst b = 2;\n");
    expect(out.level).toBe("exact");
  });

  it("rejects an ambiguous match without replace_all", () => {
    const out = applyEdit("x = 1;\nx = 1;\n", "x = 1;", "x = 2;", false);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/matches 2 locations/);
  });

  it("replaces every match with replace_all", () => {
    const out = applyEdit("x = 1;\nx = 1;\n", "x = 1;", "x = 2;", true);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("x = 2;\nx = 2;\n");
    expect(out.replaced).toBe(2);
  });

  it("normalizes literal \\n escapes from the model", () => {
    const out = applyEdit("alpha\nbeta", "alpha\\nbeta", "gamma\\ndelta", false);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("gamma\ndelta");
    expect(out.level).toBe("escape-normalized");
  });

  it("ignores trailing whitespace differences per line", () => {
    const out = applyEdit("let x = 1;   \nlet y = 2;\t\n", "let x = 1;\nlet y = 2;", "let x = 9;\nlet y = 9;", false);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("let x = 9;\nlet y = 9;\n");
    expect(out.level).toBe("trailing-ws");
  });

  it("re-indents a dedented old_str to the file's indentation", () => {
    const file = "function f() {\n  if (x) {\n    return 1;\n  }\n}\n";
    const old = "if (x) {\nreturn 1;\n}";
    const neu = "if (x) {\nreturn 2;\n}";
    const out = applyEdit(file, old, neu, false);
    expect(out.ok).toBe(true);
    expect(out.level).toBe("indent-flexible");
    expect(out.content).toBe("function f() {\n  if (x) {\n    return 2;\n  }\n}\n");
  });

  it("rebases the whole block when the replacement changes line count", () => {
    const file = "function f() {\n  if (cond) {\n    return 1;\n  }\n}\n";
    // model dedented the block and added a line; positional transfer is void,
    // so the model's flat block is rebased onto the window's common indent
    const out = applyEdit(file, "if (cond) {\nreturn 1;\n}", "if (cond) {\nlog(x);\nreturn 1;\n}", false);
    expect(out.ok).toBe(true);
    expect(out.level).toBe("indent-flexible");
    expect(out.content).toBe("function f() {\n  if (cond) {\n  log(x);\n  return 1;\n  }\n}\n");
  });

  it("never matches across different line counts (structural guard)", () => {
    const out = applyEdit("a\nb\nc", "a\nc", "z", false);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not found/);
  });

  it("rejects a no-op edit and an empty old_str", () => {
    expect(applyEdit("abc", "abc", "abc", false).ok).toBe(false);
    expect(applyEdit("abc", "", "x", false).ok).toBe(false);
  });

  it("preserves CRLF line endings", () => {
    const out = applyEdit("a\r\nb\r\n", "a\r\nb", "c\r\nd", false);
    expect(out.ok).toBe(true);
    expect(out.content).toBe("c\r\nd\r\n");
  });
});

describe("edit tool", () => {
  it("refuses to edit a file that was not read first", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello\n");
    const result = await tool("edit").execute({ path: "a.txt", old_str: "hello", new_str: "hi" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read a\.txt/);
  });

  it("edits after read and reports the match level", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "hello world\n");
    await tool("read").execute({ path: "a.txt" }, ctx);
    const result = await tool("edit").execute({ path: "a.txt", old_str: "world", new_str: "saber" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/replaced 1 occurrence/);
  });

  it("allows editing a file created by write in the same session", async () => {
    await tool("write").execute({ path: "gen/x.txt", content: "one\n" }, ctx);
    const result = await tool("edit").execute({ path: "gen/x.txt", old_str: "one", new_str: "two" }, ctx);
    expect(result.isError).toBe(false);
  });

  it("rejects malformed arguments via zod", async () => {
    const result = await tool("edit").execute({ path: "a.txt", old_str: 42, new_str: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid arguments/);
  });
});

describe("read/write tools", () => {
  it("read returns numbered lines and registers freshness", async () => {
    writeFileSync(path.join(workspace, "n.txt"), "first\nsecond\n");
    const result = await tool("read").execute({ path: "n.txt" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("1\tfirst");
    expect(result.content).toContain("2\tsecond");
  });

  it("write is denied outside writable roots", async () => {
    const result = await tool("write").execute({ path: "/etc/saber-should-fail.txt", content: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/write denied/);
  });

  it("read denies secret patterns", async () => {
    writeFileSync(path.join(workspace, ".env"), "KEY=1\n");
    const result = await tool("read").execute({ path: ".env" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/secret/);
  });
});

describe("bash tool", () => {
  it("captures stdout and exit code", async () => {
    const result = await tool("bash").execute({ command: "echo hi" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/hi/);
    expect(result.content).toMatch(/\[exit: 0\]/);
  });

  it("marks non-zero exits as errors and keeps stderr", async () => {
    const result = await tool("bash").execute({ command: "echo boom >&2; exit 3" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/boom/);
    expect(result.content).toMatch(/\[exit: 3\]/);
  });
});

describe("grep tool", () => {
  beforeEach(() => {
    writeFileSync(path.join(workspace, "app.ts"), "const target = 1;\n// TODO find me\n");
    mkdirSync(path.join(workspace, "node_modules/pkg"), { recursive: true });
    writeFileSync(path.join(workspace, "node_modules/pkg/index.js"), "const target = 2;\n");
    writeFileSync(path.join(workspace, "notes.md"), "mention of target here\n");
  });

  it("finds matches with file:line format", async () => {
    const result = await tool("grep").execute({ pattern: "target" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/app\.ts:1/);
    expect(result.content).toMatch(/notes\.md:1/);
  });

  it("skips node_modules and respects glob filters", async () => {
    const result = await tool("grep").execute({ pattern: "target", glob: "*.ts" }, ctx);
    expect(result.content).toMatch(/app\.ts:1/);
    expect(result.content).not.toMatch(/node_modules/);
    expect(result.content).not.toMatch(/notes\.md/);
  });

  it("reports no matches without error", async () => {
    const result = await tool("grep").execute({ pattern: "zzz_no_such_thing" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("no matches");
  });
});

describe("glob tool", () => {
  beforeEach(() => {
    writeFileSync(path.join(workspace, "root.ts"), "x");
    mkdirSync(path.join(workspace, "src/nested/deep"), { recursive: true });
    writeFileSync(path.join(workspace, "src/nested/deep/a.ts"), "x");
    writeFileSync(path.join(workspace, "src/b.json"), "x");
    mkdirSync(path.join(workspace, "dist"), { recursive: true });
    writeFileSync(path.join(workspace, "dist/hidden.ts"), "x");
    writeFileSync(path.join(workspace, ".gitignore"), "dist/\n");
  });

  it("matches ** across directories", async () => {
    const result = await tool("glob").execute({ pattern: "**/*.ts" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/root\.ts/);
    expect(result.content).toMatch(/src\/nested\/deep\/a\.ts/);
  });

  it("respects .gitignore", async () => {
    const result = await tool("glob").execute({ pattern: "**/*.ts" }, ctx);
    expect(result.content).not.toMatch(/dist\/hidden\.ts/);
  });

  it("supports brace expansion", async () => {
    const result = await tool("glob").execute({ pattern: "**/*.{ts,json}" }, ctx);
    expect(result.content).toMatch(/src\/b\.json/);
    expect(result.content).toMatch(/root\.ts/);
  });
});

import { z } from "zod";
import { execa } from "execa";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkRead, checkWrite } from "./policy.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

type Args = Record<string, unknown>;

function parseArgs<T>(schema: z.ZodType<T>, args: Args): { ok: true; value: T } | { ok: false; result: ToolResult } {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, result: { content: `invalid arguments: ${issues}`, isError: true } };
  }
  return { ok: true, value: parsed.data };
}

/** Head/tail-preserving truncation: the middle carries the least signal. */
export function truncateMiddle(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.3);
  return `${text.slice(0, head)}\n… [truncated ${text.length - head - tail} chars of ${text.length}; read the file or narrow the command for the full output] …\n${text.slice(-tail)}`;
}

// ─── edit: four-level tolerant replacement ─────────────────────────

export interface EditOutcome {
  ok: boolean;
  content?: string;
  level?: string;
  replaced?: number;
  error?: string;
}

function unescapeJs(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\r/g, "").replace(/\\r/g, "\r");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { count++; i = haystack.indexOf(needle, i + needle.length); }
  return count;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  return i === -1 ? haystack : haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/**
 * Re-indent a dedented new_str against the matched window.
 * When line counts are equal, per-line indent transfer recovers the file's
 * true indentation (the window is ground truth). When the model added or
 * removed lines, positional correspondence is gone, so the whole block is
 * rebased onto the window's common indent, preserving the model's internal
 * relative structure.
 */
function reindentWindow(oldLines: string[], newLines: string[], winLines: string[]): string {
  const lead = (s: string) => s.match(/^[ \t]*/)![0];
  const commonOf = (ls: string[]): number => {
    let common: number | null = null;
    for (const l of ls) {
      if (!l.trim()) continue;
      const n = lead(l).length;
      common = common === null ? n : Math.min(common, n);
      if (common === 0) break;
    }
    return common ?? 0;
  };
  const commonOld = commonOf(oldLines);
  const commonNew = commonOf(newLines);
  const commonWin = commonOf(winLines);
  const strip = (line: string) => line.slice(lead(line).length);
  if (newLines.length === winLines.length) {
    return newLines.map((line, j) => {
      if (!line.trim()) return line;
      const newRel = lead(line).length - commonNew;
      const oldRel = lead(oldLines[j]).length - commonOld;
      if (newRel === oldRel) return lead(winLines[j]) + strip(line);
      return " ".repeat(Math.max(0, commonWin + newRel)) + strip(line);
    }).join("\n");
  }
  return newLines.map((line) => {
    if (!line.trim()) return line;
    return " ".repeat(Math.max(0, commonWin + lead(line).length - commonNew)) + strip(line);
  }).join("\n");
}

interface LineWindow { start: number; lines: string[]; indent: string }

function findLineWindows(content: string, oldStr: string, mode: "trimEnd" | "trim"): LineWindow[] {
  const lines = content.split("\n");
  const oldLines = oldStr.split("\n");
  const windows: LineWindow[] = [];
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      const a = mode === "trimEnd" ? lines[i + j].trimEnd() : lines[i + j].trim();
      const b = mode === "trimEnd" ? oldLines[j].trimEnd() : oldLines[j].trim();
      if (a !== b) { ok = false; break; }
    }
    if (!ok) continue;
    const first = lines.slice(i, i + oldLines.length).find((l) => l.trim());
    windows.push({ start: i, lines: lines.slice(i, i + oldLines.length), indent: first ? first.match(/^[ \t]*/)![0] : "" });
  }
  return windows;
}

/**
 * Tolerant replacement, tried in order of strictness:
 *   1. exact            — byte-for-byte
 *   2. escape-normalized— model emitted literal \n / \t
 *   3. trailing-ws      — per-line trailing whitespace ignored
 *   4. indent-flexible  — per-line full trim; new_str re-indented to match
 * Structural guard at every fuzzy level: line count must be identical,
 * so a "match" can never collapse or explode the file.
 */
export function applyEdit(content: string, rawOld: string, rawNew: string, replaceAll: boolean): EditOutcome {
  const oldStr = rawOld.replace(/\r\n/g, "\n");
  const newStr = rawNew.replace(/\r\n/g, "\n");
  if (oldStr.length === 0) return { ok: false, error: "old_str must not be empty" };
  if (oldStr === newStr) return { ok: false, error: "old_str and new_str are identical; nothing to do" };

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const body = content.replace(/\r\n/g, "\n");

  const levels: Array<{ name: string; old: string; neu: string }> = [
    { name: "exact", old: oldStr, neu: newStr },
  ];
  const unescapedOld = unescapeJs(oldStr);
  if (unescapedOld !== oldStr) levels.push({ name: "escape-normalized", old: unescapedOld, neu: unescapeJs(newStr) });

  for (const level of levels) {
    const n = countOccurrences(body, level.old);
    if (n === 0) continue;
    if (n > 1 && !replaceAll) {
      return { ok: false, error: `old_str matches ${n} locations (${level.name}); add surrounding context lines to make it unique, or pass replace_all: true` };
    }
    const next = replaceAll ? body.split(level.old).join(level.neu) : replaceFirst(body, level.old, level.neu);
    return { ok: true, content: next.replace(/\n/g, eol), level: level.name, replaced: replaceAll ? n : 1 };
  }

  for (const [name, mode] of [["trailing-ws", "trimEnd"], ["indent-flexible", "trim"]] as const) {
    const windows = findLineWindows(body, oldStr, mode);
    if (windows.length === 0) continue;
    if (windows.length > 1 && !replaceAll) {
      return { ok: false, error: `old_str matches ${windows.length} locations (${name}); add surrounding context lines to make it unique, or pass replace_all: true` };
    }
    const oldLines = oldStr.split("\n");
    const lines = body.split("\n");
    const targets = replaceAll ? windows : windows.slice(0, 1);
    for (let w = targets.length - 1; w >= 0; w--) {
      const win = targets[w];
      const replacement = mode === "trim" ? reindentWindow(oldLines, newStr.split("\n"), win.lines) : newStr;
      lines.splice(win.start, win.lines.length, ...replacement.split("\n"));
    }
    return { ok: true, content: lines.join(eol), level: name, replaced: targets.length };
  }

  return { ok: false, error: "old_str not found (tried exact, escape-normalized, trailing-ws, indent-flexible). The file may have changed — read it again and copy old_str verbatim." };
}

// ─── glob matching (also used for gitignore) ────────────────────────

function escapeRx(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function expandBraces(pattern: string, out: string[] = []): string[] {
  const m = pattern.match(/\{([^{},]+(?:,[^{},]+)+)\}/);
  if (!m) { out.push(pattern); return out; }
  for (const alt of m[1].split(",")) {
    expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index! + m[0].length), out);
    if (out.length > 64) break;
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  const variants = expandBraces(pattern).map((p) => {
    const segs = p.split("/");
    let re = "^";
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg === "**") {
        re += i === segs.length - 1 ? ".*" : "(?:[^/]+/)*";
        if (i !== segs.length - 1) continue; // trailing slash already consumed
      } else {
        re += seg.split("*").map((part) => escapeRx(part).replace(/\?/g, "[^/]")).join("[^/]*");
        if (i < segs.length - 1) re += "/";
      }
    }
    return re + "$";
  });
  return new RegExp(`(?:${variants.join("|")})`);
}

const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".cache"]);

function loadGitignore(root: string): string[] {
  try {
    return fs.readFileSync(path.join(root, ".gitignore"), "utf-8")
      .split("\n").map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
  } catch { return []; }
}

function isIgnored(rel: string, ignores: string[]): boolean {
  for (const raw of ignores) {
    const pat = raw.replace(/\/+$/, "");
    const anchored = pat.includes("/");
    const rx = globToRegExp(anchored ? pat.replace(/^\//, "") : `**/${pat}`);
    if (rx.test(rel)) return true;
    if (anchored && rx.test(rel.split("/").slice(0, -1).join("/"))) return true;
  }
  return false;
}

interface WalkOptions {
  root: string;
  maxFiles?: number;
  maxDepth?: number;
  filePattern?: RegExp;   // only return files matching
  linePattern?: RegExp;   // additionally grep contents
  maxMatches?: number;
}

function walk(opt: WalkOptions): { files: Array<{ rel: string; abs: string }>; matches: Array<{ rel: string; line: number; text: string }> } {
  const ignores = loadGitignore(opt.root);
  const files: Array<{ rel: string; abs: string }> = [];
  const matches: Array<{ rel: string; line: number; text: string }> = [];
  const maxFiles = opt.maxFiles ?? 5000;
  const maxDepth = opt.maxDepth ?? 16;
  let stopped = false;

  const visit = (dir: string, rel: string, depth: number): void => {
    if (stopped || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (stopped) return;
      if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(childRel, ignores)) continue;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(childAbs, childRel, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) { stopped = true; return; }
      if (opt.filePattern && !opt.filePattern.test(childRel)) continue;
      files.push({ rel: childRel, abs: childAbs });
      if (opt.linePattern) {
        try {
          const stat = fs.statSync(childAbs);
          if (stat.size > 1_000_000) continue;
          const text = fs.readFileSync(childAbs, "utf-8");
          if (text.includes("\0")) continue;
          text.split("\n").some((line, idx) => {
            if (opt.linePattern!.test(line)) {
              matches.push({ rel: childRel, line: idx + 1, text: line.slice(0, 400) });
              if (matches.length >= (opt.maxMatches ?? 200)) { stopped = true; return true; }
            }
            return false;
          });
        } catch { /* unreadable file: skip */ }
      }
    }
  };

  visit(opt.root, "", 0);
  return { files, matches };
}

// ─── ripgrep detection ──────────────────────────────────────────────

let rgProbe: Promise<boolean> | null = null;
function hasRipgrep(): Promise<boolean> {
  rgProbe ??= execa("rg", ["--version"], { reject: false, timeout: 5000 })
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  return rgProbe;
}

// ─── policy filter for grep output (drop lines from denied files) ──

function filterDeniedLines(lines: string[], ctx: ToolContext): string {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const file = line.split(":", 1)[0];
    if (file && checkRead(ctx.policy, file)) { dropped++; continue; }
    kept.push(line);
  }
  if (dropped > 0) kept.push(`[${dropped} result lines redacted by read policy]`);
  return kept.join("\n");
}

// ─── tool schemas ───────────────────────────────────────────────────

const BashArgs = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
});

const ReadArgs = z.object({ path: z.string().min(1) });

const WriteArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const EditArgs = z.object({
  path: z.string().min(1),
  old_str: z.string(),
  new_str: z.string(),
  replace_all: z.boolean().optional(),
});

const GrepArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
});

const GlobArgs = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

// ─── tool set ───────────────────────────────────────────────────────

export function createTools(ctx: ToolContext): ToolDefinition[] {
  const resolve = (p: string): string => path.resolve(ctx.cwd, p);

  const bash: ToolDefinition = {
    name: "bash",
    description:
      "Runs a bash command in the workspace and returns stdout/stderr with the exit code. " +
      "Use it for builds, tests, git, and anything not covered by a dedicated tool. " +
      "Long output is truncated in the middle; write to a file and read it back if you need the whole thing.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "optional, default 120000, max 600000" },
      },
      required: ["command"],
    },
    concurrency: "exclusive",
    async execute(args) {
      const parsed = parseArgs(BashArgs, args);
      if (!parsed.ok) return parsed.result;
      try {
        const result = await execa("bash", ["-c", parsed.value.command], {
          cwd: ctx.cwd,
          timeout: parsed.value.timeout_ms ?? 120_000,
          env: {
            PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
            LANG: process.env.LANG ?? "", TMPDIR: process.env.TMPDIR ?? "",
          },
          extendEnv: false,
          killSignal: "SIGKILL",
          reject: false,
        });
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
        const output = truncateMiddle(parts.join("\n") || "(no output)");
        return { content: `${output}\n[exit: ${result.exitCode}]`, isError: result.exitCode !== 0 };
      } catch (e) {
        return { content: `bash failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };

  const read: ToolDefinition = {
    name: "read",
    description:
      "Reads a file and returns it with line numbers (first 2000 lines). " +
      "You must read a file before editing it.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "file path, relative to cwd or absolute" } },
      required: ["path"],
    },
    concurrency: "read_only",
    async execute(args) {
      const parsed = parseArgs(ReadArgs, args);
      if (!parsed.ok) return parsed.result;
      const denied = checkRead(ctx.policy, parsed.value.path);
      if (denied) return { content: denied, isError: true };
      try {
        const abs = resolve(parsed.value.path);
        const content = await fs.promises.readFile(abs, "utf-8");
        const allLines = content.split("\n");
        const lines = allLines.slice(0, 2000);
        const numbered = lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l.slice(0, 2000)}`).join("\n");
        ctx.readFiles.add(abs);
        const note = allLines.length > 2000 ? `\n[${allLines.length} lines total, showing first 2000]` : "";
        return { content: numbered + note, isError: false };
      } catch (e) {
        return { content: `read failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };

  const write: ToolDefinition = {
    name: "write",
    description: "Creates or overwrites a file with the given content. Parent directories are created.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    concurrency: "exclusive",
    async execute(args) {
      const parsed = parseArgs(WriteArgs, args);
      if (!parsed.ok) return parsed.result;
      const denied = checkWrite(ctx.policy, parsed.value.path);
      if (denied) return { content: denied, isError: true };
      const abs = resolve(parsed.value.path);
      try {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, parsed.value.content);
        ctx.readFiles.add(abs);
        const n = parsed.value.content.split("\n").length;
        return { content: `wrote ${n} lines to ${parsed.value.path}`, isError: false };
      } catch (e) {
        return { content: `write failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };

  const edit: ToolDefinition = {
    name: "edit",
    description:
      "Replaces old_str with new_str in a file. old_str must identify at most one location unless replace_all is true. " +
      "Matching tolerates literal \\n escapes, trailing whitespace, and indentation differences " +
      "(new_str is re-indented to match the file), but line count must be identical. " +
      "The file must have been read (or written) in this session first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string", description: "exact text to replace, including enough context to be unique" },
        new_str: { type: "string" },
        replace_all: { type: "boolean", description: "replace every occurrence instead of requiring uniqueness" },
      },
      required: ["path", "old_str", "new_str"],
    },
    concurrency: "exclusive",
    async execute(args) {
      const parsed = parseArgs(EditArgs, args);
      if (!parsed.ok) return parsed.result;
      const readDenied = checkRead(ctx.policy, parsed.value.path);
      if (readDenied) return { content: readDenied, isError: true };
      const writeDenied = checkWrite(ctx.policy, parsed.value.path);
      if (writeDenied) return { content: writeDenied, isError: true };
      const abs = resolve(parsed.value.path);
      if (!ctx.readFiles.has(abs)) {
        return { content: `refused: read ${parsed.value.path} with the read tool before editing it`, isError: true };
      }
      try {
        const content = await fs.promises.readFile(abs, "utf-8");
        const outcome = applyEdit(content, parsed.value.old_str, parsed.value.new_str, parsed.value.replace_all ?? false);
        if (!outcome.ok) return { content: outcome.error!, isError: true };
        await fs.promises.writeFile(abs, outcome.content!);
        return { content: `replaced ${outcome.replaced} occurrence(s) in ${parsed.value.path} [match: ${outcome.level}]`, isError: false };
      } catch (e) {
        return { content: `edit failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };

  const grep: ToolDefinition = {
    name: "grep",
    description:
      "Searches file contents with a regular expression (smart-case: case-insensitive unless the pattern has capitals). " +
      "Uses ripgrep when installed, falls back to a built-in walker. " +
      "Respects .gitignore and skips node_modules/dist/.git. Optional glob filters files, e.g. \"*.ts\".",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "file or directory to search, default cwd" },
        glob: { type: "string" },
      },
      required: ["pattern"],
    },
    concurrency: "read_only",
    async execute(args) {
      const parsed = parseArgs(GrepArgs, args);
      if (!parsed.ok) return parsed.result;
      const searchPath = parsed.value.path ? resolve(parsed.value.path) : ctx.cwd;
      const denied = checkRead(ctx.policy, searchPath);
      if (denied) return { content: denied, isError: true };

      if (await hasRipgrep()) {
        try {
          const rgArgs = ["--line-number", "--no-heading", "--smart-case", "--max-count", "50"];
          if (parsed.value.glob) rgArgs.push("--glob", parsed.value.glob);
          rgArgs.push("--", parsed.value.pattern, searchPath);
          const result = await execa("rg", rgArgs, {
            cwd: ctx.cwd, timeout: 30_000, reject: false, maxBuffer: 10 * 1024 * 1024,
          });
          if (result.exitCode === 2) return { content: `grep failed: ${result.stderr || "rg error"}`, isError: true };
          if (result.exitCode === 1 || !result.stdout) return { content: "no matches", isError: false };
          return { content: truncateMiddle(filterDeniedLines(result.stdout.split("\n"), ctx)), isError: false };
        } catch { /* fall through to walker */ }
      }

      const flags = /[A-Z]/.test(parsed.value.pattern) ? "" : "i";
      let linePattern: RegExp;
      try { linePattern = new RegExp(parsed.value.pattern, flags); }
      catch { linePattern = new RegExp(escapeRx(parsed.value.pattern), flags); }
      const filePattern = parsed.value.glob ? globToRegExp(parsed.value.glob.includes("/") ? parsed.value.glob : `**/${parsed.value.glob}`) : undefined;
      const { matches } = walk({ root: searchPath, linePattern, filePattern, maxMatches: 200 });
      if (matches.length === 0) return { content: "no matches", isError: false };
      const lines = matches.map((m) => `${m.rel}:${m.line}:${m.text}`);
      return { content: truncateMiddle(filterDeniedLines(lines, ctx)), isError: false };
    },
  };

  const glob: ToolDefinition = {
    name: "glob",
    description:
      "Finds files by glob pattern (supports **, *, ?, {a,b}), sorted by modification time (newest first). " +
      "Respects .gitignore and skips node_modules/dist/.git. Returns up to 200 paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'e.g. "src/**/*.ts", "**/*.{json,md}"' },
        path: { type: "string", description: "directory to search, default cwd" },
      },
      required: ["pattern"],
    },
    concurrency: "read_only",
    async execute(args) {
      const parsed = parseArgs(GlobArgs, args);
      if (!parsed.ok) return parsed.result;
      const root = parsed.value.path ? resolve(parsed.value.path) : ctx.cwd;
      const denied = checkRead(ctx.policy, root);
      if (denied) return { content: denied, isError: true };
      const { files } = walk({ root, filePattern: globToRegExp(parsed.value.pattern), maxFiles: 20_000 });
      const sorted = files
        .map((f) => ({ ...f, mtime: fs.statSync(f.abs).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 200);
      if (sorted.length === 0) return { content: "no files matched", isError: false };
      return { content: sorted.map((f) => f.rel).join("\n") + `\n[${sorted.length} files]`, isError: false };
    },
  };

  return [bash, read, write, edit, grep, glob];
}

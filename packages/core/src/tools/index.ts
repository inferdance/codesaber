import { z } from "zod";
import { execa } from "execa";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkRead, checkWrite } from "../policy.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";
import { applyEdit } from "./edit.js";
import { escapeRegExp, globToRegExp, hasRipgrep, walk, type RgEvent } from "./search.js";
import { defineTool } from "./schema.js";

export { applyEdit, type EditOutcome } from "./edit.js";
export { globToRegExp } from "./search.js";
export { zodToParameters, defineTool } from "./schema.js";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Head/tail-preserving truncation: the middle carries the least signal. */
export function truncateMiddle(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.3);
  return `${text.slice(0, head)}\n… [truncated ${text.length - head - tail} chars of ${text.length}; read the file or narrow the command for the full output] …\n${text.slice(-tail)}`;
}

export function createTools(ctx: ToolContext): ToolDefinition[] {
  const resolve = (p: string): string => path.resolve(ctx.cwd, p);
  const deny = (abs: string): boolean => checkRead(ctx.policy, abs) !== null;
  const display = (abs: string): string => {
    const rel = path.relative(ctx.cwd, abs);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
  };

  const bash = defineTool(
    "bash",
    "Runs a bash command in the workspace and returns stdout/stderr with the exit code. " +
    "Use it for builds, tests, git, and anything not covered by a dedicated tool. " +
    "Long output is truncated in the middle; write to a file and read it back if you need the whole thing.",
    z.object({
      command: z.string().min(1),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional()
        .describe("optional, default 120000, max 600000"),
    }),
    "exclusive",
    async (args, tctx): Promise<ToolResult> => {
      const timeoutMs = args.timeout_ms ?? 120_000;
      let timedOut = false;
      try {
        // detached → the command runs as its own process-group leader; on
        // timeout (or turn abort) we SIGKILL the whole group so grandchildren
        // cannot survive (execa has no killDescendants option).
        const subprocess = execa("bash", ["-c", args.command], {
          cwd: tctx.cwd,
          env: {
            PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
            LANG: process.env.LANG ?? "", TMPDIR: process.env.TMPDIR ?? "",
          },
          extendEnv: false,
          killSignal: "SIGKILL",
          reject: false,
          detached: true,
          maxBuffer: 10 * 1024 * 1024,
        });
        const killGroup = (): void => {
          timedOut = true;
          if (subprocess.pid) {
            try { process.kill(-subprocess.pid, "SIGKILL"); } catch { /* already gone */ }
          }
        };
        const timer = setTimeout(killGroup, timeoutMs);
        tctx.signal?.addEventListener("abort", killGroup, { once: true });
        let result;
        try { result = await subprocess; } finally {
          clearTimeout(timer);
          tctx.signal?.removeEventListener("abort", killGroup);
        }
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
        const output = truncateMiddle(parts.join("\n") || "(no output)");
        const aborted = tctx.signal?.aborted ?? false;
        const exitLabel = result.exitCode !== null && result.exitCode !== undefined
          ? String(result.exitCode)
          : `signal ${result.signal ?? "SIGKILL"}${timedOut ? ` (timed out after ${timeoutMs}ms)` : aborted ? " (aborted)" : ""}`;
        return { content: `${output}\n[exit: ${exitLabel}]`, isError: result.exitCode !== 0 || timedOut || aborted };
      } catch (e) {
        return { content: `bash failed: ${errMsg(e)}`, isError: true };
      }
    },
  );

  const read = defineTool(
    "read",
    "Reads a file and returns it with absolute line numbers (default first 2000 lines). " +
    "Pass offset/limit to page through long files. You must read a file before editing it.",
    z.object({
      path: z.string().min(1).describe("file path, relative to cwd or absolute"),
      offset: z.number().int().min(1).optional().describe("1-based line to start from"),
      limit: z.number().int().min(1).max(2000).optional().describe("max lines to return (1-2000)"),
    }),
    "read_only",
    async (args, tctx): Promise<ToolResult> => {
      const denied = checkRead(tctx.policy, args.path);
      if (denied) return { content: denied, isError: true };
      try {
        const abs = path.resolve(tctx.cwd, args.path);
        const content = await fs.promises.readFile(abs, "utf-8");
        const allLines = content.split("\n");
        const offset = args.offset ?? 1;
        const limit = args.limit ?? 2000;
        const start = Math.min(offset - 1, allLines.length);
        const lines = allLines.slice(start, start + limit);
        const numbered = lines.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l.slice(0, 2000)}`).join("\n");
        tctx.readFiles.set(abs, (await fs.promises.stat(abs)).mtimeMs);
        const note = start + lines.length < allLines.length
          ? `\n[showing lines ${start + 1}-${start + lines.length} of ${allLines.length}]`
          : "";
        return { content: numbered + note, isError: false };
      } catch (e) {
        return { content: `read failed: ${errMsg(e)}`, isError: true };
      }
    },
  );

  const write = defineTool(
    "write",
    "Creates or overwrites a file with the given content. Parent directories are created.",
    z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    "exclusive",
    async (args, tctx): Promise<ToolResult> => {
      const denied = checkWrite(tctx.policy, args.path);
      if (denied) return { content: denied, isError: true };
      const abs = path.resolve(tctx.cwd, args.path);
      try {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, args.content);
        tctx.readFiles.set(abs, (await fs.promises.stat(abs)).mtimeMs);
        const n = args.content.split("\n").length;
        return { content: `wrote ${n} lines to ${args.path}`, isError: false };
      } catch (e) {
        return { content: `write failed: ${errMsg(e)}`, isError: true };
      }
    },
  );

  const edit = defineTool(
    "edit",
    "Replaces old_str with new_str in a file. old_str must identify at most one location unless replace_all is true. " +
    "Matching tolerates literal \\n escapes, trailing whitespace, indentation differences " +
    "(new_str is re-indented to match the file), and collapsed internal whitespace — but line count must be identical. " +
    "The file must have been read (or written) in this session, and unchanged since.",
    z.object({
      path: z.string().min(1),
      old_str: z.string().describe("exact text to replace, including enough context to be unique"),
      new_str: z.string(),
      replace_all: z.boolean().optional().describe("replace every occurrence instead of requiring uniqueness"),
    }),
    "exclusive",
    async (args, tctx): Promise<ToolResult> => {
      const readDenied = checkRead(tctx.policy, args.path);
      if (readDenied) return { content: readDenied, isError: true };
      const writeDenied = checkWrite(tctx.policy, args.path);
      if (writeDenied) return { content: writeDenied, isError: true };
      const abs = path.resolve(tctx.cwd, args.path);
      const knownMtime = tctx.readFiles.get(abs);
      if (knownMtime === undefined) {
        return { content: `refused: read ${args.path} with the read tool before editing it`, isError: true };
      }
      try {
        const stat = await fs.promises.stat(abs);
        if (stat.mtimeMs !== knownMtime) {
          return { content: `refused: ${args.path} changed since it was last read; read it again`, isError: true };
        }
        const content = await fs.promises.readFile(abs, "utf-8");
        const outcome = applyEdit(content, args.old_str, args.new_str, args.replace_all ?? false);
        if (!outcome.ok) return { content: outcome.error, isError: true };
        await fs.promises.writeFile(abs, outcome.content);
        tctx.readFiles.set(abs, (await fs.promises.stat(abs)).mtimeMs);
        return { content: `replaced ${outcome.replaced} occurrence(s) in ${args.path} [match: ${outcome.level}]`, isError: false };
      } catch (e) {
        return { content: `edit failed: ${errMsg(e)}`, isError: true };
      }
    },
  );

  const grep = defineTool(
    "grep",
    "Searches file contents with a regular expression (smart-case: case-insensitive unless the pattern has capitals). " +
    "Uses ripgrep when installed, falls back to a built-in walker. " +
    "Respects .gitignore, skips node_modules/dist/.git, and hides files denied by the read policy. " +
    "Optional glob filters files, e.g. \"*.ts\".",
    z.object({
      pattern: z.string().min(1),
      path: z.string().optional().describe("file or directory to search, default cwd"),
      glob: z.string().optional(),
    }),
    "read_only",
    async (args, tctx): Promise<ToolResult> => {
      const searchPath = args.path ? path.resolve(tctx.cwd, args.path) : tctx.cwd;
      const denied = checkRead(tctx.policy, searchPath);
      if (denied) return { content: denied, isError: true };

      // Compile-probe once: invalid regex degrades to an escaped literal for
      // BOTH backends, so rg and the walker always behave identically.
      const flags = /[A-Z]/.test(args.pattern) ? "" : "i";
      let searchRegex: string;
      try {
        new RegExp(args.pattern, flags);
        searchRegex = args.pattern;
      } catch {
        searchRegex = escapeRegExp(args.pattern);
      }

      if (await hasRipgrep()) {
        try {
          const rgArgs = ["--json", "--smart-case", "--max-count", "50"];
          if (args.glob) rgArgs.push("--glob", args.glob);
          // Pre-exclude denied patterns so rg never opens those files at all;
          // the output-side deny() below stays as a second layer.
          for (const suffix of tctx.policy.deniedReadSuffixes) {
            rgArgs.push("--glob", `!**/*${suffix}*`);
          }
          rgArgs.push("--", searchRegex, searchPath);
          const result = await execa("rg", rgArgs, {
            cwd: tctx.cwd, timeout: 30_000, reject: false, maxBuffer: 10 * 1024 * 1024,
          });
          if (result.exitCode === 2) return { content: `grep failed: ${result.stderr || "rg error"}`, isError: true };
          const out: string[] = [];
          let redacted = 0;
          for (const line of result.stdout.split("\n")) {
            if (!line || out.length >= 200) continue;
            let evt: RgEvent;
            try { evt = JSON.parse(line) as RgEvent; } catch { continue; }
            if (evt.type !== "match") continue;
            const file = evt.data?.path?.text;
            const text = evt.data?.lines?.text?.replace(/\r?\n$/, "");
            const lineNo = evt.data?.line_number;
            if (!file || text === undefined || lineNo === undefined) continue;
            if (deny(file)) { redacted++; continue; }
            out.push(`${display(file)}:${lineNo}:${text.slice(0, 400)}`);
          }
          if (out.length === 0) {
            return { content: redacted > 0 ? `no matches (${redacted} hidden by read policy)` : "no matches", isError: false };
          }
          if (redacted > 0) out.push(`[${redacted} matches hidden by read policy]`);
          return { content: truncateMiddle(out.join("\n")), isError: false };
        } catch { /* fall through to walker */ }
      }

      const linePattern = new RegExp(searchRegex, flags);
      const filePattern = args.glob ? globToRegExp(args.glob.includes("/") ? args.glob : `**/${args.glob}`) : undefined;
      const { matches, hidden } = walk({ root: searchPath, linePattern, filePattern, maxMatches: 200, deny });
      if (matches.length === 0) {
        return { content: hidden > 0 ? `no matches (${hidden} files hidden by read policy)` : "no matches", isError: false };
      }
      const lines = matches.map((m) => `${display(m.abs)}:${m.line}:${m.text}`);
      if (hidden > 0) lines.push(`[${hidden} files hidden by read policy]`);
      return { content: truncateMiddle(lines.join("\n")), isError: false };
    },
  );

  const glob = defineTool(
    "glob",
    "Finds files by glob pattern (supports **, *, ?, {a,b}), sorted by modification time (newest first). " +
    "Respects .gitignore, skips node_modules/dist/.git, and hides files denied by the read policy. Returns up to 200 paths.",
    z.object({
      pattern: z.string().min(1).describe('e.g. "src/**/*.ts", "**/*.{json,md}"'),
      path: z.string().optional().describe("directory to search, default cwd"),
    }),
    "read_only",
    async (args, tctx): Promise<ToolResult> => {
      const root = args.path ? path.resolve(tctx.cwd, args.path) : tctx.cwd;
      const denied = checkRead(tctx.policy, root);
      if (denied) return { content: denied, isError: true };
      const { files, hidden } = walk({ root, filePattern: globToRegExp(args.pattern), maxFiles: 20_000, deny });
      const sorted = files
        .map((f) => ({ rel: f.rel, mtime: fs.statSync(f.abs).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 200);
      if (sorted.length === 0) {
        return { content: hidden > 0 ? `no files matched (${hidden} hidden by read policy)` : "no files matched", isError: false };
      }
      const out = sorted.map((f) => f.rel);
      if (hidden > 0) out.push(`[${hidden} files hidden by read policy]`);
      return { content: out.join("\n"), isError: false };
    },
  );

  return [bash, read, write, edit, grep, glob];
}

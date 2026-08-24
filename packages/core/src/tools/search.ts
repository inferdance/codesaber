import { execa } from "execa";
import * as fs from "node:fs";
import * as path from "node:path";

const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".cache"]);

function escapeRx(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Full regex escaping for literal fallback searches (unlike escapeRx, which
 *  keeps glob metacharacters alive for glob-segment translation). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandBraces(pattern: string, out: string[] = []): string[] {
  const m = pattern.match(/\{([^{},]+(?:,[^{},]+)+)\}/);
  if (!m) { out.push(pattern); return out; }
  const start = m.index ?? 0;
  for (const alt of m[1].split(",")) {
    expandBraces(pattern.slice(0, start) + alt + pattern.slice(start + m[0].length), out);
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

export { escapeRx };

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

export interface WalkOptions {
  root: string;
  maxFiles?: number;
  maxDepth?: number;
  filePattern?: RegExp;   // only return files matching
  linePattern?: RegExp;   // additionally grep contents
  maxMatches?: number;
  deny?: (abs: string) => boolean;  // per-file policy gate; denied files are never read
}

export interface WalkResult {
  files: Array<{ rel: string; abs: string }>;
  matches: Array<{ abs: string; line: number; text: string }>;
  hidden: number;  // files skipped by the deny gate (never read, so match count unknown)
}

/**
 * Recursive walker with gitignore awareness; the root may be a file or a
 * directory. Synchronous by design for the headless CLI; when the M1 server
 * hosts it, wrap in a worker or convert to fs.promises so it cannot block
 * the event loop.
 */
export function walk(opt: WalkOptions): WalkResult {
  const ignores = loadGitignore(opt.root);
  const files: Array<{ rel: string; abs: string }> = [];
  const matches: Array<{ abs: string; line: number; text: string }> = [];
  const linePattern = opt.linePattern;
  const maxFiles = opt.maxFiles ?? 5000;
  const maxDepth = opt.maxDepth ?? 16;
  let stopped = false;
  let hidden = 0;

  const scanFile = (abs: string, rel: string): void => {
    if (!linePattern) return; // never touch file contents without a pattern (glob path)
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 1_000_000) return;
      const text = fs.readFileSync(abs, "utf-8");
      if (text.includes("\0")) return;
      text.split("\n").some((line, idx) => {
        if (linePattern.test(line)) {
          matches.push({ abs, line: idx + 1, text: line.slice(0, 400) });
          if (matches.length >= (opt.maxMatches ?? 200)) { stopped = true; return true; }
        }
        return false;
      });
    } catch { /* unreadable file: skip */ }
  };

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
      if (opt.deny?.(childAbs)) { hidden++; continue; }
      files.push({ rel: childRel, abs: childAbs });
      scanFile(childAbs, childRel);
    }
  };

  let rootIsFile = false;
  try { rootIsFile = fs.statSync(opt.root).isFile(); } catch { return { files, matches, hidden }; }
  if (rootIsFile) {
    const rel = path.basename(opt.root);
    if ((!opt.filePattern || opt.filePattern.test(rel)) && !opt.deny?.(opt.root)) {
      files.push({ rel, abs: opt.root });
      scanFile(opt.root, rel);
    }
    return { files, matches, hidden };
  }
  visit(opt.root, "", 0);
  return { files, matches, hidden };
}

let rgProbe: Promise<boolean> | null = null;

export function hasRipgrep(): Promise<boolean> {
  rgProbe ??= execa("rg", ["--version"], { reject: false, timeout: 5000 })
    .then((r) => r.exitCode === 0)
    .catch(() => false);
  return rgProbe;
}

export interface RgEvent {
  type: string;
  data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
}

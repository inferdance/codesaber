export type EditOutcome =
  | { ok: true; content: string; level: string; replaced: number }
  | { ok: false; error: string };

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
  const lead = (s: string) => s.match(/^[ \t]*/)?.[0] ?? "";
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

type WindowMode = "trimEnd" | "trim" | "collapse";

const NORM: Record<WindowMode, (s: string) => string> = {
  trimEnd: (s) => s.trimEnd(),
  trim: (s) => s.trim(),
  collapse: (s) => s.replace(/\s+/g, " ").trim(),
};

function findLineWindows(content: string, oldStr: string, mode: WindowMode): LineWindow[] {
  const norm = NORM[mode];
  const lines = content.split("\n");
  const oldLines = oldStr.split("\n");
  const windows: LineWindow[] = [];
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (norm(lines[i + j]) !== norm(oldLines[j])) { ok = false; break; }
    }
    if (!ok) continue;
    const first = lines.slice(i, i + oldLines.length).find((l) => l.trim());
    windows.push({ start: i, lines: lines.slice(i, i + oldLines.length), indent: first ? first.match(/^[ \t]*/)?.[0] ?? "" : "" });
  }
  return windows;
}

/**
 * Tolerant replacement, tried in order of strictness:
 *   1. exact               — byte-for-byte
 *   2. escape-normalized   — model emitted literal \n / \t
 *   3. trailing-ws         — per-line trailing whitespace ignored
 *   4. indent-flexible     — per-line full trim; new_str re-indented to match
 *   5. whitespace-normalized— internal whitespace runs collapsed for matching
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

  for (const [name, mode] of [
    ["trailing-ws", "trimEnd"],
    ["indent-flexible", "trim"],
    ["whitespace-normalized", "collapse"],
  ] as Array<[string, WindowMode]>) {
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

  return { ok: false, error: "old_str not found (tried exact, escape-normalized, trailing-ws, indent-flexible, whitespace-normalized). The file may have changed — read it again and copy old_str verbatim." };
}

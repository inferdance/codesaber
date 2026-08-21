/** Six-level progressive fallback chain for old/new string replacement. */
export interface EditParams {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

type Level =
  | "simple"
  | "escape_normalized"
  | "indentation_flexible"
  | "line_trimmed"
  | "block_anchor"
  | "whitespace_normalized";

const LEVELS: Level[] = [
  "simple", "escape_normalized", "indentation_flexible",
  "line_trimmed", "block_anchor", "whitespace_normalized",
];

interface Normalized {
  text: string;
  starts: number[];
  ends: number[];
}

function normalize(source: string, level: Level): Normalized {
  const text: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (ch: string, start: number, end: number) => {
    text.push(ch); starts.push(start); ends.push(end);
  };

  switch (level) {
    case "simple":
      for (let i = 0; i < source.length; i++) push(source[i], i, i + 1);
      break;
    case "escape_normalized": {
      for (let i = 0; i < source.length; i++) {
        if (source[i] === "\\" && i + 1 < source.length) {
          const next = source[i + 1];
          const decoded = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\" }[next];
          if (decoded) { push(decoded, i, i + 2); i++; continue; }
        }
        push(source[i], i, i + 1);
      }
      break;
    }
    case "indentation_flexible": {
      let atLineStart = true;
      for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        const isIndent = atLineStart && /\s/.test(ch) && ch !== "\n";
        if (!isIndent) push(ch, i, i + 1);
        atLineStart = ch === "\n";
      }
      break;
    }
    case "line_trimmed":
    case "block_anchor": {
      const collapse = level === "block_anchor";
      for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let offset = line.length - line.trimStart().length;
        for (let i = 0; i < trimmed.length; i++) {
          const ch = trimmed[i];
          if (collapse && /\s/.test(ch)) {
            // skip, will add single space before next non-ws
          } else {
            push(ch, offset + i, offset + i + 1);
          }
        }
        push("\n", line.length, line.length + 1);
        offset = 0;
      }
      break;
    }
    case "whitespace_normalized": {
      let pending = false;
      for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (/\s/.test(ch)) pending = true;
        else {
          if (pending) { push(" ", i - 1, i); pending = false; }
          push(ch, i, i + 1);
        }
      }
      break;
    }
  }
  return { text: text.join(""), starts, ends };
}

function findMatches(hay: string, needle: string): { spans: Array<[number, number]>; level: Level } | null {
  if (!needle) return null;
  for (const level of LEVELS) {
    const nh = normalize(hay, level);
    const nn = normalize(needle, level);
    if (!nn.text) continue;
    const spans: Array<[number, number]> = [];
    let cursor = 0;
    while (cursor <= nh.text.length - nn.text.length) {
      const found = nh.text.indexOf(nn.text, cursor);
      if (found === -1) break;
      const startNorm = found;
      const endNorm = found + nn.text.length;
      const startChar = nh.text.slice(0, startNorm).length;
      const endChar = nh.text.slice(0, endNorm).length;
      const startOrig = nh.starts[startChar] ?? hay.length;
      const endOrig = nh.ends[Math.max(endChar - 1, 0)] ?? hay.length;
      const spanLen = endOrig - startOrig;
      if (level === "simple" || !disproportionate(needle.length, spanLen)) {
        spans.push([startOrig, endOrig]);
      }
      cursor = endNorm;
    }
    if (spans.length > 0) return { spans, level };
  }
  return null;
}

function disproportionate(needleLen: number, spanLen: number): boolean {
  return spanLen > needleLen * 2 + 8;
}

export function applyEdit(content: string, params: EditParams): { content: string; summary: string } {
  const { old_string, new_string, replace_all } = params;
  const match = findMatches(content, old_string);
  if (!match) {
    throw new Error(`old_string not found (tried all 6 levels); expected ${JSON.stringify(old_string.slice(0, 100))}`);
  }
  let spans = match.spans;
  if (spans.length > 1 && !replace_all) {
    throw new Error(`old_string matches ${spans.length} locations; provide more context or set replace_all`);
  }
  if (!replace_all) spans = spans.slice(0, 1);
  spans.sort((a, b) => a[0] - b[0]);

  let result = content;
  for (let i = spans.length - 1; i >= 0; i--) {
    result = result.slice(0, spans[i][0]) + new_string + result.slice(spans[i][1]);
  }
  return {
    content: result,
    summary: `applied ${spans.length} replacement(s) via ${match.level} matching`,
  };
}

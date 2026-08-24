import type { Usage } from "./types.js";

/**
 * Rough per-million-token price estimates (USD), matched by model-name
 * prefix. Hand-maintained and approximate by design — the exact number
 * matters less than never reporting a confident $0. Unknown models price at
 * 0 rather than guessing.
 */
interface Price {
  prefix: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const TABLE: Price[] = [
  { prefix: "gpt-4o-mini", input: 0.15, output: 0.6 },
  { prefix: "gpt-4o", input: 2.5, output: 10 },
  { prefix: "gpt-4.1", input: 3, output: 12 },
  { prefix: "gpt-5", input: 5, output: 15 },
  { prefix: "o4-mini", input: 1.1, output: 4.4 },
  { prefix: "claude-opus-4", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: "claude-sonnet-4", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-haiku", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { prefix: "deepseek-chat", input: 0.27, output: 1.1, cacheRead: 0.07 },
  { prefix: "deepseek-reasoner", input: 0.55, output: 2.19, cacheRead: 0.14 },
];

const PER_MTOK = 1_000_000;

export function estimateCostUsd(model: string, usage: Usage): number {
  const price = TABLE.find((p) => model.startsWith(p.prefix));
  if (!price) return 0;
  const cost =
    (usage.input_tokens / PER_MTOK) * price.input +
    (usage.output_tokens / PER_MTOK) * price.output +
    (usage.cache_read_tokens / PER_MTOK) * (price.cacheRead ?? 0) +
    (usage.cache_write_tokens / PER_MTOK) * (price.cacheWrite ?? 0);
  // cents-level rounding: four significant digits keep the display honest
  return Math.round(cost * 10_000) / 10_000;
}

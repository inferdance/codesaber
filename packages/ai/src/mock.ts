import type { Provider, ChatRequest, ProviderEvent } from "./types.js";

export function createMockProvider(
  name: string,
  steps: ProviderEvent[][],
): Provider & { calls: number } {
  let next = 0;
  const p: Provider & { calls: number } = {
    name,
    calls: 0,
    async *stream(_request: ChatRequest): AsyncGenerator<ProviderEvent> {
      p.calls++;
      const events = steps[next] ?? [
        { type: "finish" as const, reason: "stop" as const, usage: zeroUsage() },
      ];
      next = (next + 1) % Math.max(steps.length, 1);
      yield* events;
    },
  };
  return p;
}

export function zeroUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
}

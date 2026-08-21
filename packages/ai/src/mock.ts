import type { ChatRequest, Provider, ProviderEvent } from "./types.ts";

export function createMockProvider(
  name: string,
  steps: ProviderEvent[][],
): Provider & { calls: number } {
  let next = 0;
  return {
    name,
    calls: 0,
    async *stream(_request: ChatRequest): AsyncGenerator<ProviderEvent> {
      const events = steps[next] ?? [{ type: "finish" as const, reason: "stop" as const, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 } }];
      next = (next + 1) % Math.max(steps.length, 1);
      this.calls++;
      yield* events;
    },
  };
}

import { describe, it, expect } from "vitest";
import { streamWithRetry } from "../retry.ts";
import type { ProviderEvent } from "../types.ts";

describe("retry", () => {
  it("yields all events from a successful step", async () => {
    let call = 0;
    const provider = {
      name: "test",
      async *stream() {
        call++;
        yield { type: "text_delta" as const, text_delta: "hello" };
        yield { type: "finish" as const, reason: "stop" as const, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 } };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry(provider, { model: "m", messages: [], tools: [] }, { maxAttempts: 1, baseDelayMs: 1 })) {
      events.push(e);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text_delta: "hello" });
  });

  it("retries on rate limit and recovers", async () => {
    let call = 0;
    const provider = {
      name: "flaky",
      async *stream() {
        call++;
        if (call <= 1) {
          yield { type: "error" as const, message: "429", retryable: "rate_limit" as const };
        } else {
          yield { type: "text_delta" as const, text_delta: "recovered" };
          yield { type: "finish" as const, reason: "stop" as const, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 } };
        }
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry(provider, { model: "m", messages: [], tools: [] }, { maxAttempts: 3, baseDelayMs: 1 })) {
      events.push(e);
    }
    expect(call).toBe(2);
    expect(events[0]).toEqual({ type: "text_delta", text_delta: "recovered" });
  });

  it("gives up after max attempts", async () => {
    const provider = {
      name: "always-fail",
      async *stream() {
        yield { type: "error" as const, message: "500", retryable: "server_error" as const };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry(provider, { model: "m", messages: [], tools: [] }, { maxAttempts: 2, baseDelayMs: 1 })) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });
});

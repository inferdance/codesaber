import type { ChatRequest, Provider, ProviderEvent } from "./types.ts";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500 };

export async function* streamWithRetry(
  provider: Provider,
  request: ChatRequest,
  policy: RetryPolicy = defaultRetryPolicy,
): AsyncGenerator<ProviderEvent> {
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    let firstEvent: ProviderEvent | null = null;
    for await (const event of provider.stream(request)) {
      if (!firstEvent) {
        firstEvent = event;
        if (event.type === "error" && event.retryable !== "fatal" && attempt < policy.maxAttempts) {
          await sleep(policy.baseDelayMs * Math.pow(2, attempt - 1));
          break; // retry
        }
      }
      yield event;
      if (firstEvent === event && event.type === "error") return; // fatal, no retry
    }
    if (firstEvent && firstEvent.type !== "error") return; // success
    if (attempt === policy.maxAttempts && firstEvent) {
      yield firstEvent; // give up, surface the error
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

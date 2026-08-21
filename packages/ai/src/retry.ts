import type { Provider, ChatRequest, ProviderEvent } from "./types.js";

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
    let shouldRetry = false;

    for await (const event of provider.stream(request)) {
      if (!firstEvent) {
        firstEvent = event;
        if (event.type === "error" && event.retryable !== "fatal" && attempt < policy.maxAttempts) {
          shouldRetry = true;
          break;
        }
      }
      yield event;
      if (event.type === "finish" || event.type === "error") return;
    }

    if (shouldRetry) {
      await new Promise((r) => setTimeout(r, policy.baseDelayMs * Math.pow(2, attempt - 1)));
      continue;
    }

    if (firstEvent && firstEvent.type === "error") return;
    return;
  }
}

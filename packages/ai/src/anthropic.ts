import type { Message, Provider, ChatRequest, ProviderEvent, Usage } from "./types.js";
import { SseParser } from "./sse.js";
import { estimateCostUsd } from "./pricing.js";

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

function toWireMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content: unknown[] = [];
      let text = "";
      for (const b of msg.blocks) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_result") {
          if (text) { content.push({ type: "text", text }); text = ""; }
          content.push({ type: "tool_result", tool_use_id: b.call_id, content: b.content });
        }
      }
      if (text) content.push({ type: "text", text });
      if (content.length) out.push({ role: "user", content });
    } else {
      const content: unknown[] = [];
      for (const b of msg.blocks) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_call") {
          content.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments });
        }
      }
      if (content.length) out.push({ role: "assistant", content });
    }
  }
  return out;
}

export function createAnthropicProvider(config: AnthropicConfig): Provider {
  return {
    name: "anthropic",
    async *stream(request: ChatRequest): AsyncGenerator<ProviderEvent> {
      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/v1/messages`, {
          method: "POST",
          signal: request.signal,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: request.model || config.defaultModel,
            messages: toWireMessages(request.messages),
            max_tokens: request.max_tokens ?? 8192,
            stream: true,
            ...(request.system ? { system: request.system } : {}),
            ...(request.tools.length > 0 ? {
              tools: request.tools.map((t) => ({
                name: t.name, description: t.description, input_schema: t.parameters,
              })),
            } : {}),
          }),
        });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          yield { type: "error", message: "aborted", retryable: "fatal" };
        } else {
          yield { type: "error", message: `request failed: ${e}`, retryable: "network" };
        }
        return;
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        const retryable = response.status === 429 ? "rate_limit" as const
          : response.status === 529 || response.status >= 500 ? "server_error" as const
          : "fatal" as const;
        yield { type: "error", message: `HTTP ${response.status}: ${text}`, retryable };
        return;
      }

      const parser = new SseParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const blockToolIds = new Map<number, string>();
      let finishReason: string = "stop";
      const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
            let v: any;
            try { v = JSON.parse(payload); } catch { continue; }
            switch (v.type) {
              case "message_start":
                if (v.message?.usage) {
                  usage.input_tokens = v.message.usage.input_tokens ?? 0;
                  usage.cache_read_tokens = v.message.usage.cache_read_input_tokens ?? 0;
                  usage.cache_write_tokens = v.message.usage.cache_creation_input_tokens ?? 0;
                }
                break;
              case "content_block_start":
                if (v.content_block?.type === "tool_use") {
                  const id = v.content_block.id ?? "";
                  blockToolIds.set(v.index ?? 0, id);
                  yield { type: "tool_call_start", id, name: v.content_block.name ?? "" };
                }
                break;
              case "content_block_delta": {
                const d = v.delta;
                if (d?.type === "text_delta" && d.text) {
                  yield { type: "text_delta", text_delta: d.text };
                } else if (d?.type === "thinking_delta" && d.thinking) {
                  yield { type: "thinking_delta", text_delta: d.thinking };
                } else if (d?.type === "input_json_delta" && d.partial_json) {
                  const id = blockToolIds.get(v.index ?? 0);
                  if (id) yield { type: "tool_call_delta", id, arguments_delta: d.partial_json };
                }
                break;
              }
              case "message_delta":
                if (v.delta?.stop_reason) finishReason = v.delta.stop_reason;
                if (v.usage?.output_tokens) usage.output_tokens = v.usage.output_tokens;
                // some anthropic-compatible endpoints (e.g. GLM) only report
                // input tokens in the final delta, not in message_start
                if (v.usage?.input_tokens) usage.input_tokens = Math.max(usage.input_tokens, v.usage.input_tokens);
                break;
              case "message_stop": {
                usage.cost_usd = estimateCostUsd(request.model || config.defaultModel, usage);
                yield { type: "finish", reason: finishReason as "stop" | "tool_calls" | "length", usage };
                return;
              }
              case "error":
                yield { type: "error", message: v.error?.message ?? "provider error", retryable: "server_error" };
                return;
            }
          }
        }
        yield { type: "error", message: "stream ended without message_stop", retryable: "network" };
      } catch (e) {
        yield { type: "error", message: `stream read failed: ${e}`, retryable: "network" };
      } finally {
        reader.releaseLock();
      }
    },
  };
}

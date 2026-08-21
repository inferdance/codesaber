import { SseParser } from "./sse.ts";
import type { ChatRequest, Message, Provider, ProviderEvent, Usage } from "./types.ts";

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  pricing?: { input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok: number; cache_write_per_mtok: number };
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content: unknown[] = [];
      let text = "";
      for (const b of msg.blocks) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_result") {
          if (text) { content.push({ type: "text", text }); text = ""; }
          content.push({ type: "tool_result", tool_use_id: b.call_id, content: b.content, is_error: b.is_error });
        }
      }
      if (text) content.push({ type: "text", text });
      if (content.length) out.push({ role: "user", content });
    } else {
      const content: unknown[] = [];
      for (const b of msg.blocks) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "thinking") content.push({ type: "thinking", thinking: b.text, signature: b.signature ?? "" });
        else if (b.type === "tool_call") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments });
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
      const model = request.model || config.defaultModel;
      const body: Record<string, unknown> = {
        model,
        messages: toAnthropicMessages(request.messages),
        max_tokens: request.max_tokens ?? 8192,
        stream: true,
      };
      if (request.system) {
        body.system = request.cache_system_prompt
          ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]
          : request.system;
      }
      if (request.thinking_budget_tokens) {
        body.thinking = { type: "enabled", budget_tokens: Math.max(request.thinking_budget_tokens, 1024) };
      }
      if (request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({
          name: t.name, description: t.description, input_schema: t.parameters,
        }));
      }

      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        yield { type: "error", message: `request failed: ${e}`, retryable: "network" };
        return;
      }

      if (!response.ok) {
        const text = await response.text();
        const retryable = response.status === 429 ? "rate_limit"
          : response.status >= 500 ? "server_error" : "fatal";
        yield { type: "error", message: `HTTP ${response.status}: ${text}`, retryable };
        return;
      }

      const parser = new SseParser();
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const blockToolIds = new Map<number, string>();
      let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
            let v: any;
            try { v = JSON.parse(payload); } catch {
              yield { type: "error", message: "malformed SSE frame", retryable: "fatal" };
              return;
            }
            switch (v.type) {
              case "message_start":
                if (v.message?.usage) {
                  usage.input_tokens = v.message.usage.input_tokens ?? 0;
                  usage.cache_read_tokens = v.message.usage.cache_read_input_tokens ?? 0;
                  usage.cache_write_tokens = v.message.usage.cache_creation_input_tokens ?? 0;
                }
                break;
              case "content_block_start": {
                const idx = v.index ?? 0;
                if (v.content_block?.type === "tool_use") {
                  const id = v.content_block.id ?? "";
                  blockToolIds.set(idx, id);
                  yield { type: "tool_call_start", id, name: v.content_block.name ?? "" };
                }
                break;
              }
              case "content_block_delta": {
                const idx = v.index ?? 0;
                const d = v.delta;
                if (d?.type === "text_delta" && d.text)
                  yield { type: "text_delta", text_delta: d.text };
                else if (d?.type === "thinking_delta" && d.thinking)
                  yield { type: "thinking_delta", text_delta: d.thinking };
                else if (d?.type === "signature_delta" && d.signature)
                  yield { type: "thinking_delta", text_delta: "", signature: d.signature };
                else if (d?.type === "input_json_delta" && d.partial_json) {
                  const id = blockToolIds.get(idx);
                  if (id && d.partial_json)
                    yield { type: "tool_call_delta", id, arguments_delta: d.partial_json };
                }
                break;
              }
              case "message_delta":
                if (v.usage?.output_tokens) usage.output_tokens = v.usage.output_tokens;
                break;
              case "message_stop":
                if (config.pricing) {
                  usage.cost_usd =
                    (usage.input_tokens / 1e6) * config.pricing.input_per_mtok +
                    (usage.output_tokens / 1e6) * config.pricing.output_per_mtok +
                    (usage.cache_read_tokens / 1e6) * (config.pricing.cache_read_per_mtok ?? 0) +
                    (usage.cache_write_tokens / 1e6) * (config.pricing.cache_write_per_mtok ?? 0);
                }
                yield { type: "finish", reason: "stop", usage };
                return;
              case "error":
                yield { type: "error", message: v.error?.message ?? "provider error", retryable: "server_error" };
                return;
            }
          }
        }
        yield { type: "error", message: "stream ended without message_stop", retryable: "network" };
      } finally {
        reader.releaseLock();
      }
    },
  };
}

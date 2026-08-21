import { SseParser } from "./sse.ts";
import type { ChatRequest, Message, Provider, ProviderEvent, Usage } from "./types.ts";

export interface OpenAiConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  pricing?: { input_per_mtok: number; output_per_mtok: number };
}

function toOpenAiMessages(system: string | undefined, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const msg of messages) {
    if (msg.role === "user") {
      let text = "";
      for (const b of msg.blocks) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_result")
          out.push({ role: "tool", tool_call_id: b.call_id, content: b.content });
      }
      if (text) out.push({ role: "user", content: text });
    } else {
      let text = "";
      const tool_calls: unknown[] = [];
      for (const b of msg.blocks) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_call")
          tool_calls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.arguments) },
          });
      }
      if (text || tool_calls.length > 0)
        out.push({ role: "assistant", content: text || null, tool_calls });
    }
  }
  return out;
}

export function createOpenAiProvider(config: OpenAiConfig): Provider {
  return {
    name: config.name,
    async *stream(request: ChatRequest): AsyncGenerator<ProviderEvent> {
      const model = request.model || config.defaultModel;
      const body = {
        model,
        messages: toOpenAiMessages(request.system, request.messages),
        tools: request.tools.length > 0 ? request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })) : undefined,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.max_tokens,
        temperature: request.temperature,
      };

      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
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
          : response.status >= 500 ? "server_error"
          : response.status === 408 ? "timeout" : "fatal";
        yield { type: "error", message: `HTTP ${response.status}: ${text}`, retryable };
        return;
      }

      const parser = new SseParser();
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const toolIds = new Map<number, string>();
      let usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
            if (payload === "[DONE]") {
              if (config.pricing) {
                usage.cost_usd =
                  (usage.input_tokens / 1e6) * config.pricing.input_per_mtok +
                  (usage.output_tokens / 1e6) * config.pricing.output_per_mtok;
              }
              yield { type: "finish", reason: "stop", usage };
              return;
            }
            let v: any;
            try { v = JSON.parse(payload); } catch {
              yield { type: "error", message: `malformed SSE frame`, retryable: "fatal" };
              return;
            }
            if (v.usage) {
              usage.input_tokens = v.usage.prompt_tokens ?? 0;
              usage.output_tokens = v.usage.completion_tokens ?? 0;
              usage.cache_read_tokens = v.usage.prompt_tokens_details?.cached_tokens ?? 0;
            }
            const choice = v.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason === "tool_calls") { /* handled by [DONE] */ }
            if (choice.finish_reason === "length") { /* model hit token limit */ }
            const delta = choice.delta;
            if (delta?.content) yield { type: "text_delta", text_delta: delta.content };
            const reasoning = delta?.reasoning_content ?? delta?.reasoning;
            if (reasoning) yield { type: "thinking_delta", text_delta: reasoning };
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (tc.id && tc.function?.name) {
                  toolIds.set(idx, tc.id);
                  yield { type: "tool_call_start", id: tc.id, name: tc.function.name };
                }
                if (tc.function?.arguments) {
                  const id = toolIds.get(idx);
                  if (id) yield { type: "tool_call_delta", id, arguments_delta: tc.function.arguments };
                }
              }
            }
          }
        }
        // Stream ended without [DONE]: premature EOF
        yield { type: "error", message: "stream ended without [DONE]", retryable: "network" };
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/** Content blocks (mirrors saber-protocol Block). */
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; call_id: string; content: string; is_error?: boolean }
  | { type: "image"; media_type: string; data_base64: string };

export interface Message {
  role: "user" | "assistant";
  blocks: Block[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSchema[];
  max_tokens?: number;
  temperature?: number;
  thinking_budget_tokens?: number;
  cache_system_prompt?: boolean;
}

export type FinishReason = "stop" | "tool_calls" | "length";
export type RetryKind = "rate_limit" | "timeout" | "server_error" | "network" | "fatal";

export type ProviderEvent =
  | { type: "text_delta"; text_delta: string }
  | { type: "thinking_delta"; text_delta: string; signature?: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments_delta: string }
  | { type: "finish"; reason: FinishReason; usage: Usage }
  | { type: "error"; message: string; retryable: RetryKind };

export interface Provider {
  name: string;
  stream(request: ChatRequest): AsyncGenerator<ProviderEvent>;
}

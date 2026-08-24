import type { Provider, ChatRequest, ProviderEvent, Usage, Message, Block } from "@saber/ai";
import { streamWithRetry } from "@saber/ai";
import type { ToolDefinition, ToolContext, ToolResult } from "./types.js";
import type { SessionLog } from "./session.js";

export type TurnOutcome =
  | { kind: "done" }
  | { kind: "doom_loop"; message: string }
  | { kind: "length_refusal" }
  | { kind: "max_steps" }
  | { kind: "provider_failure"; message: string };

export interface TurnInput { userMessage: string; system?: string }

export interface EngineEvent {
  type: string;
  turnId?: string;
  stepId?: string;
  callId?: string;
  name?: string;
  text?: string;
  isError?: boolean;
  usage?: Usage;
  message?: string;
  [key: string]: unknown;
}

const MAX_STEPS = 64;

export interface EngineOptions {
  provider: Provider;
  tools: ToolDefinition[];
  session: SessionLog;
  toolContext: ToolContext;
  model: string;
  onEvent?: (event: EngineEvent) => void;
}

export class Engine {
  private history: Message[] = [];
  private usageTotal: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
  private steering: string[] = [];

  constructor(private opts: EngineOptions) {}

  steer(msg: string): void { this.steering.push(msg); }
  getUsage(): Usage { return { ...this.usageTotal }; }

  async runTurn(input: TurnInput): Promise<{ answer: string; outcome: TurnOutcome }> {
    const turnId = `t-${this.opts.session.nextSeq()}`;
    this.emit({ type: "turn_started", turnId });

    this.opts.session.append("user_message", {
      message: { role: "user", blocks: [{ type: "text", text: input.userMessage }] },
    });
    this.history.push({ role: "user", blocks: [{ type: "text", text: input.userMessage }] });

    let lastText = "";
    let outcome: TurnOutcome = { kind: "done" };
    let doomTracker: { name: string; argsJson: string; count: number } | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      const stepId = `${turnId}-s${step}`;
      this.emit({ type: "step_started", turnId, stepId });

      while (this.steering.length > 0) {
        const msg = this.steering.shift()!;
        this.history.push({ role: "user", blocks: [{ type: "text", text: msg }] });
      }

      const request: ChatRequest = {
        model: this.opts.model,
        system: input.system,
        messages: this.history,
        tools: this.opts.tools.map((t) => ({
          name: t.name, description: t.description, parameters: t.parameters,
        })),
      };

      let text = "";
      let thinking = "";
      const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
      const activeCalls = new Map<string, { name: string; args: string }>();
      const callOrder: string[] = [];
      let finishReason = "stop";
      let stepUsage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
      let providerError: string | null = null;

      try {
        for await (const event of streamWithRetry(this.opts.provider, request)) {
          switch (event.type) {
            case "text_delta":
              text += event.text_delta;
              this.emit({ type: "assistant_delta", turnId, stepId, text: event.text_delta });
              break;
            case "thinking_delta": thinking += event.text_delta; break;
            case "tool_call_start":
              if (!activeCalls.has(event.id)) callOrder.push(event.id);
              activeCalls.set(event.id, { name: event.name, args: "" });
              break;
            case "tool_call_delta": {
              const call = activeCalls.get(event.id);
              if (call) call.args += event.arguments_delta;
              break;
            }
            case "finish": finishReason = event.reason; stepUsage = event.usage; break;
            case "error": providerError = event.message; break;
          }
          if (providerError) break;
        }
      } catch (e) {
        providerError = `unhandled: ${e}`;
      }

      if (providerError) {
        this.emit({ type: "error", message: providerError });
        outcome = { kind: "provider_failure", message: providerError };
        break;
      }

      for (const id of callOrder) {
        const call = activeCalls.get(id);
        if (call) {
          try {
            toolCalls.push({ id, name: call.name, arguments: JSON.parse(call.args) });
          } catch {
            this.emit({ type: "error", message: `malformed args for ${call.name}; rejected` });
          }
        }
      }

      this.usageTotal.input_tokens += stepUsage.input_tokens;
      this.usageTotal.output_tokens += stepUsage.output_tokens;
      this.usageTotal.cost_usd += stepUsage.cost_usd;
      this.emit({ type: "step_finished", turnId, stepId, usage: stepUsage });

      const blocks: Block[] = [];
      if (thinking) blocks.push({ type: "thinking", text: thinking });
      if (text) blocks.push({ type: "text", text });
      for (const tc of toolCalls) blocks.push({ type: "tool_call", ...tc });
      if (blocks.length > 0) {
        this.opts.session.append("assistant_message", { message: { role: "assistant", blocks }, usage: stepUsage });
        this.history.push({ role: "assistant", blocks });
      }

      if (toolCalls.length === 0) { lastText = text; outcome = { kind: "done" }; break; }

      if (finishReason === "length") {
        this.emit({ type: "error", message: "truncated; refusing tool calls" });
        outcome = { kind: "length_refusal" };
        break;
      }

      lastText = text;

      const firstCall = toolCalls[0];
      const currentArgsJson = JSON.stringify(firstCall.arguments);
      const isRepeat = doomTracker !== null && doomTracker.name === firstCall.name && doomTracker.argsJson === currentArgsJson;
      const doomed: number = isRepeat ? (doomTracker?.count ?? 0) + 1 : 1;
      doomTracker = { name: firstCall.name, argsJson: currentArgsJson, count: doomed };
      if (doomed >= 3) {
        const message = `doom-loop: ${firstCall.name} ×3`;
        this.emit({ type: "error", message });
        outcome = { kind: "doom_loop", message };
        break;
      }

      const results = await this.executeTools(turnId, stepId, toolCalls);
      const resultBlocks: Block[] = results.map(([callId, result]) => ({
        type: "tool_result" as const, call_id: callId, content: result.content, is_error: result.isError,
      }));
      if (resultBlocks.length > 0) {
        this.opts.session.append("user_message", { message: { role: "user", blocks: resultBlocks } });
        this.history.push({ role: "user", blocks: resultBlocks });
      }

      if (step + 1 === MAX_STEPS) outcome = { kind: "max_steps" };
    }

    this.emit({ type: "turn_complete", turnId, reason: outcome.kind });
    return { answer: lastText, outcome };
  }

  private async executeTools(
    turnId: string, stepId: string,
    calls: Array<{ id: string; name: string; arguments: unknown }>,
  ): Promise<Array<[string, ToolResult]>> {
    const executable: typeof calls = [];
    const results: Array<[string, ToolResult]> = [];
    for (const call of calls) {
      try {
        this.opts.session.append("tool_call", { call_id: call.id, name: call.name, arguments: call.arguments }, true);
        this.emit({ type: "tool_started", turnId, stepId, callId: call.id, name: call.name });
        executable.push(call);
      } catch (e) {
        results.push([call.id, { content: `WAL failed: ${e}`, isError: true }]);
      }
    }
    const batch = executable.map((c) => ({ name: c.name, args: c.arguments as Record<string, unknown> }));
    const batchResults = await this.executeBatch(batch);
    for (let i = 0; i < executable.length; i++) {
      const result = batchResults[i];
      this.opts.session.append("tool_result", { call_id: executable[i].id, content: result.content, is_error: result.isError });
      this.emit({ type: "tool_completed", callId: executable[i].id, isError: result.isError });
      results.push([executable[i].id, result]);
    }
    return results;
  }

  private async executeBatch(calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<ToolResult[]> {
    const slots: Array<{ index: number; tool: ToolDefinition | null; args: Record<string, unknown> }> = calls.map((call, index) => ({
      index, tool: this.opts.tools.find((t) => t.name === call.name) ?? null, args: call.args,
    }));
    const results: ToolResult[] = new Array(calls.length);
    const readOnly = slots.filter((s) => s.tool !== null && s.tool.concurrency === "read_only");
    const exclusive = slots.filter((s) => s.tool !== null && s.tool.concurrency !== "read_only");
    const missing = slots.filter((s) => s.tool === null);
    for (const slot of missing) {
      results[slot.index] = { content: `unknown tool: ${calls[slot.index].name}`, isError: true };
    }
    const readResults = await Promise.all(
      readOnly.map((slot) => slot.tool!.execute(slot.args, this.opts.toolContext)),
    );
    readOnly.forEach((slot, i) => { results[slot.index] = readResults[i]; });
    for (const slot of exclusive) {
      results[slot.index] = await slot.tool!.execute(slot.args, this.opts.toolContext);
    }
    return results;
  }

  private emit(event: EngineEvent): void { this.opts.onEvent?.(event); }
}

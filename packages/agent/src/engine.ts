import type { Provider, ProviderEvent, ChatRequest, Usage, Message, Block } from "@saber/ai";
import { streamWithRetry } from "@saber/ai";
import type { ToolDefinition, ToolContext, ToolResult } from "@saber/tools";
import { executeBatch } from "@saber/tools";
import { SessionLog } from "./session.ts";

const MAX_STEPS = 64;

export type TurnOutcome =
  | { kind: "done" }
  | { kind: "doom_loop"; message: string }
  | { kind: "length_refusal" }
  | { kind: "max_steps" }
  | { kind: "provider_failure"; message: string };

export interface TurnInput {
  userMessage: string;
  system?: string;
}

export interface EngineOptions {
  provider: Provider;
  tools: ToolDefinition[];
  session: SessionLog;
  toolContext: ToolContext;
  model: string;
  onEvent?: (event: EngineEvent) => void;
}

export type EngineEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "step_started"; turnId: string; stepId: string }
  | { type: "assistant_delta"; turnId: string; stepId: string; delta: string }
  | { type: "tool_started"; turnId: string; stepId: string; callId: string; name: string }
  | { type: "tool_completed"; callId: string; isError: boolean; errorDetail?: string }
  | { type: "step_finished"; turnId: string; stepId: string; usage: Usage }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "turn_complete"; turnId: string; reason: string };

export class Engine {
  private history: Message[] = [];
  private usageTotal: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
  private steering: string[] = [];

  constructor(private opts: EngineOptions) {}

  steer(message: string): void { this.steering.push(message); }

  getUsage(): Usage { return { ...this.usageTotal }; }

  async runTurn(input: TurnInput): Promise<{ answer: string; outcome: TurnOutcome }> {
    const turnId = `t-${this.opts.session.nextSeq()}`;
    this.emit({ type: "turn_started", turnId });

    // Log user message
    this.opts.session.append("user_message", {
      message: { role: "user", blocks: [{ type: "text", text: input.userMessage }] },
    });
    this.history.push({ role: "user", blocks: [{ type: "text", text: input.userMessage }] });

    let lastText = "";
    let outcome: TurnOutcome = { kind: "done" };
    let doomTracker: { name: string; args: string; count: number } | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      const stepId = `${turnId}-s${step}`;
      this.emit({ type: "step_started", turnId, stepId });

      // Drain steering
      while (this.steering.length > 0) {
        const msg = this.steering.shift()!;
        this.opts.session.append("user_message", {
          message: { role: "user", blocks: [{ type: "text", text: msg }] },
        });
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

      // Collect events from the stream
      let text = "";
      let thinking = "";
      const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
      const activeCalls = new Map<string, { name: string; args: string }>();
      const callOrder: string[] = [];
      let stepUsage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
      let finishReason = "stop";
      let providerError: string | null = null;

      for await (const event of streamWithRetry(this.opts.provider, request)) {
        switch (event.type) {
          case "text_delta":
            text += event.text_delta;
            this.emit({ type: "assistant_delta", turnId, stepId, delta: event.text_delta });
            break;
          case "thinking_delta":
            thinking += event.text_delta;
            break;
          case "tool_call_start":
            if (!activeCalls.has(event.id)) callOrder.push(event.id);
            activeCalls.set(event.id, { name: event.name, args: "" });
            break;
          case "tool_call_delta":
            const call = activeCalls.get(event.id);
            if (call) call.args += event.arguments_delta;
            break;
          case "finish":
            finishReason = event.reason;
            stepUsage = event.usage;
            break;
          case "error":
            providerError = event.message;
            break;
        }
        if (providerError) break;
      }

      if (providerError) {
        this.emit({ type: "error", message: providerError, recoverable: false });
        this.emit({ type: "turn_complete", turnId, reason: "aborted" });
        return { answer: text, outcome: { kind: "provider_failure", message: providerError } };
      }

      // Parse tool calls (reject malformed)
      for (const id of callOrder) {
        const call = activeCalls.get(id);
        if (call) {
          try {
            toolCalls.push({ id, name: call.name, arguments: JSON.parse(call.args) });
          } catch (e) {
            this.emit({
              type: "error",
              message: `tool \`${call.name}\` produced malformed JSON: ${e}; refusing to execute`,
              recoverable: true,
            });
          }
        }
      }

      this.usageTotal.input_tokens += stepUsage.input_tokens;
      this.usageTotal.output_tokens += stepUsage.output_tokens;
      this.usageTotal.cost_usd += stepUsage.cost_usd;
      this.emit({ type: "step_finished", turnId, stepId, usage: stepUsage });

      // Log assistant message
      const blocks: Block[] = [];
      if (thinking) blocks.push({ type: "thinking", text: thinking });
      if (text) blocks.push({ type: "text", text });
      for (const tc of toolCalls) blocks.push({ type: "tool_call", ...tc });
      if (blocks.length > 0) {
        this.opts.session.append("assistant_message", { message: { role: "assistant", blocks }, usage: stepUsage });
        this.history.push({ role: "assistant", blocks });
      }

      if (toolCalls.length === 0) {
        lastText = text;
        outcome = { kind: "done" };
        break;
      }

      // Defense 1: length truncation refuses execution
      if (finishReason === "length") {
        this.emit({ type: "error", message: "response truncated; refusing tool calls", recoverable: true });
        this.emit({ type: "turn_complete", turnId, reason: "aborted" });
        return { answer: text, outcome: { kind: "length_refusal" } };
      }

      lastText = text;

      // Defense 2: doom-loop
      const firstCall = toolCalls[0];
      const currentArgsJson = JSON.stringify(firstCall.arguments);
      const doomed = doomTracker
        && doomTracker.name === firstCall.name
        && doomTracker.args === currentArgsJson
        ? doomTracker.count + 1 : 1;
      doomTracker = { name: firstCall.name, args: currentArgsJson, count: doomed };
      if (doomed >= 3) {
        const message = `tool \`${firstCall.name}\` called identically 3 times (doom-loop); aborted`;
        this.emit({ type: "error", message, recoverable: false });
        this.emit({ type: "turn_complete", turnId, reason: "aborted" });
        return { answer: lastText, outcome: { kind: "doom_loop", message } };
      }

      // Defense 3: WAL + batch execution
      const results = await this.executeTools(turnId, stepId, toolCalls);

      // Push tool results into history
      const resultBlocks: Block[] = results.map(([callId, result]) => ({
        type: "tool_result" as const,
        call_id: callId,
        content: result.content,
        is_error: result.isError,
      }));
      if (resultBlocks.length > 0) {
        this.opts.session.append("user_message", { message: { role: "user", blocks: resultBlocks } });
        this.history.push({ role: "user", blocks: resultBlocks });
      }

      if (step + 1 === MAX_STEPS) outcome = { kind: "max_steps" };
    }

    this.emit({ type: "turn_complete", turnId, reason: outcome.kind === "done" ? "done" : "aborted" });
    return { answer: lastText, outcome };
  }

  private async executeTools(
    turnId: string,
    stepId: string,
    calls: Array<{ id: string; name: string; arguments: unknown }>,
  ): Promise<Array<[string, ToolResult]>> {
    // Phase 1: WAL intents
    const executable: Array<{ id: string; name: string; arguments: unknown }> = [];
    const earlyResults: Array<[string, ToolResult]> = [];
    for (const call of calls) {
      try {
        this.opts.session.append("tool_call", call, true);
        this.emit({ type: "tool_started", turnId, stepId, callId: call.id, name: call.name });
        executable.push(call);
      } catch (e) {
        earlyResults.push([call.id, { content: `WAL write failed: ${e}`, isError: true }]);
      }
    }

    // Phase 2: batch execution
    const batchResults = await executeBatch(
      this.opts.tools,
      this.opts.toolContext,
      executable.map((c) => ({ name: c.name, args: c.arguments as Record<string, unknown> })),
    );

    // Phase 3: results
    const results: Array<[string, ToolResult]> = [...earlyResults];
    for (let i = 0; i < executable.length; i++) {
      const result = batchResults[i];
      this.opts.session.append("tool_result", {
        call_id: executable[i].id, content: result.content, is_error: result.isError,
      });
      this.emit({
        type: "tool_completed",
        callId: executable[i].id,
        isError: result.isError,
        errorDetail: result.isError ? result.content.slice(0, 500) : undefined,
      });
      results.push([executable[i].id, result]);
    }
    return results;
  }

  private emit(event: EngineEvent): void {
    this.opts.onEvent?.(event);
  }
}

import type { Provider, ChatRequest, ProviderEvent, Usage, Message, Block } from "@saber/ai";
import { streamWithRetry } from "@saber/ai";
import type { ToolDefinition, ToolContext, ToolResult } from "./types.js";
import type { SessionLog } from "./session.js";
import type { SaberPayload, SaberEvent } from "./events.js";

export type TurnOutcome =
  | { kind: "done" }
  | { kind: "busy"; message: string }
  | { kind: "aborted" }
  | { kind: "doom_loop"; message: string }
  | { kind: "length_refusal" }
  | { kind: "max_steps" }
  | { kind: "provider_failure"; message: string };

export interface TurnInput {
  userMessage: string;
  system?: string;
  /** Abort handle: checked at step boundaries and passed through to the
   *  provider fetch and the bash tool (process-group kill). */
  signal?: AbortSignal;
}

export type { SaberEvent };

const MAX_STEPS = 64;

/** Rough context estimate: ~4 chars per token across message text. */
function estimateTokens(history: Message[]): number {
  let chars = 0;
  for (const message of history) {
    for (const block of message.blocks) {
      if (block.type === "text" || block.type === "thinking") chars += block.text.length;
      else if (block.type === "tool_result") chars += block.content.length;
      else if (block.type === "tool_call") chars += JSON.stringify(block.arguments).length + block.name.length;
    }
  }
  return Math.ceil(chars / 4);
}

const COMPACT_SYSTEM =
  "You compress coding-agent conversation history. Produce a dense summary that preserves: " +
  "the user's goals and constraints, decisions made, files touched (with paths), tool findings " +
  "worth remembering, verification results, and the current task state / next steps. " +
  "Output only the summary.";

export interface EngineOptions {
  provider: Provider;
  tools: ToolDefinition[];
  session: SessionLog;
  toolContext: ToolContext;
  model: string;
  onEvent?: (event: SaberEvent) => void;
  /** Auto-compaction: when the estimated history exceeds thresholdTokens
   *  (chars/4 heuristic), a summarization call replaces old history at the
   *  turn boundary. Omit to disable. */
  compact?: { thresholdTokens: number };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Engine {
  private history: Message[] = [];
  private usageTotal: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
  private steering: string[] = [];
  private running = false;

  constructor(private opts: EngineOptions) {}

  /** Queues a user message for the current/next turn (steering). */
  steer(msg: string): void {
    this.steering.push(msg);
  }

  getUsage(): Usage {
    return { ...this.usageTotal };
  }

  async runTurn(input: TurnInput): Promise<{ answer: string; outcome: TurnOutcome }> {
    if (this.running) {
      const message = "a turn is already running on this engine; steer or wait";
      this.dispatch({ type: "error", message });
      return { answer: "", outcome: { kind: "busy", message } };
    }
    this.running = true;
    try {
      return await this.loop(input);
    } finally {
      this.running = false;
    }
  }

  private async loop(input: TurnInput): Promise<{ answer: string; outcome: TurnOutcome }> {
    const signal = input.signal;
    this.opts.toolContext.signal = signal;
    const turnId = `t-${this.opts.session.nextSeq()}`;
    this.dispatch({ type: "turn_started", turnId });

    this.dispatch({ type: "user_message", message: { role: "user", blocks: [{ type: "text", text: input.userMessage }] } });
    this.history.push({ role: "user", blocks: [{ type: "text", text: input.userMessage }] });

    let lastText = "";
    let outcome: TurnOutcome = { kind: "done" };
    let doomTracker: { name: string; argsJson: string; count: number } | null = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) { outcome = { kind: "aborted" }; break; }

      const stepId = `${turnId}-s${step}`;
      this.dispatch({ type: "step_started", turnId, stepId });

      while (this.steering.length > 0) {
        const msg = this.steering.shift()!;
        const blocks: Block[] = [{ type: "text", text: msg }];
        this.dispatch({ type: "user_message", message: { role: "user", blocks } });
        this.history.push({ role: "user", blocks });
      }

      const request: ChatRequest = {
        model: this.opts.model,
        system: input.system,
        messages: this.history,
        tools: this.opts.tools.map((t) => ({
          name: t.name, description: t.description, parameters: t.parameters,
        })),
        signal,
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
              this.dispatch({ type: "assistant_delta", turnId, stepId, text: event.text_delta });
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
        providerError = `unhandled: ${e instanceof Error ? e.message : String(e)}`;
      }

      if (signal?.aborted) { outcome = { kind: "aborted" }; break; }

      if (providerError) {
        this.dispatch({ type: "error", message: providerError });
        outcome = { kind: "provider_failure", message: providerError };
        break;
      }

      for (const id of callOrder) {
        const call = activeCalls.get(id);
        if (call) {
          try {
            toolCalls.push({ id, name: call.name, arguments: JSON.parse(call.args) });
          } catch {
            this.dispatch({ type: "error", message: `malformed args for ${call.name}; rejected` });
          }
        }
      }

      this.usageTotal.input_tokens += stepUsage.input_tokens;
      this.usageTotal.output_tokens += stepUsage.output_tokens;
      this.usageTotal.cost_usd += stepUsage.cost_usd;
      this.dispatch({ type: "step_finished", turnId, stepId, usage: stepUsage });

      const blocks: Block[] = [];
      if (thinking) blocks.push({ type: "thinking", text: thinking });
      if (text) blocks.push({ type: "text", text });
      for (const tc of toolCalls) blocks.push({ type: "tool_call", ...tc });
      if (blocks.length > 0) {
        this.dispatch({ type: "assistant_message", message: { role: "assistant", blocks }, usage: stepUsage });
        this.history.push({ role: "assistant", blocks });
      }

      if (toolCalls.length === 0) { lastText = text; outcome = { kind: "done" }; break; }

      if (finishReason === "length") {
        this.dispatch({ type: "error", message: "truncated; refusing tool calls" });
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
        this.dispatch({ type: "error", message });
        outcome = { kind: "doom_loop", message };
        break;
      }

      const results = await this.executeTools(turnId, stepId, toolCalls, signal);
      const resultBlocks: Block[] = results.map(([callId, name, result]) => ({
        type: "tool_result" as const, call_id: callId, content: result.content, is_error: result.isError,
      }));
      if (resultBlocks.length > 0) {
        this.history.push({ role: "user", blocks: resultBlocks });
      }

      if (step + 1 === MAX_STEPS) outcome = { kind: "max_steps" };
    }

    this.dispatch({ type: "turn_complete", turnId, reason: outcome.kind });
    await this.maybeCompact();
    return { answer: lastText, outcome };
  }

  /**
   * Turn-boundary auto-compaction: summarize history through the provider
   * and replace it with the summary plus the latest exchange. Failure keeps
   * the original history (compaction must never lose a session).
   */
  private async maybeCompact(): Promise<void> {
    const threshold = this.opts.compact?.thresholdTokens;
    if (threshold === undefined) return;
    if (estimateTokens(this.history) <= threshold) return;

    const dropped = this.history.length;
    try {
      const summary = await this.summarize();
      // keep the latest exchange when it fits; shrink to the last user
      // message, then to the summary alone, until back under threshold
      const seed: Message = {
        role: "user",
        blocks: [{
          type: "text",
          text: `[context resumed after compaction]\nEarlier conversation summary:\n${summary}\n\nLatest exchange follows.`,
        }],
      };
      // (slice(-0) is the WHOLE array — hence explicit candidate list)
      const candidates: Message[][] = [
        this.history.slice(-2),
        this.history.filter((m) => m.role === "user").slice(-1),
        [],
      ];
      let kept: Message[] = [];
      for (const candidate of candidates) {
        if (estimateTokens([seed, ...candidate]) <= threshold * 2) {
          kept = candidate;
          break;
        }
      }
      this.history = [seed, ...kept];
      this.dispatch({ type: "context_compacted", summary, droppedEvents: dropped });
    } catch (e) {
      this.dispatch({ type: "error", message: `compaction failed (history kept): ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private async summarize(): Promise<string> {
    const transcript = this.history
      .map((message) => message.blocks.map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_call") return `[tool_call ${b.name} ${JSON.stringify(b.arguments)}]`;
        if (b.type === "tool_result") return `[tool_result ${b.content}]`;
        return "";
      }).join("\n"))
      .join("\n---\n");

    let summary = "";
    for await (const event of streamWithRetry(this.opts.provider, {
      model: this.opts.model,
      system: COMPACT_SYSTEM,
      messages: [{ role: "user", blocks: [{ type: "text", text: transcript }] }],
      tools: [],
    })) {
      if (event.type === "text_delta") summary += event.text_delta;
      if (event.type === "error") throw new Error(event.message);
    }
    if (!summary.trim()) throw new Error("compaction summary was empty");
    return summary;
  }

  /** WAL discipline: durable tool_call intent (fsync) before any side effect. */
  private async executeTools(
    turnId: string, stepId: string,
    calls: Array<{ id: string; name: string; arguments: unknown }>,
    signal?: AbortSignal,
  ): Promise<Array<[string, string, ToolResult]>> {
    const executable: typeof calls = [];
    const results: Array<[string, string, ToolResult]> = [];
    for (const call of calls) {
      this.dispatch({ type: "tool_call", callId: call.id, name: call.name, args: call.arguments }, { sync: true });
      this.dispatch({ type: "tool_started", turnId, stepId, callId: call.id, name: call.name });
      executable.push(call);
    }
    const batchResults = await this.executeBatch(executable, signal);
    for (let i = 0; i < executable.length; i++) {
      const result = batchResults[i];
      this.dispatch({ type: "tool_result", callId: executable[i].id, name: executable[i].name, content: result.content, isError: result.isError });
      this.dispatch({ type: "tool_completed", callId: executable[i].id, isError: result.isError });
      results.push([executable[i].id, executable[i].name, result]);
    }
    return results;
  }

  private async executeBatch(calls: Array<{ name: string; arguments: unknown }>, signal?: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length);
    const inFlight: Array<Promise<void>> = [];
    const exclusive: Array<() => Promise<void>> = [];
    calls.forEach((call, index) => {
      const tool = this.opts.tools.find((t) => t.name === call.name) ?? null;
      if (!tool) {
        results[index] = { content: `unknown tool: ${call.name}`, isError: true };
        return;
      }
      const run = async (): Promise<void> => {
        // No new side-effecting tool may start after abort; the skipped call
        // still gets a synthetic result so WAL intent/result stay paired.
        if (tool.concurrency !== "read_only" && signal?.aborted) {
          results[index] = { content: "aborted before execution", isError: true };
          return;
        }
        results[index] = await tool.execute(isRecord(call.arguments) ? call.arguments : {}, this.opts.toolContext);
      };
      if (tool.concurrency === "read_only") inFlight.push(run());
      else exclusive.push(run);
    });
    await Promise.all(inFlight);
    for (const run of exclusive) await run();
    return results;
  }

  /** Single pipeline: seq assignment + persistence + observer fan-out. */
  private dispatch(payload: SaberPayload, opts?: { sync?: boolean }): SaberEvent {
    const event = this.opts.session.record(payload, opts);
    this.opts.onEvent?.(event);
    return event;
  }
}

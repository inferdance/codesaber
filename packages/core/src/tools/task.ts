import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Provider } from "@saber/ai";
import { Engine, type TurnOutcome } from "../engine.js";
import { SessionLog } from "../session.js";
import { createPathPolicy } from "../policy.js";
import type { ToolContext } from "../types.js";
import { createTools } from "./index.js";

const TASK_SYSTEM =
  "You are a saber subagent executing one focused, self-contained task. " +
  "Do the work with the tools available, verify when cheap, and return only " +
  "the final answer — no preamble, no questions.";

const TASK_TIMEOUT_MS = 300_000;

export interface TaskResult {
  answer: string;
  outcome: TurnOutcome["kind"];
}

export interface TaskRunOptions {
  /** Parent turn's abort signal — aborting the parent cancels the child. */
  signal?: AbortSignal;
}

export type TaskRunner = (prompt: string, options?: TaskRunOptions) => Promise<TaskResult>;

export interface TaskRunnerOptions {
  provider: Provider;
  model: string;
  cwd: string;
  dataDir: string;
}

/**
 * Runs a prompt as a child agent: fresh context, its own WAL session log
 * (auditable under the sessions dir), the same toolset minus `task` itself —
 * subagents are depth-1 by construction, not by policy strings. The child
 * aborts with the parent turn's signal OR its own 300s cap, whichever first.
 */
export function createTaskRunner(opts: TaskRunnerOptions): TaskRunner {
  return async (prompt: string, runOptions?: TaskRunOptions): Promise<TaskResult> => {
    const sessionId = `task-${randomUUID().slice(0, 8)}`;
    const sessionsDir = path.join(opts.dataDir, "sessions");
    const session = SessionLog.create(sessionsDir, sessionId, {
      kind: "task", cwd: opts.cwd, model: opts.model,
    });
    const ctx: ToolContext = {
      sessionId,
      cwd: opts.cwd,
      dataDir: opts.dataDir,
      policy: createPathPolicy(opts.cwd, opts.dataDir),
      readFiles: new Map(),
    };
    const engine = new Engine({
      provider: opts.provider,
      tools: createTools(ctx), // no runTask → children cannot spawn children
      session,
      toolContext: ctx,
      model: opts.model,
    });
    const sources = [AbortSignal.timeout(TASK_TIMEOUT_MS)];
    if (runOptions?.signal) sources.push(runOptions.signal);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    for (const source of sources) {
      if (source.aborted) controller.abort();
      else source.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const { answer, outcome } = await engine.runTurn({
        userMessage: prompt,
        system: TASK_SYSTEM,
        signal: controller.signal,
      });
      return { answer, outcome: outcome.kind };
    } finally {
      for (const source of sources) source.removeEventListener("abort", onAbort);
      session.close();
    }
  };
}

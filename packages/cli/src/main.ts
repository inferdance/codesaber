#!/usr/bin/env node
import { createOpenAiProvider, createAnthropicProvider } from "@saber/ai";
import { Engine, SessionLog, createPathPolicy, createTools, type ToolContext } from "@saber/core";
import * as path from "node:path";
import * as fs from "node:fs";

const args = process.argv.slice(2);
const command = args[0];

// When a downstream pipe closes early (e.g. `saber ... | head`), abort the
// active turn instead of exiting on the spot, so cleanup (session close,
// turn_complete, child-process teardown) still runs; exit code follows.
const pipeClosed = { abort: null as null | (() => void) };
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
  process.exitCode ??= 0;
  pipeClosed.abort?.();
});

function getDataDir(): string {
  const dir = process.env.SABER_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".codesaber");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getApiKey(): { key: string; isAnthropic: boolean } | null {
  const anthropic = process.env.SABER_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (anthropic) return { key: anthropic, isAnthropic: true };
  const openai = process.env.SABER_OPENAI_KEY ?? process.env.OPENAI_API_KEY;
  if (openai) return { key: openai, isAnthropic: false };
  return null;
}

async function runExec(args: string[]): Promise<void> {
  let prompt = "";
  let jsonMode = false;
  let model: string | undefined;
  let timeoutSec: number | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--prompt") prompt = args[++i] ?? "";
    else if (args[i] === "--json") jsonMode = true;
    else if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--timeout") timeoutSec = Number(args[++i]);
  }

  if (!prompt) { console.error("error: -p <prompt> required"); process.exit(2); }
  if (timeoutSec !== undefined && (!Number.isInteger(timeoutSec) || timeoutSec < 1)) {
    console.error("error: --timeout must be a positive integer (seconds)"); process.exit(2);
  }

  const auth = getApiKey();
  if (!auth) { console.error("error: set ANTHROPIC_API_KEY or OPENAI_API_KEY"); process.exit(1); }

  // Optional endpoint override for OpenAI/Anthropic-compatible providers
  // (e.g. GLM's anthropic-compatible API, DeepSeek's openai-compatible API).
  const baseUrl = process.env.SABER_BASE_URL;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    console.error("error: SABER_BASE_URL must be an http(s) URL"); process.exit(2);
  }

  const cwd = process.cwd();
  const dataDir = getDataDir();
  const sessionId = `exec-${Date.now()}`;

  const provider = auth.isAnthropic
    ? createAnthropicProvider({ baseUrl: baseUrl ?? "https://api.anthropic.com", apiKey: auth.key, defaultModel: model ?? "claude-sonnet-4-5-20250929" })
    : createOpenAiProvider({ name: "openai", baseUrl: baseUrl ?? "https://api.openai.com/v1", apiKey: auth.key, defaultModel: model ?? "gpt-4o" });

  const session = SessionLog.create(path.join(dataDir, "sessions"), sessionId, {
    protocol_version: "0.2.0", engine_version: "0.1.0", cwd, model,
  });

  const toolContext: ToolContext = {
    sessionId, cwd, dataDir,
    policy: createPathPolicy(cwd, dataDir),
    readFiles: new Map(),
  };

  const tools = createTools(toolContext);

  const controller = new AbortController();
  const timer = timeoutSec !== undefined ? setTimeout(() => controller.abort(), timeoutSec * 1000) : undefined;
  pipeClosed.abort = () => controller.abort();

  const engine = new Engine({
    provider, tools, session, toolContext,
    model: model ?? (auth.isAnthropic ? "claude-sonnet-4-5-20250929" : "gpt-4o"),
    onEvent: jsonMode ? (e) => console.log(JSON.stringify(e)) : undefined,
  });

  const system = `You are saber, a coding agent. Be direct and surgical.

# Environment
- cwd: ${cwd}
- platform: ${process.platform}

# Rules
- Read a file before editing it; use edit (not sed) for code changes.
- Prefer grep/glob to locate code over listing directories with bash.
- After changing code, verify with tests or a build via bash.
- Cite locations as path:line in your final answer.`;

  let exitCode = 1;
  try {
    const { answer, outcome } = await engine.runTurn({ userMessage: prompt, system, signal: controller.signal });
    if (!jsonMode && answer) console.log(answer);
    if (outcome.kind === "done") exitCode = 0;
    else if (outcome.kind === "aborted") exitCode = 124;
    else exitCode = 1;
  } finally {
    pipeClosed.abort = null;
    if (timer) clearTimeout(timer);
    session.close();
    const usage = engine.getUsage();
    const priced = usage.cost_usd > 0 ? `$${usage.cost_usd.toFixed(4)}` : "unknown (unpriced model)";
    console.error(`[tokens: in=${usage.input_tokens} out=${usage.output_tokens} cost=${priced}]`);
  }
  process.exit(exitCode);
}

async function runDoctor(): Promise<void> {
  console.log("saber doctor\n");
  console.log("Configuration:");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SABER_ANTHROPIC_KEY", "SABER_OPENAI_KEY"]) {
    console.log(`  ${key}: ${process.env[key] ? "✓" : "  not set"}`);
  }
  console.log(`\nEnvironment:\n  cwd: ${process.cwd()}\n  platform: ${process.platform}\n  data: ${getDataDir()}${process.env.SABER_BASE_URL ? `\n  base URL override: ${process.env.SABER_BASE_URL}` : ""}`);
}

function help(): void {
  console.log(`saber — coding agent

USAGE:
  saber exec -p <prompt> [--json] [--model <model>] [--timeout <seconds>]
  saber doctor
  saber --version

EXIT CODES:
  0 success · 1 failure · 2 usage error · 124 timed out`);
}

switch (command) {
  case "exec": runExec(args).catch((e) => { console.error(e); process.exit(1); }); break;
  case "doctor": runDoctor(); break;
  case "--version": console.log("saber 0.1.0"); break;
  default: help(); break;
}

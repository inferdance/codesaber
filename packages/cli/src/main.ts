#!/usr/bin/env node
import { createOpenAiProvider, createAnthropicProvider } from "@saber/ai";
import { Engine, SessionLog, createPathPolicy, createTools, type ToolContext } from "@saber/core";
import * as path from "node:path";
import * as fs from "node:fs";

const args = process.argv.slice(2);
const command = args[0];

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

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--prompt") prompt = args[++i] ?? "";
    else if (args[i] === "--json") jsonMode = true;
    else if (args[i] === "--model") model = args[++i];
  }

  if (!prompt) { console.error("error: -p <prompt> required"); process.exit(2); }

  const auth = getApiKey();
  if (!auth) { console.error("error: set ANTHROPIC_API_KEY or OPENAI_API_KEY"); process.exit(1); }

  const cwd = process.cwd();
  const dataDir = getDataDir();
  const sessionId = `exec-${Date.now()}`;

  const provider = auth.isAnthropic
    ? createAnthropicProvider({ baseUrl: "https://api.anthropic.com", apiKey: auth.key, defaultModel: model ?? "claude-sonnet-4-5-20250929" })
    : createOpenAiProvider({ name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: auth.key, defaultModel: model ?? "gpt-4o" });

  const session = new SessionLog(path.join(dataDir, "sessions"), sessionId, {
    protocol_version: "0.1.0", engine_version: "0.1.0", cwd, model,
  });

  const toolContext: ToolContext = {
    sessionId, cwd, dataDir,
    policy: createPathPolicy(cwd, dataDir),
    readFiles: new Set(),
  };

  const tools = createTools(toolContext);

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

  const { answer, outcome } = await engine.runTurn({ userMessage: prompt, system });
  if (!jsonMode) console.log(answer);
  const usage = engine.getUsage();
  console.error(`[tokens: in=${usage.input_tokens} out=${usage.output_tokens} cost=$${usage.cost_usd.toFixed(4)}]`);
  process.exit(outcome.kind === "done" ? 0 : 1);
}

async function runDoctor(): Promise<void> {
  console.log("saber doctor\n");
  console.log("Configuration:");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SABER_ANTHROPIC_KEY", "SABER_OPENAI_KEY"]) {
    console.log(`  ${key}: ${process.env[key] ? "✓" : "  not set"}`);
  }
  console.log(`\nEnvironment:\n  cwd: ${process.cwd()}\n  platform: ${process.platform}\n  data: ${getDataDir()}`);
}

function help(): void {
  console.log(`saber — coding agent

USAGE:
  saber exec -p <prompt> [--json] [--model <model>]
  saber doctor
  saber --version`);
}

switch (command) {
  case "exec": runExec(args).catch((e) => { console.error(e); process.exit(1); }); break;
  case "doctor": runDoctor(); break;
  case "--version": console.log("saber 0.1.0"); break;
  default: help(); break;
}

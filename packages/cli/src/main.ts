#!/usr/bin/env node
/**
 * saber CLI — headless exec + server launcher.
 *
 * Usage:
 *   saber exec -p "prompt" [--json] [--model M]
 *   saber server [--port 3080]
 *   saber doctor
 */
import { createAnthropicProvider, createOpenAiProvider } from "@saber/ai";
import { Engine, SessionLog, type EngineEvent } from "@saber/agent";
import { createBuiltinTools, createToolContext, createSeatbeltExecutor, createDirectExecutor } from "@saber/tools";
import * as path from "node:path";

const args = process.argv.slice(2);
const command = args[0];

function getEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function getDataDir(): string {
  const dir = process.env.SABER_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".codesaber");
  require("node:fs").mkdirSync(dir, { recursive: true });
  return dir;
}

async function runExec(args: string[]): Promise<void> {
  let prompt = "";
  let jsonMode = false;
  let model: string | undefined;
  let timeoutSec = 600;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--prompt") prompt = args[++i] ?? "";
    else if (args[i] === "--json") jsonMode = true;
    else if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--timeout") timeoutSec = parseInt(args[++i] ?? "600", 10);
  }

  if (!prompt) { console.error("error: -p <prompt> required"); process.exit(2); }

  const cwd = process.cwd();
  const dataDir = getDataDir();
  const sessionId = `exec-${Date.now()}`;

  const apiKey = getEnv("SABER_ANTHROPIC_KEY", "ANTHROPIC_API_KEY")
    ?? getEnv("SABER_OPENAI_KEY", "OPENAI_API_KEY");
  if (!apiKey) {
    console.error("error: set ANTHROPIC_API_KEY or OPENAI_API_KEY");
    process.exit(1);
  }

  const isAnthropic = !!getEnv("SABER_ANTHROPIC_KEY", "ANTHROPIC_API_KEY");
  const provider = isAnthropic
    ? createAnthropicProvider({
        baseUrl: "https://api.anthropic.com",
        apiKey,
        defaultModel: model ?? "claude-sonnet-4-5-20250929",
      })
    : createOpenAiProvider({
        name: "openai",
        baseUrl: getEnv("SABER_OPENAI_BASE_URL", "OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
        apiKey,
        defaultModel: model ?? "gpt-4o",
      });

  const session = new SessionLog(path.join(dataDir, "sessions"), sessionId, {
    protocol_version: "0.1.0", engine_version: "0.1.0", cwd, model,
  });

  const executor = process.platform === "darwin"
    ? createSeatbeltExecutor() : createDirectExecutor();
  const toolContext = createToolContext(sessionId, cwd, dataDir, executor);

  const engine = new Engine({
    provider,
    tools: createBuiltinTools(),
    session,
    toolContext,
    model: model ?? (isAnthropic ? "claude-sonnet-4-5-20250929" : "gpt-4o"),
    onEvent: jsonMode ? (e) => console.log(JSON.stringify(e)) : undefined,
  });

  const system = `You are saber, a coding agent. Be direct and precise. Read before editing. Run tests to verify.\n# Environment\n- Working directory: ${cwd}\n- Platform: ${process.platform}\n`;

  const timeout = setTimeout(() => {
    console.error(`turn timed out after ${timeoutSec}s`);
    process.exit(124);
  }, timeoutSec * 1000);

  const { answer, outcome } = await engine.runTurn({ userMessage: prompt, system });
  clearTimeout(timeout);

  if (!jsonMode) console.log(answer);
  const usage = engine.getUsage();
  console.error(`[tokens: in=${usage.input_tokens}, out=${usage.output_tokens}, cost=$${usage.cost_usd.toFixed(4)}]`);

  const exitCode = outcome.kind === "done" ? 0 : 1;
  if (exitCode !== 0) process.exit(exitCode);
}

async function runDoctor(): Promise<void> {
  console.log("saber doctor");
  console.log();
  console.log("Configuration:");
  for (const key of ["SABER_ANTHROPIC_KEY", "ANTHROPIC_API_KEY", "SABER_OPENAI_KEY", "OPENAI_API_KEY"]) {
    console.log(`  ${key}: ${process.env[key] ? "✓ set" : "  not set"}`);
  }
  console.log(`\nEnvironment:`);
  console.log(`  cwd: ${process.cwd()}`);
  console.log(`  platform: ${process.platform}`);
  console.log(`  data dir: ${getDataDir()}`);
  if (process.platform === "darwin") {
    console.log(`  sandbox-exec: ${require("node:fs").existsSync("/usr/bin/sandbox-exec") ? "✓ available" : "NOT FOUND"}`);
  }
}

function printHelp(): void {
  console.log(`saber — an AI coding agent

USAGE:
  saber exec -p <prompt> [--json] [--model <model>]
  saber server [--port <port>]
  saber doctor
  saber --version`);
}

switch (command) {
  case "exec":
    runExec(args).catch((e) => { console.error(e); process.exit(1); });
    break;
  case "server":
    import("@saber/server/dist/main.js").catch((e) => {
      console.error("Failed to start server. Build it first: pnpm --filter @saber/server build");
      console.error(e);
      process.exit(1);
    });
    break;
  case "doctor":
    runDoctor();
    break;
  case "--version": case "-V":
    console.log("saber 0.1.0");
    break;
  case "--help": case "-h": default:
    printHelp();
    break;
}

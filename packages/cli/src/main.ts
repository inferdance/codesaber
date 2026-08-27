#!/usr/bin/env node
import { Engine, SessionLog, createPathPolicy, createTools, type ToolContext } from "@saber/core";
import { buildProvider, getApiKey, getDataDir, systemPrompt, validatedBaseUrl, type Auth } from "./runtime.js";
import * as path from "node:path";

const args = process.argv.slice(2);
const command = args[0];

// When a downstream pipe closes early (e.g. `saber ... | head`), abort the
// active turn instead of exiting on the spot, so cleanup (session close,
// turn_complete, child-process teardown) still runs. EPIPE-triggered aborts
// exit 0 (the consumer closed the pipe); real timeouts exit 124.
const pipeClosed = { abort: null as null | (() => void), epipe: false };
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
  process.exitCode ??= 0;
  pipeClosed.epipe = true;
  pipeClosed.abort?.();
});

function requireAuth(): Auth {
  const auth = getApiKey();
  if (!auth) { console.error("error: set ANTHROPIC_API_KEY or OPENAI_API_KEY"); process.exit(1); }
  return auth;
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

  const auth = requireAuth();
  const baseUrl = validatedBaseUrl();
  const { provider, defaultModel } = buildProvider(auth, baseUrl);
  const resolvedModel = model ?? defaultModel;

  const cwd = process.cwd();
  const dataDir = getDataDir();
  const sessionId = `exec-${Date.now()}`;

  const session = SessionLog.create(path.join(dataDir, "sessions"), sessionId, {
    protocol_version: "0.2.0", engine_version: "0.1.0", cwd, model: resolvedModel,
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
    model: resolvedModel,
    onEvent: jsonMode ? (e) => console.log(JSON.stringify(e)) : undefined,
  });

  let exitCode = 1;
  try {
    const { answer, outcome } = await engine.runTurn({ userMessage: prompt, system: systemPrompt(cwd), signal: controller.signal });
    if (!jsonMode && answer) console.log(answer);
    if (outcome.kind === "done") exitCode = 0;
    else if (outcome.kind === "aborted") exitCode = pipeClosed.epipe ? 0 : 124;
    else exitCode = 1;
  } finally {
    pipeClosed.abort = null;
    pipeClosed.epipe = false;
    if (timer) clearTimeout(timer);
    session.close();
    const usage = engine.getUsage();
    const priced = usage.cost_usd > 0 ? `$${usage.cost_usd.toFixed(4)}` : "unknown (unpriced model)";
    console.error(`[tokens: in=${usage.input_tokens} out=${usage.output_tokens} cost=${priced}]`);
  }
  process.exit(exitCode);
}

async function runServer(args: string[]): Promise<void> {
  let port = 3080;
  let model: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--model") model = args[++i];
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("error: --port must be 1-65535"); process.exit(2);
  }

  const auth = requireAuth();
  const baseUrl = validatedBaseUrl();
  const { provider, defaultModel } = buildProvider(auth, baseUrl);
  const cwd = process.cwd();

  const { createSaberServer } = await import("@saber/server");
  const server = await createSaberServer({
    provider,
    model: model ?? defaultModel,
    cwd,
    dataDir: getDataDir(),
    system: systemPrompt(cwd),
    port,
    host: "127.0.0.1",
  });
  const address = await server.listen();
  console.log(`saber server`);
  console.log(`  http:   ${address}`);
  console.log(`  ws:     ${address}/ws`);
  console.log(`  cwd:    ${cwd}`);
  console.log(`  model:  ${model ?? defaultModel}`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
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
  saber server [--port <port>] [--model <model>]
  saber tui [--http <url>] [--session <id>]
  saber doctor
  saber --version

EXIT CODES (exec):
  0 success · 1 failure · 2 usage error · 124 timed out`);
}

switch (command) {
  case "exec": runExec(args).catch((e) => { console.error(e); process.exit(1); }); break;
  case "server": runServer(args).catch((e) => { console.error(e); process.exit(1); }); break;
  case "tui": {
    const { runTui } = await import("@saber/tui");
    runTui(args.slice(1));
    break;
  }
  case "doctor": runDoctor(); break;
  case "--version": console.log("saber 0.1.0"); break;
  default: help(); break;
}

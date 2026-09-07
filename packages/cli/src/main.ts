#!/usr/bin/env node
import { Engine, SessionLog, createPathPolicy, createTaskRunner, createTools, recoverSession, type ToolContext } from "@saber/core";
import { buildProvider, getApiKey, getDataDir, systemPrompt, validatedBaseUrl, type Auth } from "./runtime.js";
import * as path from "node:path";
import * as fs from "node:fs";

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

  const runTask = createTaskRunner({ provider, model: resolvedModel, cwd, dataDir });
  const tools = createTools(toolContext, { runTask });

  // reasoning models orchestrating subagents routinely need >300s; a turn
  // cut at the deadline after the work finished is the worst outcome
  const effectiveTimeout = timeoutSec ?? 600;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout * 1000);
  pipeClosed.abort = () => controller.abort();

  const compactTokens = Number(process.env.SABER_COMPACT_TOKENS ?? "100000");
  const engine = new Engine({
    provider, tools, session, toolContext,
    model: resolvedModel,
    onEvent: jsonMode ? (e) => console.log(JSON.stringify(e)) : undefined,
    ...(Number.isInteger(compactTokens) && compactTokens > 0 ? { compact: { thresholdTokens: compactTokens } } : {}),
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

async function runResume(args: string[]): Promise<void> {
  const sessionId = args[1];
  let prompt = "";
  let jsonMode = false;
  let model: string | undefined;
  let timeoutSec: number | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--prompt") prompt = args[++i] ?? "";
    else if (args[i] === "--json") jsonMode = true;
    else if (args[i] === "--model") model = args[++i];
    else if (args[i] === "--timeout") timeoutSec = Number(args[++i]);
  }
  if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionId)) {
    console.error("error: resume requires a session id (saber list to see them)");
    process.exit(2);
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
  const logFile = path.join(dataDir, "sessions", `${sessionId}.jsonl`);
  if (!fs.existsSync(logFile)) {
    console.error(`error: no such session: ${sessionId} (saber list)`);
    process.exit(1);
  }

  // single-writer guard: the server (or another saber process) may hold this
  // session — a second writer duplicates WAL seqs and splits the mailbox
  const lockFile = `${logFile}.lock`;
  const lockHeld = (): boolean => {
    try {
      const raw = fs.readFileSync(lockFile, "utf-8").trim();
      const pid = Number(raw.split(":")[0]);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return true; } catch { /* stale lock */ }
      }
    } catch { /* no lock */ }
    return false;
  };
  if (lockHeld()) {
    console.error(`error: session ${sessionId} is held by a live process (see ${lockFile}); stop it first or resume via the server`);
    process.exit(1);
  }
  fs.writeFileSync(lockFile, `${process.pid}:${Date.now()}`, { mode: 0o600 });

  let exitCode = 1;
  const session = SessionLog.open(path.join(dataDir, "sessions"), sessionId);
  try {
    const recovered = recoverSession(logFile);
    if (recovered.tornAt !== undefined) {
      console.error(`error: session is corrupt at record ${recovered.tornAt}`);
      process.exitCode = 1;
      return;
    }

    // WAL crash-window parity with the server: unfinished calls get persisted
    // "result unknown" results (fsync) BEFORE the fold — never re-executed
    {
      const pendingCalls: Array<{ callId: string; name: string }> = [];
      for (const event of recovered.events) {
        const payload = event.payload;
        if (payload.type === "tool_call") pendingCalls.push({ callId: payload.callId, name: payload.name });
        else if (payload.type === "tool_result") {
          const index = pendingCalls.findIndex((c) => c.callId === payload.callId);
          if (index >= 0) pendingCalls.splice(index, 1);
        }
      }
      for (const call of pendingCalls) {
        session.record({
          type: "tool_result",
          callId: call.callId,
          name: call.name,
          content: "result unknown: the session ended before this call produced a result (not re-executed)",
          isError: true,
        }, { sync: true });
      }
      if (pendingCalls.length > 0) recovered.events = recoverSession(logFile).events;
    }

    const toolContext: ToolContext = {
      sessionId, cwd, dataDir,
      policy: createPathPolicy(cwd, dataDir),
      readFiles: new Map(),
    };
    const runTask = createTaskRunner({ provider, model: resolvedModel, cwd, dataDir });
    const tools = createTools(toolContext, { runTask });

    const compactTokens = Number(process.env.SABER_COMPACT_TOKENS ?? "100000");
    const engine = new Engine({
      provider, tools, session, toolContext,
      model: resolvedModel,
      onEvent: jsonMode ? (e) => console.log(JSON.stringify(e)) : undefined,
      ...(Number.isInteger(compactTokens) && compactTokens > 0 ? { compact: { thresholdTokens: compactTokens } } : {}),
    });
    const restored = engine.restoreHistory(recovered.events.map((e) => e.payload));
    if (!restored.ok) {
      console.error(`error: ${restored.error}`);
      process.exitCode = 1;
      return;
    }

    const effectiveTimeout = timeoutSec ?? 600;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout * 1000);
    pipeClosed.abort = () => controller.abort();

    exitCode = 1;
    try {
      const { answer, outcome } = await engine.runTurn({ userMessage: prompt, system: systemPrompt(cwd), signal: controller.signal });
      if (!jsonMode && answer) console.log(answer);
      // EPIPE-aborted runs exit 0 like exec (the consumer closed the pipe)
      exitCode = outcome.kind === "done" ? 0 : outcome.kind === "aborted" ? (pipeClosed.epipe ? 0 : 124) : 1;
    } finally {
      pipeClosed.abort = null;
      pipeClosed.epipe = false;
      clearTimeout(timer);
      session.close();
      const usage = engine.getUsage();
      const priced = usage.cost_usd > 0 ? `$${usage.cost_usd.toFixed(4)}` : "unknown (unpriced model)";
      console.error(`[session ${sessionId} · tokens: in=${usage.input_tokens} out=${usage.output_tokens} cost=${priced}]`);
    }
    // NOTE: no process.exit here — it terminates immediately and would skip
    // the lock-releasing finally below
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch { /* best effort */ }
  }
  process.exit(exitCode);
}

function runList(): void {
  const sessionsDir = path.join(getDataDir(), "sessions");
  if (!fs.existsSync(sessionsDir)) { console.log("(no sessions)"); return; }
  const rows = fs.readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
    .sort((a, b) => fs.statSync(path.join(sessionsDir, `${b}.jsonl`)).mtimeMs - fs.statSync(path.join(sessionsDir, `${a}.jsonl`)).mtimeMs)
    .slice(0, 30)
    .map((id) => {
      try {
        const events = recoverSession(path.join(sessionsDir, `${id}.jsonl`)).events;
        let title = "";
        for (const e of events) {
          if (e.payload.type === "user_message") {
            title = e.payload.message.blocks.filter((b) => b.type === "text").map((b) => b.text).join("").slice(0, 60);
            break;
          }
        }
        return `${id}  ${title}`;
      } catch { return id; }
    });
  console.log(rows.length > 0 ? rows.join("\n") : "(no sessions)");
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
  saber exec -p <prompt> [--json] [--model <model>] [--timeout <seconds>, default 600]
  saber resume <session-id> -p <prompt> [--json] [--model <model>] [--timeout <seconds>]
  saber list                     # recent sessions
  saber server [--port <port>] [--model <model>]
  saber tui [--http <url>] [--session <id>]
  saber doctor
  saber --version

EXIT CODES (exec):
  0 success · 1 failure · 2 usage error · 124 timed out`);
}

switch (command) {
  case "exec": runExec(args).catch((e) => { console.error(e); process.exit(1); }); break;
  case "resume": runResume(args).catch((e) => { console.error(e); process.exit(1); }); break;
  case "list": runList(); break;
  case "server": runServer(args).catch((e) => { console.error(e); process.exit(1); }); break;
  case "tui": {
    const { runTui } = await import("@saber/tui");
    runTui(args.slice(1)).catch((e) => { console.error(e); process.exit(1); });
    break;
  }
  case "doctor": runDoctor(); break;
  case "--version": console.log("saber 0.1.0"); break;
  default: help(); break;
}

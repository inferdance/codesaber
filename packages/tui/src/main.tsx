import React from "react";
import { render } from "ink";
import * as path from "node:path";
import { App, type TuiExitKind } from "./App.js";

function wsUrlFromHttp(http: string): string {
  const parsed = new URL(http);
  const protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : null;
  if (!protocol) throw new Error(`--http must be an http(s) URL, got: ${http}`);
  return `${protocol}//${parsed.host}/ws`;
}

async function isAlive(httpOrigin: string): Promise<boolean> {
  try {
    const response = await fetch(`${httpOrigin}/api/health`, { signal: AbortSignal.timeout(700) });
    return response.ok;
  } catch { return false; }
}

export async function runTui(rawArgs: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = rawArgs.indexOf(`--${name}`);
    return index >= 0 ? rawArgs[index + 1] : undefined;
  };

  if (rawArgs.includes("--help")) {
    console.log(`saber tui — terminal frontend

USAGE:
  saber tui [--http <url>] [--url <ws url>] [--session <id>] [--port <port>] [--model <model>]

MODES:
  no server running → an embedded server boots in-process (zero ceremony)
  server already running at the target → connects to it (shared sessions)

DEFAULTS:
  http http://127.0.0.1:3080

KEYS:
  Enter send / steer · Tab session switcher · Ctrl+A abort running turn ·
  Esc detach (turn keeps running server-side) / close picker · Ctrl+C quit`);
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("saber tui needs an interactive terminal (TTY stdin and stdout)");
    process.exit(2);
  }

  const explicitHttp = flag("http");
  const modelFlag = flag("model");
  const portFlag = Number(flag("port"));
  const defaultPort = Number.isInteger(portFlag) && portFlag > 0 && portFlag < 65536 ? portFlag : 3080;
  let wsUrl: string;
  try {
    wsUrl = flag("url") ?? wsUrlFromHttp(explicitHttp ?? `http://127.0.0.1:${defaultPort}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
    return;
  }
  const sessionId = flag("session");
  // with only --url given, the REST session list must target the SAME server
  // as the socket — derive the http origin from the ws url
  const httpOrigin = (() => { const u = new URL(wsUrl); return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`; })();
  let httpUrl = explicitHttp ?? httpOrigin;

  // codex-style target resolution: connect to a live server when one is
  // there (shared sessions), otherwise boot an embedded in-process server
  // so `saber tui` is a single zero-ceremony command
  const explicitTarget = flag("url") !== undefined || explicitHttp !== undefined;
  let ownsServer = false;
  let closeOwnedServer: (() => Promise<void>) | null = null;
  if (!explicitTarget && !(await isAlive(httpUrl))) {
    const { createProviderFromEnv } = await import("@saber/ai");
    let fromEnv;
    try {
      fromEnv = createProviderFromEnv();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
      return;
    }
    if (!fromEnv) {
      console.error("error: set ANTHROPIC_API_KEY or OPENAI_API_KEY (or start `saber server` first)");
      process.exit(1);
    }
    const { provider, defaultModel } = fromEnv;
    const dataDir = process.env.SABER_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".codesaber");
    await import("node:fs").then((fs) => fs.mkdirSync(dataDir, { recursive: true }));
    const cwd = process.cwd();
    const { createSaberServer } = await import("@saber/server");
    const server = await createSaberServer({
      provider,
      model: modelFlag ?? process.env.SABER_MODEL ?? defaultModel,
      cwd,
      dataDir,
      system: `You are saber, a coding agent. Be direct and surgical.

# Environment
- cwd: ${cwd}
- platform: ${process.platform}

# Rules
- Read a file before editing it; use edit (not sed) for code changes.
- Prefer grep/glob to locate code over listing directories with bash.
- After changing code, verify with tests or a build via bash.
- Cite locations as path:line in your final answer.`,
      port: defaultPort,
      host: "127.0.0.1",
    });
    const address = await server.listen();
    httpUrl = address;
    wsUrl = `${address.replace("http", "ws")}/ws`;
    ownsServer = true;
    closeOwnedServer = () => server.close();
    // SIGTERM/SIGINT must run the ASYNC cleanup (abort turns, close logs) —
    // the default handler exits immediately and leaks detached tool processes
    const shutdown = (): void => {
      void server.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } else if (modelFlag) {
    // reusing a live server: surface a model mismatch instead of silently
    // running a different model than the command line asked for
    try {
      const health = await fetch(`${httpUrl}/api/health`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.json() as Promise<{ model?: string }>);
      const remoteModel = typeof health.model === "string" ? health.model : "";
      if (remoteModel && remoteModel !== modelFlag) {
        // remote-controlled string — sanitize before it reaches the terminal
        const { sanitizeTerminalText } = await import("./sanitize.js");
        console.error(`error: server at ${httpUrl} runs model ${sanitizeTerminalText(remoteModel)}, not ${modelFlag}; drop --model or target another server`);
        process.exit(1);
        return;
      }
    } catch { /* health unavailable — the WS connection surfaces errors */ }
  }

  let exitKind = "quit" as TuiExitKind;
  const instance = render(
    <App
      wsUrl={wsUrl}
      httpUrl={httpUrl}
      sessionId={sessionId}
      onExitKind={(kind) => { exitKind = kind; }}
    />,
  );
  await instance.waitUntilExit();
  if (ownsServer && closeOwnedServer) {
    // detach (Esc) with a LIVE turn keeps the embedded server for another
    // frontend to take over; WAL-derived isRunning can lie about crashed
    // sessions, so ask the server for sessions it actually holds
    if (exitKind === "detach") {
      try {
        const live = await fetch(`${httpUrl}/api/sessions/live`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.json() as Promise<{ count: number }>);
        if (live.count > 0) {
          console.error(`[saber] turn still running — embedded server stays at ${httpUrl}; reopen with saber tui or a browser to take over]`);
          return; // keep the process (and server) alive
        }
      } catch { /* endpoint miss (older server) or fetch failure — close */ }
    }
    await closeOwnedServer();
  }
}

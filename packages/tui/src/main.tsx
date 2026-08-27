import React from "react";
import { render } from "ink";
import { App } from "./App.js";

function wsUrlFromHttp(http: string): string {
  const parsed = new URL(http);
  const protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : null;
  if (!protocol) throw new Error(`--http must be an http(s) URL, got: ${http}`);
  return `${protocol}//${parsed.host}/ws`;
}

export async function runTui(rawArgs: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = rawArgs.indexOf(`--${name}`);
    return index >= 0 ? rawArgs[index + 1] : undefined;
  };

  if (rawArgs.includes("--help")) {
    console.log(`saber tui — terminal frontend (talks to a running saber server)

USAGE:
  saber tui [--http <url>] [--url <ws url>] [--session <id>]

DEFAULTS:
  http http://127.0.0.1:3080 (ws derived as <http>/ws)

KEYS:
  Enter send / steer · Ctrl+A abort running turn · Esc detach (turn keeps
  running server-side; reopen the session from another frontend) · Ctrl+C quit`);
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("saber tui needs an interactive terminal (TTY stdin and stdout)");
    process.exit(2);
  }

  const http = flag("http") ?? "http://127.0.0.1:3080";
  let wsUrl: string;
  try {
    wsUrl = flag("url") ?? wsUrlFromHttp(http);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
    return;
  }
  const sessionId = flag("session");

  const instance = render(<App wsUrl={wsUrl} sessionId={sessionId} />);
  await instance.waitUntilExit();
}

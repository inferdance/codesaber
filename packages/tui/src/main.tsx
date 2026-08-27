import React from "react";
import { render } from "ink";
import { App } from "./App.js";

export function runTui(rawArgs: string[]): void {
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
  Enter send / steer · Esc abort running turn / quit · Ctrl+C quit`);
    return;
  }

  if (!process.stdout.isTTY) {
    console.error("saber tui needs an interactive terminal (TTY)");
    process.exit(2);
  }

  const http = flag("http") ?? "http://127.0.0.1:3080";
  const wsUrl = flag("url") ?? `${http.replace(/^http/, "ws")}/ws`;
  const sessionId = flag("session");

  const instance = render(<App wsUrl={wsUrl} sessionId={sessionId} />);
  void instance.waitUntilExit();
}

#!/usr/bin/env node
import { createOpenAiProvider, createAnthropicProvider } from "@saber/ai";
import { Engine, SessionLog, createPathPolicy, checkRead, checkWrite, type ToolDefinition, type ToolContext, type ToolResult } from "@saber/core";
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

  // Minimal tool set for M0
  const tools: ToolDefinition[] = [
    {
      name: "bash",
      description: "Runs a bash command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      concurrency: "exclusive",
      async execute(args) {
        const { execa } = await import("execa");
        try {
          const result = await execa("bash", ["-c", args.command as string], {
            cwd: toolContext.cwd,
            timeout: 120_000,
            env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: process.env.LANG ?? "", TMPDIR: process.env.TMPDIR ?? "" },
            extendEnv: false,
            killSignal: "SIGKILL",
            reject: false,
          });
          const output = result.stdout || result.stderr || "(no output)";
          return { content: `${output}\n[exit: ${result.exitCode}]`, isError: result.exitCode !== 0 };
        } catch (e) {
          return { content: `bash failed: ${e}`, isError: true };
        }
      },
    },
    {
      name: "read",
      description: "Reads a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      concurrency: "read_only",
      async execute(args) {
        const denied = checkRead(toolContext.policy, args.path as string);
        if (denied) return { content: denied, isError: true };
        try {
          const content = await fs.promises.readFile(args.path as string, "utf-8");
          const lines = content.split("\n").slice(0, 2000);
          const numbered = lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l.slice(0, 2000)}`).join("\n");
          toolContext.readFiles.add(path.resolve(args.path as string));
          return { content: numbered, isError: false };
        } catch (e) {
          return { content: `read failed: ${e}`, isError: true };
        }
      },
    },
    {
      name: "write",
      description: "Creates or overwrites a file",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      concurrency: "exclusive",
      async execute(args) {
        const denied = checkWrite(toolContext.policy, args.path as string);
        if (denied) return { content: denied, isError: true };
        const resolved = path.resolve(args.path as string);
        try {
          await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
          await fs.promises.writeFile(resolved, args.content as string);
          return { content: `wrote ${args.path}`, isError: false };
        } catch (e) {
          return { content: `write failed: ${e}`, isError: true };
        }
      },
    },
  ];

  const engine = new Engine({
    provider, tools, session, toolContext,
    model: model ?? (auth.isAnthropic ? "claude-sonnet-4-5-20250929" : "gpt-4o"),
    onEvent: jsonMode ? (e) => console.log(JSON.stringify(e)) : undefined,
  });

  const system = `You are saber, a coding agent. Be direct. Read before editing. Run tests to verify.\n# Environment\n- cwd: ${cwd}\n- platform: ${process.platform}`;

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

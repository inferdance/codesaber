import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TMPDIR"] as const;
export const SANDBOX_DENIAL_MARKER = "[saber-sandbox: denied]";
const STREAM_WINDOW = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface BashParams {
  command: string;
  description?: string;
  timeout_ms?: number;
}

export interface BashEnv {
  cwd: string;
  dataDir: string;
  sessionId: string;
}

export interface HeadTail {
  head: string;
  tail: string;
  totalBytes: number;
  spillPath?: string;
  spillFailed: boolean;
}

export interface BashOutput {
  stdout: HeadTail;
  stderr: HeadTail;
  exitCode: number | null;
  timedOut: boolean;
}

export interface BashExecutor {
  execute(env: BashEnv, command: string, timeoutMs: number): Promise<BashOutput>;
}

export function createDirectExecutor(): BashExecutor {
  return { execute: (env, cmd, timeout) => executeDirect(env, cmd, timeout) };
}

export function createSeatbeltExecutor(): BashExecutor {
  return { execute: (env, cmd, timeout) => executeSeatbelt(env, cmd, timeout) };
}

async function executeDirect(env: BashEnv, command: string, timeoutMs: number): Promise<BashOutput> {
  return runWithGovernance(["/bin/bash", "-c", command], env, timeoutMs, "bash");
}

async function executeSeatbelt(env: BashEnv, command: string, timeoutMs: number): Promise<BashOutput> {
  const profile = buildSeatbeltProfile(env.cwd, env.dataDir);
  const sessionTmp = path.join(env.dataDir, "tmp");
  fs.mkdirSync(sessionTmp, { recursive: true });
  const output = await runWithGovernance(
    ["/usr/bin/sandbox-exec", "-p", profile, "--", "/bin/bash", "-c", command],
    env, timeoutMs, "bash", { TMPDIR: sessionTmp },
  );
  if (looksLikeDenial(output)) {
    output.stderr.head += `\n${SANDBOX_DENIAL_MARKER} the sandbox blocked part of this command.`;
  }
  return output;
}

function buildSeatbeltProfile(cwd: string, dataDir: string): string {
  const realCwd = fs.realpathSync(cwd);
  fs.mkdirSync(dataDir, { recursive: true });
  const realData = fs.realpathSync(dataDir);
  const home = process.env.HOME ?? ".";
  const denies: string[] = [];
  for (const dir of SECRET_HOME_DIRS) {
    denies.push(`(deny file-read* (subpath "${path.join(home, dir)}"))`);
  }
  for (const suffix of SECRET_SUFFIXES) {
    denies.push(`(deny file-read* (regex #"^${escapeRegex(realCwd)}/([^/]+/)*[^/]*${escapeRegex(suffix)}[^/]*$"))`);
  }
  denies.push(`(deny file-write* (subpath "${path.join(realCwd, ".git")}"))`);
  const allows = [
    `(allow file-write* (subpath "${realCwd}"))`,
    `(allow file-write* (subpath "${realData}"))`,
    `(allow file-write* (literal "/dev/null"))`,
  ];
  return `(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow file-read*)
(allow file-map-executable)
(allow mach-lookup)
(allow signal (target self))
${allows.join("\n")}
${denies.join("\n")}
`;
}

const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".kube"];
const SECRET_SUFFIXES = [".env", ".env.local", ".pem", "id_rsa", "id_ed25519", ".npmrc", ".netrc", ".git-credentials"];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeDenial(output: BashOutput): boolean {
  const texts = [output.stderr.head, output.stderr.tail, output.stdout.head, output.stdout.tail];
  return texts.some((t) =>
    t.includes("Operation not permitted") ||
    t.includes("Permission denied") ||
    t.includes("Could not resolve host") ||
    t.includes("Temporary failure in name resolution") ||
    t.includes("Network is unreachable"),
  );
}

async function runWithGovernance(
  argv: string[],
  env: BashEnv,
  timeoutMs: number,
  label: string,
  envOverrides: Record<string, string> = {},
): Promise<BashOutput> {
  const timeout = Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const spillDir = path.join(env.dataDir, "truncations", sanitize(env.sessionId));
  fs.mkdirSync(spillDir, { recursive: true });
  const millis = Date.now();
  const stdoutSpill = path.join(spillDir, `${millis}-${label}-stdout.log`);
  const stderrSpill = path.join(spillDir, `${millis}-${label}-stderr.log`);

  return new Promise<BashOutput>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: env.cwd,
      env: {
        ...Object.fromEntries(
          CHILD_ENV_ALLOWLIST
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]!]),
        ),
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutDraft = createDraft();
    const stderrDraft = createDraft();
    const stdoutSpillStream = fs.createWriteStream(stdoutSpill);
    const stderrSpillStream = fs.createWriteStream(stderrSpill);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutDraft.feed(chunk);
      stdoutSpillStream.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrDraft.feed(chunk);
      stderrSpillStream.write(chunk);
    });

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      stdoutSpillStream.end();
      stderrSpillStream.end();
      const stdoutView = stdoutDraft.view(stdoutSpill);
      const stderrView = stderrDraft.view(stderrSpill);
      // Clean up spill files that aren't needed
      if (!stdoutView.spillPath) try { fs.unlinkSync(stdoutSpill); } catch {}
      if (!stderrView.spillPath) try { fs.unlinkSync(stderrSpill); } catch {}
      resolve({
        stdout: stdoutView,
        stderr: stderrView,
        exitCode: code,
        timedOut: false,
      });
    });
  });
}

interface Draft {
  head: Buffer;
  tail: Buffer[];
  tailBytes: number;
  total: number;
  spillOk: boolean;
}

function createDraft(): Draft & { feed(chunk: Buffer): void; view(spillPath: string): HeadTail } {
  const state: Draft = { head: Buffer.alloc(0), tail: [], tailBytes: 0, total: 0, spillOk: true };
  return {
    ...state,
    feed(chunk: Buffer) {
      state.total += chunk.length;
      if (state.head.length < STREAM_WINDOW) {
        const take = Math.min(STREAM_WINDOW - state.head.length, chunk.length);
        state.head = Buffer.concat([state.head, chunk.subarray(0, take)]);
      }
      state.tail.push(chunk);
      state.tailBytes += chunk.length;
      while (state.tailBytes > STREAM_WINDOW && state.tail.length > 0) {
        state.tailBytes -= state.tail[0].length;
        state.tail.shift();
      }
    },
    view(spillPath: string): HeadTail {
      const truncated = state.total > state.head.length;
      return {
        head: state.head.toString("utf-8"),
        tail: Buffer.concat(state.tail).toString("utf-8"),
        totalBytes: state.total,
        spillPath: truncated && state.spillOk ? spillPath : undefined,
        spillFailed: truncated && !state.spillOk,
      };
    },
  };
}

function sanitize(component: string): string {
  return component.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function renderBashOutput(output: BashOutput): string {
  let combined = "";
  const render = (ht: HeadTail, label: string) => {
    if (ht.totalBytes === 0) return;
    combined += `[${label}]\n${ht.head.trimEnd()}\n`;
    if (ht.totalBytes > ht.head.length) {
      const omitted = ht.totalBytes - ht.head.length - ht.tail.length;
      if (ht.spillPath) combined += `…[${omitted} bytes omitted; full at ${ht.spillPath}]…\n`;
      else if (ht.spillFailed) combined += `…[${omitted} bytes omitted; spill FAILED]…\n`;
      if (ht.tail) combined += `${ht.tail.trimEnd()}\n`;
    }
  };
  render(output.stdout, "stdout");
  render(output.stderr, "stderr");
  if (!combined) combined = "(no output)\n";
  combined += `\n[exit code: ${output.timedOut ? "timeout" : output.exitCode ?? "signal"}]`;
  return combined;
}

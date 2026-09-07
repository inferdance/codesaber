/**
 * Harbor-adapter eval driver — runs a task set through `saber exec` and
 * scores the final answers. Task format (JSONL, one per line):
 *   { "id": "t1", "prompt": "...", "expect": { "contains": ["kumquat"] },
 *     "timeout_sec": 300 }
 * Each task runs in a fresh temp workspace; a `workspace` field may point at
 * a directory to copy in instead.
 *
 * Usage: tsx scripts/eval/run.ts tasks.jsonl [--model glm-5.3] [--json]
 */
import { execa } from "execa";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Task {
  id: string;
  prompt: string;
  expect: { contains?: string[]; exit_zero?: boolean };
  workspace?: string;
  timeout_sec?: number;
}

interface Result {
  id: string;
  pass: boolean;
  answer: string;
  exitCode: number | null;
  reasons: string[];
  durationMs: number;
}

const args = process.argv.slice(2);
const taskFile = args[0];
const modelFlag = args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined;
const jsonOut = args.includes("--json");

if (!taskFile || !fs.existsSync(taskFile)) {
  console.error("usage: tsx scripts/eval/run.ts <tasks.jsonl> [--model <m>] [--json]");
  process.exit(2);
}

const cliEntry = path.resolve(import.meta.dirname, "../../packages/cli/src/main.ts");
const tasks: Task[] = fs.readFileSync(taskFile, "utf-8")
  .split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Task);

const results: Result[] = [];
for (const task of tasks) {
  const started = Date.now();
  const reasons: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `saber-eval-${task.id}-`));
  if (!task.workspace) {
    // seed the eval workspace with the task file's siblings (fixtures)
    const fixtureDir = path.dirname(path.resolve(taskFile));
    for (const entry of fs.readdirSync(fixtureDir)) {
      if (entry.endsWith(".jsonl") || entry.startsWith(".")) continue;
      fs.copyFileSync(path.join(fixtureDir, entry), path.join(dir, entry));
    }
  }
  try {
    const timeoutSec = task.timeout_sec ?? 600;
    const tsxBin = path.resolve(import.meta.dirname, "../../node_modules/.bin/tsx");
    const r = await execa(tsxBin, [
      cliEntry, "exec", "-p", task.prompt,
      ...(modelFlag ? ["--model", modelFlag] : []),
      "--timeout", String(timeoutSec),
    ], {
      cwd: task.workspace ?? dir,
      reject: false,
      timeout: timeoutSec * 1000 + 30_000,
    });
    const answer = r.stdout ?? "";
    let pass = true;
    if (task.expect.exit_zero !== false && r.exitCode !== 0) {
      pass = false;
      reasons.push(`exit=${r.exitCode}`);
    }
    for (const needle of task.expect.contains ?? []) {
      if (!answer.includes(needle)) {
        pass = false;
        reasons.push(`missing "${needle}"`);
      }
    }
    results.push({
      id: task.id, pass,
      answer: answer.slice(0, 400),
      exitCode: r.exitCode ?? null,
      reasons,
      durationMs: Date.now() - started,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const passed = results.filter((r) => r.pass).length;
if (jsonOut) {
  console.log(JSON.stringify({ total: results.length, passed, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.pass ? "✓" : "✗"} ${r.id} (${r.durationMs}ms)${r.reasons.length ? " — " + r.reasons.join("; ") : ""}`);
  }
  console.log(`\n${passed}/${results.length} passed`);
}
process.exit(passed === results.length ? 0 : 1);

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execa } from "execa";

/**
 * Real-model smoke — M0 Definition-of-Done #3.
 * Not part of the default `pnpm test` lane (filename lacks .test.ts).
 * Runs only when a key is present; skips otherwise.
 *
 *   ANTHROPIC_API_KEY=... pnpm vitest run packages/cli/src/__tests__/smoke.e2e.ts
 *   OPENAI_API_KEY=...     pnpm vitest run packages/cli/src/__tests__/smoke.e2e.ts
 */
const key = process.env.SABER_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY
  ?? process.env.SABER_OPENAI_KEY ?? process.env.OPENAI_API_KEY;

describe.skipIf(!key)("saber exec against a real model", () => {
  it("completes read → edit → bash → final in a real workspace", { timeout: 180_000 }, async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "saber-smoke-"));
    try {
      writeFileSync(path.join(workspace, "greeting.txt"), "Hello, world!\n");
      const result = await execa("tsx", [
        path.resolve(__dirname, "../../../..", "packages/cli/src/main.ts"),
        "exec",
        "-p", "Read greeting.txt, change 'Hello' to 'Goodbye' using the edit tool, then run `cat greeting.txt` via bash to verify, and reply with the final content.",
        "--timeout", "150",
      ], {
        cwd: workspace,
        env: {
          ...process.env,
          SABER_DATA_DIR: path.join(workspace, ".saber-data"),
        },
        timeout: 170_000,
        reject: false,
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(path.join(workspace, "greeting.txt"), "utf-8")).toBe("Goodbye, world!\n");
      expect(result.stdout).toContain("Goodbye");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { zodToParameters } from "../tools/schema.js";
import { createTools } from "../tools/index.js";
import { createPathPolicy } from "../policy.js";
import type { ToolContext } from "../types.js";

describe("zod → JSON Schema derivation", () => {
  it("carries number constraints (int/min/max) into the schema", () => {
    const params = zodToParameters(z.object({
      n: z.number().int().min(1).max(10),
      plain: z.number(),
    })) as { properties: Record<string, Record<string, unknown>> };
    expect(params.properties.n).toEqual({ type: "integer", minimum: 1, maximum: 10 });
    expect(params.properties.plain).toEqual({ type: "number" });
  });

  it("keeps descriptions attached to optional wrappers", () => {
    const params = zodToParameters(z.object({
      flag: z.boolean().optional().describe("an optional flag"),
      req: z.string(),
    })) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(params.properties.flag).toEqual({ type: "boolean", description: "an optional flag" });
    expect(params.required).toEqual(["req"]);
  });

  it("fails loud on unsupported schema nodes instead of guessing", () => {
    expect(() => zodToParameters(z.object({ list: z.array(z.string()) }))).toThrow(/unsupported/i);
  });

  it("real tool schemas keep constraints the runtime will enforce", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "saber-schema-"));
    try {
      const ctx: ToolContext = {
        sessionId: "schema",
        cwd: workspace,
        dataDir: path.join(workspace, ".data"),
        policy: createPathPolicy(workspace, path.join(workspace, ".data")),
        readFiles: new Map(),
      };
      const tools = createTools(ctx);
      const paramsOf = (name: string): Record<string, unknown> =>
        tools.find((t) => t.name === name)!.parameters;

      const read = paramsOf("read") as {
        properties: Record<string, Record<string, unknown>>;
      };
      expect(read.properties.offset).toMatchObject({ type: "integer", minimum: 1 });
      expect(read.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 2000 });

      const bash = paramsOf("bash") as {
        properties: Record<string, Record<string, unknown>>;
      };
      expect(bash.properties.timeout_ms).toMatchObject({ type: "integer", minimum: 1000, maximum: 600000 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

import { z, ZodFirstPartyTypeKind as Kind } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";

/**
 * Derives the model-facing JSON Schema from the Zod schema — single source of
 * truth. Covers exactly what our tool schemas use; anything else fails loud
 * instead of silently producing a wrong schema.
 */
export function zodToParameters(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = convert(schema);
  if (typeof converted !== "object" || converted === null) {
    throw new Error("zodToParameters: root schema must be an object");
  }
  return converted as Record<string, unknown>;
}

function convert(s: z.ZodTypeAny): unknown {
  const def = s._def as { typeName: string };
  const description = s.description ? { description: s.description } : {};
  switch (def.typeName) {
    case Kind.ZodObject: {
      const shape = (s as unknown as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const raw = value as z.ZodTypeAny;
        const unwrapped = unwrap(raw);
        const converted = convert(unwrapped.schema) as Record<string, unknown>;
        // .describe() on an optional wrapper must survive the unwrap
        if (raw.description && !("description" in converted)) converted.description = raw.description;
        properties[key] = converted;
        if (!unwrapped.optional) required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    case Kind.ZodString:
      return { type: "string", ...description };
    case Kind.ZodNumber: {
      const out: Record<string, unknown> = { type: "number", ...description };
      const checks = (s as unknown as z.ZodNumber)._def.checks as Array<{ kind: string; value?: number }>;
      for (const check of checks) {
        if (check.kind === "int") out.type = "integer";
        else if (check.kind === "min" && typeof check.value === "number") out.minimum = check.value;
        else if (check.kind === "max" && typeof check.value === "number") out.maximum = check.value;
      }
      return out;
    }
    case Kind.ZodBoolean:
      return { type: "boolean", ...description };
    default:
      throw new Error(`zodToParameters: unsupported schema node ${def.typeName}; extend the converter or simplify the tool schema`);
  }
}

function unwrap(s: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  const def = s._def as { typeName: string };
  if (def.typeName === Kind.ZodOptional) {
    const inner = unwrap((s as unknown as z.ZodOptional<z.ZodTypeAny>).unwrap());
    return { schema: inner.schema, optional: true };
  }
  return { schema: s, optional: false };
}

/**
 * Declares a tool from one Zod schema: the execute callback gets parsed,
 * statically-typed args; the model-facing parameters are derived. Bad
 * parameters are rejected before execute runs.
 */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<S>,
  concurrency: "read_only" | "exclusive",
  execute: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>,
): ToolDefinition {
  return {
    name,
    description,
    concurrency,
    parameters: zodToParameters(schema),
    async execute(raw, ctx) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return { content: `invalid arguments: ${issues}`, isError: true };
      }
      return execute(parsed.data, ctx);
    },
  };
}

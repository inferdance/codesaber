export interface ToolResult { content: string; isError: boolean }

export interface ToolContext {
  sessionId: string;
  cwd: string;
  dataDir: string;
  policy: import("./policy.js").PathPolicy;
  readFiles: Set<string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  concurrency: "read_only" | "exclusive";
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

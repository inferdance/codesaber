export interface ToolResult { content: string; isError: boolean }

export interface ToolContext {
  sessionId: string;
  cwd: string;
  dataDir: string;
  policy: import("./policy.js").PathPolicy;
  /** Files read (or written) this session → mtime at that moment.
   *  edit refuses when the file changed since (freshness guard). */
  readFiles: Map<string, number>;
  /** Current turn's abort signal; tools that spawn processes must honor it. */
  signal?: AbortSignal;
  /** Engine event sink, set per turn; tools with nested tool dispatch
   *  (run_code) use it to keep "model-visible ⟺ logged" intact. */
  dispatch?: (payload: import("./events.js").SaberPayload, opts?: { sync?: boolean }) => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  concurrency: "read_only" | "exclusive";
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * saber server — the resident engine: Fastify HTTP + WebSocket.
 * Frontends (web UI, CLI, future native app) connect here.
 */
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { createAnthropicProvider, createOpenAiProvider } from "@saber/ai";
import { Engine, SessionLog, type EngineEvent } from "@saber/agent";
import { createBuiltinTools, createToolContext, createSeatbeltExecutor, createDirectExecutor } from "@saber/tools";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.SABER_PORT ?? "3080", 10);
const DATA_DIR = process.env.SABER_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".codesaber");

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

// Active engines (one per session)
const engines = new Map<string, Engine>();
const eventHistory = new Map<string, EngineEvent[]>();

interface CreateSessionRequest {
  prompt: string;
  model?: string;
  provider?: "anthropic" | "openai" | "deepseek";
}

function createProvider(req: CreateSessionRequest) {
  const model = req.model ?? "claude-sonnet-4-5-20250929";
  if (req.provider === "openai" || process.env.OPENAI_API_KEY) {
    return {
      provider: createOpenAiProvider({
        name: "openai",
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: process.env.SABER_OPENAI_KEY ?? process.env.OPENAI_API_KEY ?? "",
        defaultModel: model,
      }),
      model,
    };
  }
  return {
    provider: createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      apiKey: process.env.SABER_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
      defaultModel: model,
    }),
    model,
  };
}

// REST: create session + start turn
app.post<{ Body: CreateSessionRequest }>("/api/sessions", async (req, reply) => {
  const sessionId = randomUUID().slice(0, 8);
  const { provider, model } = createProvider(req.body);

  const session = new SessionLog(
    path.join(DATA_DIR, "sessions"), sessionId,
    { protocol_version: "0.1.0", engine_version: "0.1.0", cwd: process.cwd(), model },
  );

  const executor = process.platform === "darwin"
    ? createSeatbeltExecutor() : createDirectExecutor();
  const toolContext = createToolContext(sessionId, process.cwd(), DATA_DIR, executor);

  const events: EngineEvent[] = [];
  eventHistory.set(sessionId, events);

  const engine = new Engine({
    provider,
    tools: createBuiltinTools(),
    session,
    toolContext,
    model,
    onEvent: (e) => { events.push(e); broadcast(sessionId, e); },
  });
  engines.set(sessionId, engine);

  // Fire the turn (async, non-blocking)
  const turnPromise = engine.runTurn({
    userMessage: req.body.prompt,
    system: buildSystemPrompt(process.cwd()),
  });
  turnPromise.then((result) => {
    broadcast(sessionId, { type: "turn_complete", turnId: "final", reason: result.outcome.kind });
  }).catch((e) => {
    app.log.error(e);
  });

  reply.send({ sessionId, model });
});

function buildSystemPrompt(cwd: string): string {
  let prompt = "You are saber, a coding agent. Be direct and precise. Read before editing. Run tests to verify.\n";
  prompt += `\n# Environment\n- Working directory: ${cwd}\n- Platform: ${process.platform}\n`;
  try {
    const agents = require("node:fs").readFileSync(path.join(cwd, "AGENTS.md"), "utf-8");
    prompt += `\n# Project instructions\n${agents}\n`;
  } catch {}
  return prompt;
}

// WebSocket: real-time events
const wsClients = new Map<string, Set<import("ws").WebSocket>>();

app.get("/ws/:sessionId", { websocket: true }, (socket, req) => {
  const sessionId = (req.params as any).sessionId;
  if (!wsClients.has(sessionId)) wsClients.set(sessionId, new Set());
  wsClients.get(sessionId)!.add(socket);

  // Send event history for replay
  const history = eventHistory.get(sessionId) ?? [];
  for (const event of history) {
    socket.send(JSON.stringify(event));
  }

  socket.on("close", () => { wsClients.get(sessionId)?.delete(socket); });

  // Receive steering messages
  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "steer" && engines.has(sessionId)) {
        engines.get(sessionId)!.steer(msg.text);
      }
    } catch {}
  });
});

function broadcast(sessionId: string, event: EngineEvent): void {
  const clients = wsClients.get(sessionId);
  if (clients) {
    const json = JSON.stringify(event);
    for (const ws of clients) { if (ws.readyState === 1) ws.send(json); }
  }
}

// Health check
app.get("/api/health", async () => ({ status: "ok", version: "0.1.0" }));

// List sessions
app.get("/api/sessions", async () => {
  return Array.from(engines.entries()).map(([id, engine]) => ({
    id,
    usage: engine.getUsage(),
  }));
});

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`⚡ saber server running at http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws/:sessionId`);
  console.log(`   Data dir: ${DATA_DIR}`);
});

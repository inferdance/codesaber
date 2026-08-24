import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { AgentServer, type AgentServerOptions } from "./manager.js";

export interface ServerOptions extends AgentServerOptions {
  port?: number;
  host?: string;
}

export interface SaberServer {
  app: FastifyInstance;
  agent: AgentServer;
  listen(): Promise<string>;
  close(): Promise<void>;
}

interface ClientMessage {
  type?: string;
  commandId?: string;
  sessionId?: string;
  text?: string;
  since?: number;
}

/**
 * HTTP + WebSocket surface over AgentServer.
 *
 * REST: GET /api/health, GET /api/sessions, GET /api/sessions/:id
 * WS /ws: client → {subscribe|unsubscribe|prompt|steer|abort}, server →
 * WireEvents (one vocabulary with the session log) plus {type:"ack"} replies.
 */
export async function createSaberServer(opts: ServerOptions): Promise<SaberServer> {
  const agent = new AgentServer(opts);
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true, model: opts.model, cwd: opts.cwd }));

  app.get("/api/sessions", async () => agent.listSessions());

  app.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return agent.projection(id);
    } catch {
      reply.code(404);
      return { error: "session not found" };
    }
  });

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const send = (value: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
    };
    const unsubs = new Map<string, () => void>();
    const subscribe = (sessionId: string, since: number): void => {
      if (!sessionId || unsubs.has(sessionId)) return;
      unsubs.set(sessionId, agent.subscribe(sessionId, since, send));
    };

    socket.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send({ type: "error", message: "malformed message" });
        return;
      }
      switch (msg.type) {
        case "subscribe":
          subscribe(msg.sessionId ?? "", typeof msg.since === "number" ? msg.since : 0);
          break;
        case "unsubscribe":
          if (msg.sessionId) {
            unsubs.get(msg.sessionId)?.();
            unsubs.delete(msg.sessionId);
          }
          break;
        case "prompt": {
          if (!msg.text) {
            send({ type: "ack", kind: "prompt", commandId: msg.commandId, error: "text required" });
            return;
          }
          const result = agent.prompt({
            sessionId: msg.sessionId,
            text: msg.text,
            commandId: msg.commandId ?? `anon-${Date.now()}`,
          });
          send({ type: "ack", kind: "prompt", commandId: msg.commandId, ...result });
          // the requester sees the turn even without an explicit subscribe
          if (!result.duplicate && result.sessionId) subscribe(result.sessionId, 0);
          break;
        }
        case "steer": {
          const ok = agent.steer({
            sessionId: msg.sessionId ?? "",
            text: msg.text ?? "",
            commandId: msg.commandId ?? `anon-${Date.now()}`,
          });
          send({ type: "ack", kind: "steer", commandId: msg.commandId, ok });
          break;
        }
        case "abort": {
          const ok = agent.abort(msg.sessionId ?? "");
          send({ type: "ack", kind: "abort", commandId: msg.commandId, ok });
          break;
        }
        default:
          send({ type: "error", message: `unknown message type: ${String(msg.type)}` });
      }
    });

    socket.on("close", () => {
      for (const unsub of unsubs.values()) unsub();
      unsubs.clear();
    });
  });

  return {
    app,
    agent,
    listen: () => app.listen({ port: opts.port ?? 0, host: opts.host ?? "127.0.0.1" }),
    close: () => app.close(),
  };
}

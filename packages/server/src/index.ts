import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { AgentServer, type AgentServerOptions } from "./manager.js";
import { ClientMessageSchema, type ClientMessage } from "./protocol.js";

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

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function resolveWebDist(): string {
  try {
    const webPackage = createRequire(import.meta.url).resolve("@saber/web/package.json");
    return path.join(path.dirname(webPackage), "dist");
  } catch {
    // dependency not linked (bare checkout without install) — monorepo sibling
    return fileURLToPath(new URL("../../web/dist", import.meta.url));
  }
}

/**
 * HTTP + WebSocket surface over AgentServer.
 *
 * REST: GET /api/health, GET /api/sessions, GET /api/sessions/:id
 * WS /ws: client → {subscribe|unsubscribe|prompt|steer|abort} (Zod-validated),
 * server → WireEvents (one vocabulary with the session log) plus ack replies.
 *
 * The socket binds to the loopback interface only; browsers from other
 * origins are additionally rejected (CSWSH defense-in-depth), while
 * non-browser clients (no Origin header) pass.
 */
export async function createSaberServer(opts: ServerOptions): Promise<SaberServer> {
  const agent = new AgentServer(opts);
  const app = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get("/api/health", async () => ({ ok: true, model: opts.model, cwd: opts.cwd }));

  app.get("/api/sessions", async () => agent.sessionSummaries());

  app.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return agent.projection(id);
    } catch {
      reply.code(404);
      return { error: "session not found" };
    }
  });

  app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {    const origin = request.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }
    const send = (value: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
    };
    const unsubs = new Map<string, () => void>();
    const subscribe = (sessionId: string, since: number): void => {
      if (!sessionId || unsubs.has(sessionId)) return;
      unsubs.set(sessionId, agent.subscribe(sessionId, since, send));
    };

    socket.on("message", (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "malformed message" });
        return;
      }
      const checked = ClientMessageSchema.safeParse(parsed);
      if (!checked.success) {
        send({ type: "error", message: `invalid message: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
        return;
      }
      const msg = checked.data as ClientMessage;
      switch (msg.type) {
        case "subscribe":
          subscribe(msg.sessionId, msg.since ?? 0);
          break;
        case "unsubscribe":
          unsubs.get(msg.sessionId)?.();
          unsubs.delete(msg.sessionId);
          break;
        case "prompt": {
          const result = agent.prompt({ sessionId: msg.sessionId, text: msg.text, commandId: msg.commandId });
          send({ type: "ack", kind: "prompt", commandId: msg.commandId, ...result });
          // the requester sees the turn even without an explicit subscribe
          if (!result.duplicate && !result.error && result.sessionId) subscribe(result.sessionId, 0);
          break;
        }
        case "steer": {
          const ok = agent.steer({ sessionId: msg.sessionId, text: msg.text, commandId: msg.commandId });
          send({ type: "ack", kind: "steer", commandId: msg.commandId, ok });
          break;
        }
        case "abort": {
          const ok = agent.abort(msg.sessionId, msg.turnId);
          send({ type: "ack", kind: "abort", commandId: msg.commandId, ok });
          break;
        }      }
    });

    socket.on("close", () => {
      for (const unsub of unsubs.values()) unsub();
      unsubs.clear();
    });
  });

  // serve the built web UI when present; dotfiles are denied and no env
  // override exists — a static root must never be able to point at a
  // workspace, repo, or home directory. Resolving through the package
  // dependency works in BOTH layouts: monorepo (workspace symlink) and
  // npm install (@saber/web as a real dependency of this package).
  const webDist = resolveWebDist();
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, dotfiles: "deny" });
  }

  return {
    app,
    agent,
    listen: () => app.listen({ port: opts.port ?? 0, host: opts.host ?? "127.0.0.1" }),
    close: async () => {
      await agent.close();
      await app.close();
    },
  };
}

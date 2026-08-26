import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectSession, SaberClient, type SessionProjection, type WireEvent } from "@saber/core";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface PendingSteer {
  text: string;
}

/**
 * One SaberClient for the app lifetime. Events accumulate in a ref; a rAF-
 * batched version bump triggers exactly one refold per frame however many
 * deltas arrived (burst-safe). The projection folds only the active
 * session's events with the shared core fold — same code as the server.
 */
export function useSaberSession(url: string): {
  status: ConnectionStatus;
  projection: SessionProjection;
  activeSession: string;
  send: (text: string) => void;
  abort: () => void;
  selectSession: (sessionId: string) => void;
  newChat: () => void;
} {
  const eventsRef = useRef<WireEvent[]>([]);
  const clientRef = useRef<SaberClient | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingSteerRef = useRef(new Map<string, PendingSteer>());
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [activeSession, setActiveSession] = useState("");

  const scheduleRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    const client = new SaberClient({
      url,
      sessionId: "",
      onConnect: () => setStatus("connected"),
      onDisconnect: () => setStatus("disconnected"),
      onAck: (ack) => {
        if (ack.kind === "prompt" && typeof ack.sessionId === "string" && ack.sessionId) {
          setActiveSession(ack.sessionId);
        }
        // a steer that raced past the end of a turn falls back to a queued
        // prompt, so user text is never silently dropped
        if (ack.kind === "steer" && ack.ok === false && typeof ack.commandId === "string") {
          const pending = pendingSteerRef.current.get(ack.commandId);
          if (pending) {
            pendingSteerRef.current.delete(ack.commandId);
            client.send({ type: "prompt", commandId: crypto.randomUUID(), text: pending.text });
          }
        }
        scheduleRender();
      },
      onEvent: (event) => {
        eventsRef.current.push(event);
        scheduleRender();
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      client.disconnect();
      clientRef.current = null;
    };
  }, [url, scheduleRender]);

  // version is the refold trigger; the events ref identity is stable by design
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projection = useMemo(
    () => projectSession(activeSession, eventsRef.current.filter((e) => e.sessionId === activeSession)),
    [activeSession, version],
  );

  const send = useCallback((text: string) => {
    const client = clientRef.current;
    if (!client || !text.trim()) return;
    if (projection.isRunning && activeSession) {
      const commandId = crypto.randomUUID();
      pendingSteerRef.current.set(commandId, { text });
      client.send({ type: "steer", commandId, text, sessionId: activeSession });
    } else {
      client.send({
        type: "prompt",
        commandId: crypto.randomUUID(),
        text,
        sessionId: activeSession || undefined,
      });
    }
  }, [projection.isRunning, activeSession]);

  const abort = useCallback(() => {
    if (activeSession) clientRef.current?.send({ type: "abort", commandId: crypto.randomUUID(), sessionId: activeSession });
  }, [activeSession]);

  const selectSession = useCallback((sessionId: string) => {
    clientRef.current?.setSession(sessionId);
    setActiveSession(sessionId);
  }, []);

  const newChat = useCallback(() => {
    clientRef.current?.setSession("");
    eventsRef.current = [];
    setActiveSession("");
    setVersion((v) => v + 1);
  }, []);

  return { status, projection, activeSession, send, abort, selectSession, newChat };
}

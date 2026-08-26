import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectSession, SaberClient, type SessionProjection, type WireEvent } from "@saber/core";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface PendingSteer {
  text: string;
  sessionId: string;
}

/**
 * One SaberClient for the app lifetime. Events accumulate in a ref (deduped
 * per session by seq — replays and late cross-session events can never
 * duplicate or reorder); a rAF-batched version bump triggers exactly one
 * refold per frame however many deltas arrived. The projection folds only
 * the active session's events with the shared core fold — same code as the
 * server.
 */
export function useSaberSession(url: string): {
  status: ConnectionStatus;
  projection: SessionProjection;
  activeSession: string;
  /** Returns false when the socket is not open — callers must keep the text. */
  send: (text: string) => boolean;
  abort: () => void;
  selectSession: (sessionId: string) => void;
  newChat: () => void;
} {
  const eventsRef = useRef<WireEvent[]>([]);
  const seqMapRef = useRef(new Map<string, number>());
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
        if (ack.kind === "steer" && typeof ack.commandId === "string") {
          const pending = pendingSteerRef.current.get(ack.commandId);
          pendingSteerRef.current.delete(ack.commandId);
          // a steer that raced past the end of the turn falls back to a
          // queued prompt IN THE SAME SESSION — user text is never dropped
          // and never lands in a new session
          if (pending && ack.ok === false) {
            client.send({ type: "prompt", commandId: crypto.randomUUID(), text: pending.text, sessionId: pending.sessionId });
          }
        }
        scheduleRender();
      },
      onEvent: (event) => {
        if (typeof event.seq === "number") {
          const seen = seqMapRef.current.get(event.sessionId) ?? 0;
          if (event.seq <= seen) return; // replayed or stale duplicate
          seqMapRef.current.set(event.sessionId, event.seq);
        }
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

  const send = useCallback((text: string): boolean => {
    const client = clientRef.current;
    const value = text.trim();
    if (!client || !value) return false;
    if (projection.isRunning && activeSession) {
      const commandId = crypto.randomUUID();
      pendingSteerRef.current.set(commandId, { text: value, sessionId: activeSession });
      return client.send({ type: "steer", commandId, text: value, sessionId: activeSession });
    }
    return client.send({
      type: "prompt",
      commandId: crypto.randomUUID(),
      text: value,
      sessionId: activeSession || undefined,
    });
  }, [projection.isRunning, activeSession]);

  const abort = useCallback(() => {
    if (activeSession && projection.currentTurn) {
      clientRef.current?.send({
        type: "abort",
        commandId: crypto.randomUUID(),
        turnId: projection.currentTurn,
        sessionId: activeSession,
      });
    }
  }, [activeSession, projection.currentTurn]);

  const selectSession = useCallback((sessionId: string) => {
    clientRef.current?.setSession(sessionId);
    setActiveSession(sessionId);
  }, []);

  const newChat = useCallback(() => {
    clientRef.current?.setSession("");
    eventsRef.current = [];
    seqMapRef.current.clear();
    pendingSteerRef.current.clear();
    setActiveSession("");
    setVersion((v) => v + 1);
  }, []);

  return { status, projection, activeSession, send, abort, selectSession, newChat };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionProjection } from "@saber/core";
import { useSaberSession } from "./useSaberSession.js";
import { MessageList } from "./components/MessageList.js";
import { Composer } from "./components/Composer.js";

interface SessionSummary {
  id: string;
  title: string;
  isRunning: boolean;
}

function Sidebar({ sessions, activeSession, onSelect, onNew }: {
  sessions: SessionSummary[];
  activeSession: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="sidebar">
      <button className="new-chat" onClick={onNew}>+ new chat</button>
      <div className="session-list">
        {sessions.map((session) => (
          <button
            key={session.id}
            className={`session${session.id === activeSession ? " active" : ""}`}
            onClick={() => onSelect(session.id)}
          >
            {session.isRunning ? <span className="running-dot" /> : null}
            <span className="session-title">{session.title}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export default function App() {
  const { status, projection, activeSession, send, abort, selectSession, newChat } = useSaberSession("/ws");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  const refreshSessions = useCallback(() => {
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SessionSummary[]) => setSessions(list))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    refreshSessions();
    const timer = setInterval(refreshSessions, 30_000); // summaries only — cheap
    return () => clearInterval(timer);
  }, [refreshSessions]);

  // refresh the sidebar right after a turn finishes
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !projection.isRunning) refreshSessions();
    wasRunning.current = projection.isRunning;
  }, [projection.isRunning, refreshSessions]);

  return (
    <div className="app">
      <Sidebar sessions={sessions} activeSession={activeSession} onSelect={selectSession} onNew={newChat} />
      <main className="chat">
        <header className="chat-header">
          <span className="brand">⚔️ saber</span>
          <span className="session-id">{activeSession || "new session"}</span>
          {projection.usage.inputTokens > 0
            ? <span className="usage">in {projection.usage.inputTokens} · out {projection.usage.outputTokens}{projection.usage.costUsd > 0 ? ` · $${projection.usage.costUsd.toFixed(4)}` : ""}</span>
            : null}
        </header>
        <MessageList messages={projection.messages} />
        <Composer status={status} isRunning={projection.isRunning} onSend={send} onAbort={abort} />
      </main>
    </div>
  );
}

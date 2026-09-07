import React, { useCallback, useEffect, useState } from "react";
import { Box, Static, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { useSaberSession } from "@saber/ui-shared/hook";
import type { MessageView } from "@saber/ui-shared";
import { sanitizeTerminalText } from "./sanitize.js";

export type TuiExitKind = "detach" | "quit";

interface SessionSummary {
  id: string;
  title: string;
  isRunning: boolean;
}

function MessageRow({ message }: { message: MessageView }) {
  switch (message.role) {
    case "user":
      return <Text color="cyan">❯ {sanitizeTerminalText(message.content)}</Text>;
    case "assistant":
      return (
        <Box flexDirection="row">
          <Text>{sanitizeTerminalText(message.content)}</Text>
          {message.streaming ? <Text color="blue"> ▍</Text> : null}
        </Box>
      );
    case "tool": {
      const preview = sanitizeTerminalText(message.content).split("\n").slice(0, 12).join("\n");
      return (
        <Box flexDirection="column">
          <Text color={message.isError ? "red" : "gray"}>
            {message.isError ? "✕" : "⚒"} {message.toolName}
          </Text>
          {preview
            ? <Box marginLeft={2}><Text dimColor wrap="truncate-end">{preview}</Text></Box>
            : null}
        </Box>
      );
    }
    case "error":
      return <Text color="red">✕ {sanitizeTerminalText(message.content)}</Text>;
    case "system":
      return <Text dimColor>── {sanitizeTerminalText(message.content)} ──</Text>;
  }
}

export function App({ wsUrl, httpUrl, sessionId, onExitKind }: { wsUrl: string; httpUrl: string; sessionId?: string; onExitKind?: (kind: TuiExitKind) => void }) {
  const { exit } = useApp();
  const { status, projection, activeSession, send, abort, selectSession } = useSaberSession(wsUrl, { sessionId });
  const [input, setInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);

  // keep the selected row inside the visible 10-row window
  const pickerWindowStart = Math.max(0, Math.min(pickerIndex - 5, Math.max(0, sessions.length - 10)));
  const refreshSessions = useCallback((): void => {
    fetch(`${httpUrl}/api/sessions`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SessionSummary[]) => setSessions(list))
      .catch(() => setSessions([]));
  }, [httpUrl]);

  useInput((input_, key) => {
    if (pickerOpen) {
      if (key.escape) { setPickerOpen(false); return; }
      // raw-mode Ctrl+C (0x03) arrives as input, not SIGINT — it QUITs
      if (input_ === "\x03") { onExitKind?.("quit"); exit(); return; }
      if (key.upArrow) { setPickerIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setPickerIndex((i) => Math.min(sessions.length - 1, i + 1)); return; }
      if (key.return) {
        const chosen = sessions[pickerIndex];
        if (chosen) selectSession(chosen.id);
        setPickerOpen(false);
        return;
      }
      return; // swallow other keys while the picker is open
    }
    // raw-mode Ctrl+C (0x03) arrives as input, not SIGINT — it QUITs
    if (input_ === "\x03") { onExitKind?.("quit"); exit(); return; }
    // Esc always DETACHES: the turn keeps running server-side so another
    // frontend (browser) can take over the same session — never aborts it.
    if (key.escape) { onExitKind?.("detach"); exit(); }
    // Ctrl+A aborts the active turn explicitly
    if (key.ctrl && input_ === "a" && projection.isRunning) abort();
    // Tab opens the session switcher
    if (key.tab) {
      setPickerIndex(0);
      setPickerOpen(true);
      refreshSessions();
    }
  });

  useEffect(() => {
    if (status === "disconnected") setInput((current) => current); // keep draft on drops
  }, [status]);

  const submit = (value: string): void => {
    if (pickerOpen) return; // Enter selects in the picker, never submits
    const ok = send(value);
    if (ok) setInput("");
  };

  const messages = projection.messages;
  const settled = messages[messages.length - 1]?.streaming ? messages.slice(0, -1) : messages;
  const streaming = messages[messages.length - 1]?.streaming ? messages[messages.length - 1] : null;

  return (
    <Box flexDirection="column">
      {/* keyed by session: ink Static never reprints already-rendered items,
          so switching sessions must remount it or cached history is skipped */}
      <Static key={activeSession} items={settled}>
        {(message) => <MessageRow key={message.timestamp} message={message} />}
      </Static>
      {streaming ? <MessageRow message={streaming} /> : null}

      {pickerOpen ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text dimColor>sessions (↑↓ select · enter switch · esc close)</Text>
          {sessions.length === 0
            ? <Text dimColor>(none — is the server running?)</Text>
            : sessions.slice(pickerWindowStart, pickerWindowStart + 10).map((session, windowOffset) => {
                const index = pickerWindowStart + windowOffset;
                return (
                  <Text key={session.id} color={index === pickerIndex ? "cyan" : undefined}>
                    {index === pickerIndex ? "❯ " : "  "}
                    {session.isRunning ? "● " : "  "}
                    {sanitizeTerminalText(session.title).slice(0, 60)}
                    {session.id === activeSession ? " (current)" : ""}
                  </Text>
                );
              })}
        </Box>
      ) : null}

      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <Text dimColor>
          {status === "connected" ? "●" : status === "connecting" ? "○" : "✕"} {status}
          {" · "}{activeSession || "new session"}
          {projection.isRunning ? " · ctrl+a abort" : ""}
          {" · tab sessions · esc detach"}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          focus={!pickerOpen}
          placeholder={status === "connected"
            ? (projection.isRunning ? "steer the running turn…" : "ask saber anything…")
            : "connecting…"}
        />
      </Box>
      {projection.usage.inputTokens > 0
        ? <Text dimColor>tokens: in {projection.usage.inputTokens} · out {projection.usage.outputTokens}</Text>
        : null}
    </Box>
  );
}

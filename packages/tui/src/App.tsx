import React, { useEffect, useState } from "react";
import { Box, Static, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { useSaberSession } from "@saber/ui-shared/hook";
import type { MessageView } from "@saber/ui-shared";
import { sanitizeTerminalText } from "./sanitize.js";

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

export function App({ wsUrl, sessionId }: { wsUrl: string; sessionId?: string }) {
  const { exit } = useApp();
  const { status, projection, activeSession, send, abort } = useSaberSession(wsUrl, { sessionId });
  const [input, setInput] = useState("");

  useInput((input_, key) => {
    // Esc always DETACHES: the turn keeps running server-side so another
    // frontend (browser) can take over the same session — never aborts it.
    if (key.escape) exit();
    // Ctrl+A aborts the active turn explicitly
    if (key.ctrl && input_ === "a" && projection.isRunning) abort();
  });

  useEffect(() => {
    if (status === "disconnected") setInput((current) => current); // keep draft on drops
  }, [status]);

  const submit = (value: string): void => {
    const ok = send(value);
    if (ok) setInput("");
  };

  const messages = projection.messages;
  const settled = messages[messages.length - 1]?.streaming ? messages.slice(0, -1) : messages;
  const streaming = messages[messages.length - 1]?.streaming ? messages[messages.length - 1] : null;

  return (
    <Box flexDirection="column">
      <Static items={settled}>
        {(message) => <MessageRow key={message.timestamp} message={message} />}
      </Static>
      {streaming ? <MessageRow message={streaming} /> : null}

      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <Text dimColor>
          {status === "connected" ? "●" : status === "connecting" ? "○" : "✕"} {status}
          {" · "}{activeSession || "new session"}
          {projection.isRunning ? " · ctrl+a abort" : ""}
          {" · esc detach"}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
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

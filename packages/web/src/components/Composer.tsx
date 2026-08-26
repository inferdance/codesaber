import { useRef, useState, type KeyboardEvent } from "react";
import type { ConnectionStatus } from "../useSaberSession.js";

interface ComposerProps {
  status: ConnectionStatus;
  isRunning: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({ status, isRunning, onSend, onAbort }: ComposerProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = status !== "connected";

  const submit = (): void => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
    textareaRef.current?.focus();
  };

  // IME-safe: Enter during composition (Chinese input) must not submit
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        value={text}
        placeholder={disabled ? "connecting…" : isRunning ? "steering — Enter to inject into the running turn" : "Ask saber anything · Enter to send · Shift+Enter for newline"}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
      />
      <div className="composer-actions">
        <span className={`status status-${status}`}>{status}</span>
        {isRunning
          ? <button className="abort" onClick={onAbort}>abort (esc)</button>
          : <button onClick={submit} disabled={disabled || !text.trim()}>send</button>}
      </div>
    </div>
  );
}

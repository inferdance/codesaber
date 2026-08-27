import { useEffect, useRef } from "react";
import type { MessageView } from "@saber/ui-shared";

function UserCard({ message }: { message: MessageView }) {
  return (
    <div className="msg user">
      <div className="bubble">{message.content}</div>
    </div>
  );
}

function AssistantCard({ message }: { message: MessageView }) {
  return (
    <div className="msg assistant">
      <div className="bubble">
        {message.content}
        {message.streaming ? <span className="cursor" aria-label="streaming" /> : null}
      </div>
    </div>
  );
}

function ToolCard({ message }: { message: MessageView }) {
  return (
    <details className="msg tool" open={message.isError}>
      <summary>
        <span className={`tool-name${message.isError ? " failed" : ""}`}>
          {message.isError ? "✕" : "⚒"} {message.toolName}
        </span>
      </summary>
      <pre>{message.content}</pre>
    </details>
  );
}

function ErrorCard({ message }: { message: MessageView }) {
  return <div className="msg error">{message.content}</div>;
}

function SystemCard({ message }: { message: MessageView }) {
  return <div className="msg system">{message.content}</div>;
}

export function MessageList({ messages }: { messages: MessageView[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="messages">
      {messages.map((message, index) => {
        const key = `${message.timestamp}-${index}`;
        switch (message.role) {
          case "user": return <UserCard key={key} message={message} />;
          case "assistant": return <AssistantCard key={key} message={message} />;
          case "tool": return <ToolCard key={key} message={message} />;
          case "error": return <ErrorCard key={key} message={message} />;
          case "system": return <SystemCard key={key} message={message} />;
        }
      })}
      <div ref={bottomRef} />
    </div>
  );
}

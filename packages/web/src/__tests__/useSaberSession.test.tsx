// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SaberSocketLike } from "@saber/ui-shared";
import { useSaberSession } from "@saber/ui-shared/hook";

class FakeSocket implements SaberSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  serverAccept(): void { this.readyState = 1; this.onopen?.(); }
  serverMessage(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const flushFrames = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };

describe("useSaberSession", () => {
  it("keeps a session's history across newChat and back (cache + watermark regression)", async () => {
    const sockets: FakeSocket[] = [];
    const factory = (): FakeSocket => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const { result } = renderHook(() => useSaberSession("ws://t/ws", { socketFactory: factory }));

    sockets[0].serverAccept();
    await flushFrames();
    expect(result.current.status).toBe("connected");

    // start a session
    act(() => { result.current.send("hello"); });
    const rawPrompt = sockets[0].sent.find((s) => s.includes("\"prompt\""));
    if (!rawPrompt) throw new Error("prompt was not sent");
    const prompt = JSON.parse(rawPrompt) as { commandId: string };
    sockets[0].serverMessage({ type: "ack", kind: "prompt", commandId: prompt.commandId, sessionId: "alpha", started: true });
    await flushFrames();
    expect(result.current.activeSession).toBe("alpha");

    // a durable user + assistant exchange lands
    sockets[0].serverMessage({
      type: "user_message", seq: 1, sessionId: "alpha",
      message: { role: "user", blocks: [{ type: "text", text: "hello" }] },
    });
    sockets[0].serverMessage({
      type: "assistant_message", seq: 2, sessionId: "alpha",
      message: { role: "assistant", blocks: [{ type: "text", text: "hi there" }] },
      usage: ZERO_USAGE,
    });
    await flushFrames();
    expect(result.current.projection.messages).toHaveLength(2);

    // new chat clears the VIEW, not other sessions' caches
    act(() => { result.current.newChat(); });
    await flushFrames();
    expect(result.current.projection.messages).toHaveLength(0);

    // returning to the session resumes from its own watermark…
    act(() => { result.current.selectSession("alpha"); });
    await flushFrames();
    const resubscribe = JSON.parse(sockets[0].sent[sockets[0].sent.length - 1]);
    expect(resubscribe).toEqual({ type: "subscribe", sessionId: "alpha", since: 2 });

    // …and the history is still there without any replay
    expect(result.current.projection.messages).toHaveLength(2);
    expect(result.current.projection.messages[0]?.content).toBe("hello");
  });
});

/**
 * The shared transcript reducer — desktop/mobile parity on slash-command acks.
 *
 * Regression this pins: the `/stop`, `/steer` and `/btw` acks are published
 * out-of-band and used to land in the fallback path, where the turn's next
 * `_progress` frame overwrote them. Telegram shows each ack as its own message,
 * so the dashboard ended up with no ack at all.
 */
import { describe, it, expect } from "vitest";

import { applyOutbound } from "@/lib/transcript";
import type { ChatMessage } from "@/views/ChatView";
import type { OutboundMessage } from "@/lib/types";

function frame(content: string, metadata: Record<string, unknown> = {}): OutboundMessage {
  return {
    type: "message",
    channel: "dashboard",
    chatId: "console",
    content,
    media: [],
    replyTo: null,
    metadata,
  };
}

const user = (content: string): ChatMessage => ({ role: "user", content });

describe("applyOutbound — command notices", () => {
  it("appends a notice as its own sealed bubble", () => {
    const out = applyOutbound([user("/btw hi")], frame("💬 BTW noted", { _notice: true }));
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      role: "assistant",
      content: "💬 BTW noted",
      notice: true,
    });
    expect(out[1].progress).toBeUndefined();
  });

  it("is NOT overwritten by the turn's next progress frame", () => {
    // The exact /btw sequence captured live: ack (+0.0s) then progress (+1.7s).
    let msgs: ChatMessage[] = [user("/btw hi")];
    msgs = applyOutbound(msgs, frame("💬 BTW noted", { _notice: true }));
    msgs = applyOutbound(msgs, frame("P", { _progress: true, _btw: true }));
    msgs = applyOutbound(msgs, frame("PONG", { _progress: true, _btw: true }));

    expect(msgs.map((m) => m.content)).toEqual(["/btw hi", "💬 BTW noted", "PONG"]);
    expect(msgs[1].notice).toBe(true);
    expect(msgs[2].notice).toBeUndefined();
    expect(msgs[2].progress).toBe(true);
  });

  it("keeps the notice intact through a full /btw turn", () => {
    let msgs: ChatMessage[] = [user("/btw hi")];
    msgs = applyOutbound(msgs, frame("💬 BTW noted", { _notice: true }));
    msgs = applyOutbound(msgs, frame("PONG", { _progress: true, _btw: true }));
    msgs = applyOutbound(msgs, frame("PONG", { _final: true, _btw: true }));

    expect(msgs.map((m) => m.content)).toEqual(["/btw hi", "💬 BTW noted", "PONG"]);
    expect(msgs[1]).toMatchObject({ notice: true });
    expect(msgs[2]).toMatchObject({ progress: false });
  });

  it("survives a /steer ack landing between the running turn's frames", () => {
    let msgs: ChatMessage[] = [user("do a thing")];
    msgs = applyOutbound(msgs, frame("step 1", { _progress: true }));
    msgs = applyOutbound(msgs, frame("🎯 Steer noted", { _notice: true }));
    msgs = applyOutbound(msgs, frame("step 2", { _progress: true }));

    // The turn resumes in a FRESH bubble; the ack sits between the two.
    expect(msgs.map((m) => m.content)).toEqual([
      "do a thing",
      "step 1",
      "🎯 Steer noted",
      "step 2",
    ]);
    expect(msgs.map((m) => Boolean(m.notice))).toEqual([false, false, true, false]);
    expect(msgs[3].progress).toBe(true);

    // ...and the turn's final reply still finalises that fresh bubble.
    const done = applyOutbound(msgs, frame("done", { _final: true }));
    expect(done.map((m) => m.content)).toEqual([
      "do a thing",
      "step 1",
      "🎯 Steer noted",
      "done",
    ]);
    expect(done[2].notice).toBe(true);
  });

  it("appends a standalone /stop notice", () => {
    const out = applyOutbound([user("/stop")], frame("⏹ Stopped 1 task(s).", { _notice: true }));
    expect(out[1]).toMatchObject({ notice: true, content: "⏹ Stopped 1 task(s)." });
  });

  it("does not merge a notice into a live (progress) bubble", () => {
    let msgs: ChatMessage[] = [applyOutbound([], frame("working", { _progress: true }))[0]];
    msgs = applyOutbound(msgs, frame("no-op notice", { _notice: true }));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("working");
    expect(msgs[1].notice).toBe(true);
  });
});

describe("applyOutbound — unchanged streaming behaviour", () => {
  it("replaces the live bubble's text on progress", () => {
    let msgs = applyOutbound([user("hi")], frame("he", { _progress: true }));
    msgs = applyOutbound(msgs, frame("hello", { _progress: true }));
    expect(msgs.map((m) => m.content)).toEqual(["hi", "hello"]);
    expect(msgs).toHaveLength(2);
  });

  it("finalises a progress bubble in place", () => {
    let msgs = applyOutbound([user("hi")], frame("partial", { _progress: true }));
    msgs = applyOutbound(msgs, frame("final answer", { _final: true }));
    expect(msgs.map((m) => m.content)).toEqual(["hi", "final answer"]);
    expect(msgs[1]).toMatchObject({ progress: false });
  });

  it("appends a fresh bubble for a final with no prior progress", () => {
    const msgs = applyOutbound([user("/new")], frame("New session started.", { _final: true }));
    expect(msgs.map((m) => m.content)).toEqual(["/new", "New session started."]);
    expect(msgs[1].progress).toBeUndefined();
  });

  it("folds thinking into the live bubble", () => {
    let msgs = applyOutbound([user("hi")], frame("hmm", { _thinking: true }));
    msgs = applyOutbound(msgs, frame("hmm, more", { _thinking: true }));
    expect(msgs).toHaveLength(2);
    expect(msgs[1].thinkingContent).toBe("hmm, more");
  });

  it("accumulates tool hints on the live bubble", () => {
    let msgs = applyOutbound([user("hi")], frame("", { _tool_hint: "exec" }));
    msgs = applyOutbound(msgs, frame("", { _tool_hint: "read" }));
    expect(msgs).toHaveLength(2);
    expect(msgs[1].toolHints).toEqual(["exec", "read"]);
  });

  it("concatenates a plain follow-up frame onto a settled bubble", () => {
    let msgs = applyOutbound([user("hi")], frame("first", { _final: true }));
    msgs = applyOutbound(msgs, frame(" second"));
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe("first second");
  });
});

/**
 * The shared transcript reducer — desktop/mobile parity on slash-command acks.
 *
 * Regression this pins: the `/stop`, `/steer` and `/btw` acks are published
 * out-of-band and used to land in the fallback path, where the turn's next
 * `_progress` frame overwrote them. Telegram shows each ack as its own message,
 * so the dashboard ended up with no ack at all.
 */
import { describe, it, expect } from "vitest";

import { applyOutbound, deriveLiveTurnStatus, LIVE_FALLBACK_LABEL } from "@/lib/transcript";
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

/**
 * Spec 131 §C/§D — sealed prose.
 *
 * The loop publishes a `_seal` frame when a tool-call iteration carried genuine
 * reply text ("Noted — I'll remember that." + a memory write). That text must
 * survive the turn's `_final`, and a turn that ends this way shows exactly two
 * bubbles — never one per tool call.
 */
describe("applyOutbound — sealed prose (spec 131 §C)", () => {
  it("seals the live bubble in place when the prose already streamed in", () => {
    let msgs = applyOutbound([user("remember tea")], frame("Not", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Noted — I will remember that.", { _progress: true, _seal: true, turn_id: "T" }));

    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({
      content: "Noted — I will remember that.",
      sealed: true,
      progress: false,
    });
  });

  it("appends a sealed bubble when nothing streamed first (non-streaming turn)", () => {
    const msgs = applyOutbound(
      [user("remember tea")],
      frame("Noted — I will remember that.", { _progress: true, _seal: true, turn_id: "T" }),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ sealed: true, progress: false, turnId: "T" });
  });

  it("answer + memory-log tool call yields EXACTLY two bubbles", () => {
    // The real frame sequence: reasoning, streamed prose, sealed prose,
    // tool hint, then the turn's final.
    let msgs = applyOutbound([user("remember tea")], frame("Let me note that.", { _thinking: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Noted", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Noted — I will remember that you like tea.", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('memory_log("tea")', { _progress: true, _tool_hint: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Anything else?", { _final: true, turn_id: "T" }));

    expect(msgs).toHaveLength(3); // user + sealed answer + follow-up final
    expect(msgs[1]).toMatchObject({
      content: "Noted — I will remember that you like tea.",
      sealed: true,
      thinkingContent: "Let me note that.",
    });
    expect(msgs[2]).toMatchObject({ content: "Anything else?" });
    expect(msgs[2].progress).toBeFalsy();
    expect(msgs[2].sealed).toBeUndefined();

    // The loop sends `_tool_hint: true` with the hint text in `content`. It
    // must ride the sealed bubble's thinking section, never become the message
    // text, and never mint a bubble of its own.
    expect(msgs[1].toolHints).toEqual(['memory_log("tea")']);
    expect(msgs.some((m) => m.content.includes("memory_log"))).toBe(false);

    // One bubble per PROSE-bearing iteration — the tool call adds no bubble.
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("gives each bubble of a turn a unique id (React key)", () => {
    let msgs = applyOutbound([user("go")], frame("A", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("B", { _final: true, turn_id: "T" }));
    const ids = msgs.filter((m) => m.role === "assistant").map((m) => m.bubbleId);
    expect(ids).toEqual(["T#0", "T#1"]);
    expect(new Set(ids).size).toBe(2);
  });

  it("further streamed prose after a seal opens a fresh bubble", () => {
    let msgs = applyOutbound([user("go")], frame("sealed", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("live", { _progress: true, turn_id: "T" }));
    expect(msgs.map((m) => m.content)).toEqual(["go", "sealed", "live"]);
    expect(msgs[1].sealed).toBe(true);
    expect(msgs[2].progress).toBe(true);
  });

  it("a reasoning-only turn produces no message bubble", () => {
    let msgs = applyOutbound([user("do it")], frame("monologue", { _thinking: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("monologue grows", { _thinking: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('memory_log("x")', { _progress: true, _tool_hint: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Done.", { _final: true, turn_id: "T" }));

    // The turn's single assistant bubble hosts the thinking collapse and the
    // final answer; the monologue is NEVER the message text.
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({
      content: "Done.",
      thinkingContent: "monologue grows",
      progress: false,
    });
    expect(msgs[1].toolHints).toEqual(['memory_log("x")']);
    expect(msgs.some((m) => m.content.includes("monologue"))).toBe(false);
  });

  it("a late _thinking frame after a seal does NOT create a third bubble", () => {
    let msgs = applyOutbound([user("go")], frame("answer", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("final", { _final: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("one more thought", { _thinking: true, turn_id: "T" }));
    expect(msgs).toHaveLength(3);
    expect(msgs[2].thinkingContent).toBe("one more thought");
    expect(msgs[2].content).toBe("final");
  });

  it("a late tool hint after a seal folds into the turn's last bubble", () => {
    let msgs = applyOutbound([user("go")], frame("answer", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("final", { _final: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('exec("ls")', { _progress: true, _tool_hint: true, turn_id: "T" }));

    // Two bubbles stay two bubbles — the hint attaches to the live one.
    expect(msgs).toHaveLength(3);
    expect(msgs[2].toolHints).toEqual(['exec("ls")']);
    expect(msgs[1].toolHints).toBeUndefined();
  });

  it("a sealed bubble is never merged into by a turn-less frame", () => {
    // Legacy frames with no turn_id: the seal still blocks the merge.
    let msgs = applyOutbound([user("go")], frame("sealed", { _progress: true, _seal: true }));
    msgs = applyOutbound(msgs, frame("final", { _final: true }));
    expect(msgs.map((m) => m.content)).toEqual(["go", "sealed", "final"]);
  });
});

/**
 * Spec 131 §F — unchanged streaming behaviour.
 */
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

/**
 * Spec 127 §C.4 — bubbles are keyed by the server `turn_id`, so all frames of
 * one turn fold into ONE bubble regardless of reconnect timing, and a turn
 * never merges into a neighbouring turn's bubble.
 */
describe("applyOutbound — turn_id keying (spec 127 §C.4)", () => {
  it("folds every frame of one turn_id into a single bubble", () => {
    let msgs = applyOutbound([user("hi")], frame("a", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("ab", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("abc", { _final: true, turn_id: "T" }));
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ content: "abc", progress: false, turnId: "T" });
  });

  it("keeps two different turns in separate bubbles", () => {
    let msgs = applyOutbound([user("q1")], frame("A", { _progress: true, turn_id: "T1" }));
    msgs = applyOutbound(msgs, frame("A done", { _final: true, turn_id: "T1" }));
    // User turns are appended directly by the SPA, not through the frame reducer.
    msgs = [...msgs, user("q2")];
    msgs = applyOutbound(msgs, frame("B", { _progress: true, turn_id: "T2" }));

    expect(msgs.map((m) => m.content)).toEqual(["q1", "A done", "q2", "B"]);
    expect(msgs[1].turnId).toBe("T1");
    expect(msgs[3].turnId).toBe("T2");
  });

  it("a _thinking frame after _final does NOT create a second bubble", () => {
    let msgs = applyOutbound([user("hi")], frame("answer", { _final: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("late thought", { _thinking: true, turn_id: "T" }));
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ content: "answer", thinkingContent: "late thought" });
  });

  it("a _thinking frame after _final (no turn_id) still folds", () => {
    let msgs = applyOutbound([user("hi")], frame("answer", { _final: true }));
    msgs = applyOutbound(msgs, frame("late thought", { _thinking: true }));
    expect(msgs).toHaveLength(2);
    expect(msgs[1].thinkingContent).toBe("late thought");
  });

  it("attaches a media outbound to its turn's streaming bubble", () => {
    const mediaFrame: OutboundMessage = {
      type: "message",
      channel: "dashboard",
      chatId: "console",
      content: "here is your note",
      media: ["/home/u/.sarathy/media/a.mp3"],
      replyTo: null,
      metadata: { turn_id: "T" },
    };
    let msgs = applyOutbound([user("say it")], frame("", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, mediaFrame);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ turnId: "T", media: ["/home/u/.sarathy/media/a.mp3"] });
  });
});

/**
 * Spec 134 §B — the live "working" strip narrates the image→VLM pipeline.
 *
 * The regression this pins: the loop narrates each phase through ordinary
 * `_tool_hint` frames (prep → send to VLM → description received), the reducer
 * folds them into the turn bubble's `toolHints`, and the ONLY thing that ever
 * displayed them was the collapsed Thinking section — so while the image was
 * being described, the dashboard showed a shimmering "Thinking" header and
 * nothing else. Telegram prints the same strings in its streaming draft.
 *
 * `deriveLiveTurnStatus` is the one place that decision is made; both SPAs
 * consume it, so this test also pins the parity.
 */
describe("deriveLiveTurnStatus — live pipeline narration (spec 134 §B)", () => {
  /** The exact frame shape `_bus_progress(label, tool_hint=True)` publishes. */
  const phase = (label: string) =>
    frame(label, { _progress: true, _tool_hint: true, turn_id: "T" });

  it("falls back to the generic label while the turn has produced nothing yet", () => {
    expect(deriveLiveTurnStatus([user("what's in this photo?")])).toEqual({
      label: LIVE_FALLBACK_LABEL,
      showChip: true,
    });
  });

  it("returns null for an empty transcript", () => {
    expect(deriveLiveTurnStatus([])).toBeNull();
  });

  it("reads the newest _tool_hint frame as the live label", () => {
    let msgs = applyOutbound([user("look")], phase("🔍 Sending image to VLM…"));
    expect(deriveLiveTurnStatus(msgs)).toEqual({
      label: "🔍 Sending image to VLM…",
      showChip: false,
    });
  });

  it("narrates the whole image→VLM pipeline phase by phase", () => {
    let msgs = applyOutbound([user("what's in this photo?")], phase("🖼️ Preparing image…"));
    const seen: (string | null)[] = [deriveLiveTurnStatus(msgs)?.label ?? null];

    msgs = applyOutbound(msgs, phase("🔍 Sending image to VLM…"));
    seen.push(deriveLiveTurnStatus(msgs)?.label ?? null);

    msgs = applyOutbound(msgs, phase("✅ Image description received"));
    seen.push(deriveLiveTurnStatus(msgs)?.label ?? null);

    // The answer starts streaming in: the phase is history, the bubble speaks.
    msgs = applyOutbound(msgs, frame("A tabby cat on a…", { _progress: true, turn_id: "T" }));
    seen.push(deriveLiveTurnStatus(msgs)?.label ?? null);

    expect(seen).toEqual([
      "🖼️ Preparing image…",
      "🔍 Sending image to VLM…",
      "✅ Image description received",
      null,
    ]);
  });

  it("keeps narrating when a /steer notice bubble lands mid-pipeline", () => {
    let msgs = applyOutbound([user("look")], phase("🔍 Sending image to VLM…"));
    // Out-of-band ack: its own sealed bubble, appended AFTER the live one.
    msgs = applyOutbound(msgs, frame("🎯 Steer noted", { _notice: true }));
    expect(msgs[msgs.length - 1].notice).toBe(true);
    expect(deriveLiveTurnStatus(msgs)).toEqual({
      label: "🔍 Sending image to VLM…",
      showChip: false,
    });
  });

  it("narrates a tool call like any other phase", () => {
    let msgs = applyOutbound([user("search that")], phase("web_search(\"weather\")"));
    expect(deriveLiveTurnStatus(msgs)?.label).toBe("web_search(\"weather\")");
  });

  it("says nothing once the turn is finished", () => {
    let msgs = applyOutbound([user("look")], phase("🔍 Sending image to VLM…"));
    msgs = applyOutbound(msgs, frame("A cat.", { _final: true, turn_id: "T" }));
    expect(deriveLiveTurnStatus(msgs)).toBeNull();
  });

  it("never leaks the PREVIOUS turn's last hint into a fresh turn", () => {
    let msgs = applyOutbound([user("look")], phase("🔍 Sending image to VLM…"));
    msgs = applyOutbound(msgs, frame("A cat.", { _final: true, turn_id: "T" }));
    // New question sent: the transcript ends on the user's message.
    msgs = [...msgs, user("and this one?")];
    expect(deriveLiveTurnStatus(msgs)).toEqual({
      label: LIVE_FALLBACK_LABEL,
      showChip: true,
    });
  });
});

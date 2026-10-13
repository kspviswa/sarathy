/**
 * The shared transcript reducer — desktop/mobile parity on slash-command acks.
 *
 * Regression this pins: the `/stop`, `/steer` and `/btw` acks are published
 * out-of-band and used to land in the fallback path, where the turn's next
 * `_progress` frame overwrote them. Telegram shows each ack as its own message,
 * so the dashboard ended up with no ack at all.
 */
import { describe, it, expect } from "vitest";

import {
  applyOutbound,
  deriveLiveTurnStatus,
  formatTurnDuration,
  LIVE_FALLBACK_LABEL,
  summarizeToolHint,
  turnSegments,
  turnStepCount,
} from "@/lib/transcript";
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
 * Spec 131 §C/§D + spec 135 §A — sealed prose in ONE bubble.
 *
 * The loop publishes a `_seal` frame when a tool-call iteration carried genuine
 * reply text ("Noted — I'll remember that." + a memory write). That text must
 * survive the turn's `_final`, and the whole turn must stay ONE assistant
 * bubble: each sealed iteration COMMITS a segment of the turn's bubble and the
 * final answer is its LAST segment. Before spec 135 a turn with three tool
 * calls rendered as three bubbles ("I don't want a second bubble").
 */
describe("applyOutbound — sealed prose, one bubble per turn (spec 131 §C / 135 §A)", () => {
  it("seals the live segment in place when the prose already streamed in", () => {
    let msgs = applyOutbound([user("remember tea")], frame("Not", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Noted — I will remember that.", { _progress: true, _seal: true, turn_id: "T" }));

    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({
      content: "Noted — I will remember that.",
      sealed: true,
      progress: false,
    });
    expect(turnSegments(msgs[1])).toEqual([
      { text: "Noted — I will remember that.", sealed: true },
    ]);
  });

  it("appends a sealed bubble when nothing streamed first (non-streaming turn)", () => {
    const msgs = applyOutbound(
      [user("remember tea")],
      frame("Noted — I will remember that.", { _progress: true, _seal: true, turn_id: "T" }),
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ sealed: true, progress: false, turnId: "T" });
    expect(turnSegments(msgs[1])).toEqual([
      { text: "Noted — I will remember that.", sealed: true },
    ]);
  });

  it("answer + memory-log tool call yields EXACTLY ONE bubble with two segments", () => {
    // The real frame sequence: reasoning, streamed prose, sealed prose,
    // tool hint, then the turn's final.
    let msgs = applyOutbound([user("remember tea")], frame("Let me note that.", { _thinking: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Noted", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Noted — I will remember that you like tea.", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('memory_log("tea")', { _progress: true, _tool_hint: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Anything else?", { _final: true, turn_id: "T" }));

    // ONE assistant bubble for the whole turn — the spec-135 headline.
    expect(msgs).toHaveLength(2);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);

    // The prose is two ordered segments in the SAME bubble: the sealed reply and
    // the follow-up answer, which is what the trail divider draws between.
    expect(turnSegments(msgs[1])).toEqual([
      { text: "Noted — I will remember that you like tea.", sealed: true },
      { text: "Anything else?", sealed: true },
    ]);
    // `content` mirrors them joined, so copy/media/`deriveLiveTurnStatus` still
    // see the whole answer.
    expect(msgs[1].content).toBe("Noted — I will remember that you like tea.\n\nAnything else?");
    expect(msgs[1].progress).toBeFalsy();

    // Reasoning + the tool call ride the same bubble's collapse header.
    expect(msgs[1].thinkingContent).toBe("Let me note that.");
    expect(msgs[1].toolHints).toEqual(['memory_log("tea")']);
    expect(msgs.some((m) => m.content.includes("memory_log"))).toBe(false);
  });

  it("a turn with THREE tool-call iterations is still one bubble, three segments", () => {
    let msgs = applyOutbound([user("go")], frame("step one", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("step one", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('exec("ls")', { _tool_hint: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("step two", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("step two", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('exec("pwd")', { _tool_hint: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("all done", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("all done", { _final: true, turn_id: "T" }));

    // The regression this pins: pre-135 this rendered as three bubbles.
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(turnSegments(msgs[1])).toEqual([
      { text: "step one", sealed: true },
      { text: "step two", sealed: true },
      { text: "all done", sealed: true },
    ]);
    expect(msgs[1].toolHints).toEqual(['exec("ls")', 'exec("pwd")']);
    expect(turnStepCount(msgs[1])).toBe(2);
  });

  it("gives each bubble of a turn a unique id (React key)", () => {
    let msgs = applyOutbound([user("go")], frame("A", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("B", { _final: true, turn_id: "T" }));
    const ids = msgs.filter((m) => m.role === "assistant").map((m) => m.bubbleId);
    expect(ids).toEqual(["T#0"]);
    expect(new Set(ids).size).toBe(1);
  });

  it("further streamed prose after a seal appends a SEGMENT, not a bubble", () => {
    let msgs = applyOutbound([user("go")], frame("sealed", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("live", { _progress: true, turn_id: "T" }));

    expect(msgs).toHaveLength(2);
    expect(turnSegments(msgs[1])).toEqual([
      { text: "sealed", sealed: true },
      { text: "live", sealed: false },
    ]);
  });

  it("rewrites the OPEN segment frame by frame (streamed text is cumulative)", () => {
    let msgs = applyOutbound([user("hi")], frame("Hel", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Hello", { _progress: true, turn_id: "T" }));
    expect(turnSegments(msgs[1])).toEqual([{ text: "Hello", sealed: false }]);
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
    expect(turnSegments(msgs[1])).toEqual([{ text: "Done.", sealed: true }]);
    expect(msgs[1].toolHints).toEqual(['memory_log("x")']);
    expect(msgs.some((m) => m.content.includes("monologue"))).toBe(false);
  });

  it("a late _thinking frame after a seal does NOT create a second bubble", () => {
    let msgs = applyOutbound([user("go")], frame("answer", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("final", { _final: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("one more thought", { _thinking: true, turn_id: "T" }));

    expect(msgs).toHaveLength(2);
    expect(msgs[1].thinkingContent).toBe("one more thought");
    expect(turnSegments(msgs[1])).toEqual([
      { text: "answer", sealed: true },
      { text: "final", sealed: true },
    ]);
  });

  it("a late tool hint after a seal folds into the SAME bubble", () => {
    let msgs = applyOutbound([user("go")], frame("answer", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("final", { _final: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('exec("ls")', { _progress: true, _tool_hint: true, turn_id: "T" }));

    expect(msgs).toHaveLength(2);
    expect(msgs[1].toolHints).toEqual(['exec("ls")']);
    expect(msgs[1].content).not.toContain("memory_log");
  });

  it("a sealed bubble is never merged into by a turn-less frame", () => {
    // Legacy frames with no turn_id: the seal still blocks the merge. Turn-less
    // frames predate `turn_id`, so they keep the pre-135 bubble behaviour —
    // every live dashboard turn is turn_id-stamped (loop.py mints it up front).
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

/**
 * Spec 135 §A — the read side both SPAs render from.
 *
 * `turnSegments` is what decides where a turn's prose ends, so both surfaces
 * read the turn the same way; `summarizeToolHint` is what turns the loop's one
 * hint string per batch into the chips the collapse shows.
 */
describe("turnSegments — the read side of one bubble (spec 135 §A)", () => {
  it("reads a stored (pre-135) assistant message as one finished segment", () => {
    // What `/api/session/archive` returns: role + content, no segments.
    const stored: ChatMessage = { role: "assistant", content: "A tabby cat." };
    expect(turnSegments(stored)).toEqual([{ text: "A tabby cat.", sealed: true }]);
  });

  it("is empty for a live turn that has only narrated so far", () => {
    // The empty state: the bubble is the single slim header row (no segments).
    let msgs = applyOutbound(
      [user("what's in this photo?")],
      frame("🖼️ Preparing image…", { _progress: true, _tool_hint: true, turn_id: "T" }),
    );
    expect(turnSegments(msgs[1])).toEqual([]);
    expect(msgs[1].content).toBe("");
  });

  it("keeps segment order stable across a full tool-calling turn", () => {
    let msgs = applyOutbound([user("go")], frame("Looking…", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Looking…", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('read_file("a.py")', { _tool_hint: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("It says hi.", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Anything else?", { _final: true, turn_id: "T" }));

    expect(turnSegments(msgs[1]).map((s) => s.text)).toEqual([
      "Looking…",
      "It says hi.",
      "Anything else?",
    ]);
  });

  it("never emits a blank segment", () => {
    // A tool-call iteration with no prose at all seals nothing.
    let msgs = applyOutbound([user("go")], frame("", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Done.", { _final: true, turn_id: "T" }));
    expect(turnSegments(msgs[1])).toEqual([{ text: "Done.", sealed: true }]);
  });
});

describe("turnStepCount + formatTurnDuration — the header's meta (spec 135 §A)", () => {
  it("counts tool calls, not reasoning frames", () => {
    const m: ChatMessage = {
      role: "assistant",
      content: "",
      thinkingContent: "a long monologue",
      toolHints: ['exec("ls")', 'exec("pwd")'],
    };
    expect(turnStepCount(m)).toBe(2);
    expect(turnStepCount({ role: "assistant", content: "" })).toBe(0);
  });

  it("formats the duration the way the header shows it", () => {
    expect(formatTurnDuration(0)).toBe("0s");
    expect(formatTurnDuration(3_400)).toBe("3s");
    expect(formatTurnDuration(59_000)).toBe("59s");
    expect(formatTurnDuration(60_000)).toBe("1m 0s");
    expect(formatTurnDuration(134_000)).toBe("2m 14s");
  });
});

describe("summarizeToolHint — tool calls as chips (spec 135 §A)", () => {
  it("splits a batched hint into one chip per call", () => {
    expect(summarizeToolHint('read_file("a.py"), memory_log("tea")')).toEqual([
      { name: "read_file", summary: "a.py", hint: 'read_file("a.py"), memory_log("tea")' },
      { name: "memory_log", summary: "tea", hint: 'read_file("a.py"), memory_log("tea")' },
    ]);
  });

  it("handles an unquoted argument and a call with none", () => {
    expect(summarizeToolHint("web_search(weather)")).toEqual([
      { name: "web_search", summary: "weather", hint: "web_search(weather)" },
    ]);
    expect(summarizeToolHint("list_sessions()")).toEqual([
      { name: "list_sessions", summary: "", hint: "list_sessions()" },
    ]);
  });

  it("keeps a narrated phase (job 134) as one unnamed chip", () => {
    // Not a tool call at all — must survive as text, never as a broken chip.
    expect(summarizeToolHint("🖼️ Preparing image…")).toEqual([
      { name: "", summary: "🖼️ Preparing image…", hint: "🖼️ Preparing image…" },
    ]);
    expect(summarizeToolHint("")).toEqual([]);
  });

  it("truncates a runaway argument instead of wrapping the header", () => {
    const [chip] = summarizeToolHint(`echo("${"x".repeat(200)}")`);
    expect(chip.name).toBe("echo");
    expect(chip.summary.length).toBeLessThanOrEqual(49);
    expect(chip.summary.endsWith("…")).toBe(true);
  });
});

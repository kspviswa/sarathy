/**
 * Spec 139 §A — a settled turn shows its ANSWER; the monologue tucks away.
 *
 * Viswa, after seeing the live packing: "I'd like telegram parity. Because once
 * the turn is over I'm not that concerned about monologues."
 *
 * On Telegram the monologue is a draft: you watch it stream, and when the turn
 * ends the draft is discarded so only the answer remains. The dashboard keeps
 * the record, so here the monologue moves out of the bubble's prose and into the
 * collapse — a finished turn reads as its answer, and nothing is lost.
 *
 * Spec 139 §B (the reload half, where a turn used to come back as a dozen
 * bubbles) is pinned in `transcript.test.ts` and `lastSession.test.tsx`.
 *
 * Frames run through the REAL reducer, so a regression there shows up here too.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import React from "react";

import { applyOutbound } from "@/lib/transcript";
import type { ChatMessage } from "@/views/ChatView";
import type { OutboundMessage } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn(),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
  Toaster: () => null,
}));

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => <div data-testid="logo" data-size={size} />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild: _asChild, ...props }: any) =>
    React.cloneElement(children, props),
  TooltipContent: () => null,
}));

import { ThinkingSection } from "@/components/ThinkingSection";
import { ChatView as DesktopChatView } from "@/views/ChatView";
import { ChatView as MobileChatView } from "@/mobile/ChatView";

const props = { onSend: vi.fn(), onStop: vi.fn(), onNewChat: vi.fn() };

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

const NOTES = [
  "Now the failing test that pins the defect:",
  "Green. Now the full suite:",
];
const ANSWER = "Fixed and live, sir.";

/** The monologue of a tool-calling turn, and its answer — the turn is DONE. */
function settledTurn(): ChatMessage[] {
  let msgs: ChatMessage[] = [{ role: "user", content: "fix the bug" }];
  msgs = applyOutbound(msgs, frame(NOTES[0], { _progress: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame(NOTES[0], { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('write_file("x.test.tsx")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame(NOTES[1], { _progress: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame(NOTES[1], { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('shell("npm test")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame(ANSWER, { _final: true, turn_id: "T" }));
  return msgs;
}

/** The same turn, still RUNNING: the trailing segment has not been committed. */
function midTurn(): ChatMessage[] {
  let msgs: ChatMessage[] = [{ role: "user", content: "fix the bug" }];
  msgs = applyOutbound(msgs, frame(NOTES[0], { _progress: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame(NOTES[0], { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('write_file("x.test.tsx")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame(NOTES[1], { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('shell("npm test")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("Now the build and the live check:", { _progress: true, turn_id: "T" }));
  return msgs;
}

function expandCollapse() {
  fireEvent.click(screen.getByTestId("thinking-toggle"));
}

describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>],
  ["mobile", MobileChatView as React.ComponentType<any>],
])("%s — a settled turn shows its answer (spec 139 §A)", (_name, View) => {
  it("while the turn is LIVE the monologue streams inline, as notes", () => {
    render(<View {...props} streaming messages={midTurn()} />);

    const notes = screen.getByTestId("trail-notes");
    expect(within(notes).getAllByTestId("trail-note")).toHaveLength(2);
    // The live edge is prose, not a note: nobody knows yet whether it is the
    // reply, and the caret rides it.
    const answer = screen.getByTestId("trail-answer");
    expect(within(answer).getByText("Now the build and the live check:")).toBeInTheDocument();
    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(1);
  });

  it("once it SETTLES the bubble shows the answer alone", () => {
    render(<View {...props} streaming={false} messages={settledTurn()} />);

    expect(screen.queryByTestId("trail-notes")).toBeNull();
    const segments = screen.getByTestId("assistant-turn-segments");
    expect(within(segments).getByText(ANSWER)).toBeInTheDocument();
    // The monologue is nowhere in the bubble's prose any more.
    expect(within(segments).queryByText(NOTES[0])).toBeNull();
    expect(within(segments).queryByText(NOTES[1])).toBeNull();
  });

  it("and the monologue is not lost — it moves into the collapse", () => {
    render(<View {...props} streaming={false} messages={settledTurn()} />);

    // Collapsed by default, so it never competes with the answer…
    expect(screen.queryByTestId("thinking-notes")).toBeNull();
    expandCollapse();
    const tucked = screen.getByTestId("thinking-notes");
    expect(within(tucked).getAllByTestId("trail-note")).toHaveLength(2);
    expect(within(tucked).getByText(NOTES[0])).toBeInTheDocument();
    expect(within(tucked).getByText(NOTES[1])).toBeInTheDocument();
  });

  it("keeps the thinking collapse, with its steps and duration", () => {
    render(<View {...props} streaming={false} messages={settledTurn()} />);

    expect(screen.getAllByTestId("thinking-toggle")).toHaveLength(1);
    // Spec 140 §A: the label reports the turn's length, not a status word with
    // a completion tick beside it. The reducer stamped the duration.
    expect(screen.getByTestId("thinking-label")).toHaveTextContent(/^Thought for \d+s$/);
    expect(screen.getByTestId("thinking-meta")).toHaveTextContent("2 steps");
  });

  it("draws no trail divider once settled — there is one prose block", () => {
    render(<View {...props} streaming={false} messages={settledTurn()} />);
    expect(screen.queryAllByTestId("trail-divider")).toHaveLength(0);
  });

  it("is still ONE bubble, however many iterations the turn took", () => {
    render(<View {...props} streaming={false} messages={settledTurn()} />);
    expect(screen.getAllByTestId("message-row-assistant")).toHaveLength(1);
  });

  it("keeps the prose inline when a settled turn has no answer of its own", () => {
    // A turn that ended without a `_final` (voice reply, `/stop`): hiding the
    // prose would leave an empty bubble, so it stays.
    let msgs: ChatMessage[] = [{ role: "user", content: "go" }];
    msgs = applyOutbound(msgs, frame("Halfway through.", { _progress: true, _seal: true, turn_id: "T" }));
    render(<View {...props} streaming={false} messages={msgs} />);

    const segments = screen.getByTestId("assistant-turn-segments");
    expect(within(segments).getByText("Halfway through.")).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-notes")).toBeNull();
  });

  it("shows a plain Q&A turn as one prose block throughout", () => {
    let msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    msgs = applyOutbound(msgs, frame("Hello, sir.", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Hello, sir.", { _final: true, turn_id: "T" }));
    render(<View {...props} streaming={false} messages={msgs} />);

    expect(screen.queryByTestId("trail-notes")).toBeNull();
    expect(screen.getAllByTestId("trail-answer")).toHaveLength(1);
    expect(screen.queryAllByTestId("trail-divider")).toHaveLength(0);
  });
});

/**
 * The split must not be re-implemented per surface — the same structural guard
 * the one-bubble spec uses.
 */
describe("the split lives in the shared module", () => {
  it("is decided by turnSegments/splitTurnDisplay, not by either ChatView", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    for (const view of ["src/views/ChatView.tsx", "src/mobile/ChatView.tsx"]) {
      const src = fs.readFileSync(view, "utf-8");
      expect(src).toContain("splitTurnDisplay");
      // Neither surface may hand-roll the note/answer decision.
      expect(src).not.toContain('kind === "note"');
      expect(src).not.toContain("kind: \"note\"");
    }
    const shared = fs.readFileSync("src/lib/transcript.ts", "utf-8");
    expect(shared).toContain("export function splitTurnDisplay");
    expect(shared).toContain("export function splitTurnProse");
  });
});

/**
 * A collapse rebuilt from the session file has no steps and no reasoning, only
 * the tucked monologue — so it must not invent a duration (the "3s" it would
 * report is time-since-mount, not time-on-turn).
 */
describe("a stored turn's collapse reports nothing it does not know", () => {
  it("omits the meta row when there are no steps to report", () => {
    render(
      <ThinkingSection
        toolHints={[]}
        thinkingContent=""
        notes={[{ text: "Now the failing test that pins the defect:", sealed: true, kind: "note" }]}
        done
      />,
    );
    expect(screen.getByTestId("thinking-label")).toHaveTextContent("Thought");
    expect(screen.queryByTestId("thinking-meta")).toBeNull();
  });

  it("carries the step count, and no invented duration, when steps are known", () => {
    render(<ThinkingSection toolHints={["read_file a.ts"]} thinkingContent="" done />);
    expect(screen.getByTestId("thinking-meta")).toHaveTextContent("1 step");
    expect(screen.getByTestId("thinking-meta")).not.toHaveTextContent("s ·");
  });
});

/**
 * A turn whose iterations never narrated has no monologue to tuck — and no
 * steps or reasoning either, once rebuilt from the session file. Its "Thinking"
 * chevron would expand to nothing, so it must not be drawn at all.
 */
describe("a settled turn with nothing to reveal draws no dead toggle", () => {
  it("omits the row when a settled turn has no notes, chips or reasoning", () => {
    let msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    msgs = applyOutbound(msgs, frame("Hello, sir.", { _final: true, turn_id: "T" }));
    render(<DesktopChatView {...props} streaming={false} messages={msgs} />);

    expect(screen.queryByTestId("thinking-toggle")).toBeNull();
    expect(screen.getByText("Hello, sir.")).toBeInTheDocument();
  });

  it("still draws it while that same turn is LIVE — it is the status row", () => {
    let msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    msgs = applyOutbound(msgs, frame("Hello, sir.", { _progress: true, turn_id: "T" }));
    render(<DesktopChatView {...props} streaming messages={msgs} />);

    // No tool hints and no reasoning yet, so there is nothing to expand — the
    // row is the turn's status line, not a chevron onto nothing.
    expect(screen.getByTestId("thinking-status")).toHaveTextContent("Thinking");
    expect(screen.queryByTestId("thinking-toggle")).toBeNull();
    expect(screen.getByTestId("assistant-turn-segments")).toBeInTheDocument();
  });
});

/**
 * A live turn's bubble with nothing to reveal yet still needs the slim status
 * row (spec 135 §A) — but a chevron that opens onto nothing is a dead control.
 * A page reloaded mid-turn is exactly this: the turn is live, and the API gave
 * it no tool hints, so there is nothing to expand.
 */
describe("the slim row is a status line when there is nothing to reveal", () => {
  it("draws no chevron for a live turn with nothing to expand", () => {
    render(<ThinkingSection toolHints={[]} thinkingContent="" done={false} alwaysShow />);
    expect(screen.getByTestId("thinking-status")).toHaveTextContent("Thinking");
    expect(screen.queryByTestId("thinking-toggle")).toBeNull();
    expect(screen.queryByTestId("thinking-body")).toBeNull();
  });

  it("is a real toggle as soon as there is something to reveal", () => {
    render(<ThinkingSection toolHints={["🔍 Sending image to VLM…"]} thinkingContent="" alwaysShow />);
    expect(screen.getByTestId("thinking-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-status")).toBeNull();
  });
});

/**
 * Spec 135 §A follow-up — the live treatment belongs to the LIVE bubble only.
 *
 * Viswa's report, verbatim: "When you are in thinking mode, it is applied to all
 * bubbles even previous finished assistant response bubbles too. Also the carrot
 * is blinking on the previous finished bubble too."
 *
 * Root cause: `streaming` is session-wide (one turn at a time), and both SPAs
 * read it directly — `live = streaming || message.progress` — so every assistant
 * bubble on screen got the live affordances: the pulsing dots + shimmering
 * "Thinking" label in its header, a duration that kept counting, and (when a
 * turn ended without a `_final` frame — voice replies, `/stop`) a caret that
 * blinked on a finished answer forever, because its trailing segment was never
 * sealed.
 *
 * The frames run through the REAL reducer (`applyOutbound`), so a regression in
 * the reducer shows up here too.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

import { ChatView as DesktopChatView } from "@/views/ChatView";
import { ChatView as MobileChatView } from "@/mobile/ChatView";

const props = {
  onSend: vi.fn(),
  onStop: vi.fn(),
  onNewChat: vi.fn(),
};

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

/** A finished turn (its own bubble, fully sealed) followed by a live turn. */
function finishedThenLive(): ChatMessage[] {
  let msgs: ChatMessage[] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "First answer." },
    { role: "user", content: "second question" },
  ];
  msgs = applyOutbound(msgs, frame("Working on it.", { _progress: true, turn_id: "T2" }));
  return msgs;
}

describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>],
  ["mobile", MobileChatView as React.ComponentType<any>],
])("%s — the live treatment is scoped to the live bubble", (_name, View) => {
  it("pulses only the live bubble, never the finished one above it", () => {
    render(<View {...props} streaming messages={finishedThenLive()} />);

    // One live bubble on screen → exactly one pulse, and it is the second bubble.
    expect(screen.getAllByTestId("message-row-assistant")).toHaveLength(2);
    expect(screen.getAllByTestId("thinking-indicator")).toHaveLength(1);
    const rows = screen.getAllByTestId("message-row-assistant");
    expect(rows[1].querySelector('[data-testid="thinking-indicator"]')).not.toBeNull();
    expect(rows[0].querySelector('[data-testid="thinking-indicator"]')).toBeNull();
  });

  it("leaves the finished bubble's header in its done state", () => {
    render(<View {...props} streaming messages={finishedThenLive()} />);

    // "Done" is the Check + a shimmer-free label, so the finished bubble must
    // not be shimmering while the next turn runs.
    const rows = screen.getAllByTestId("message-row-assistant");
    const finishedLabel = rows[0].querySelector(".thinking-shimmer");
    expect(finishedLabel).toBeNull();
  });

  it("puts the caret on the live bubble's trailing segment only", () => {
    render(<View {...props} streaming messages={finishedThenLive()} />);

    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(1);
    const rows = screen.getAllByTestId("message-row-assistant");
    expect(rows[1].querySelectorAll(".streaming-caret")).toHaveLength(1);
    expect(rows[0].querySelectorAll(".streaming-caret")).toHaveLength(0);
  });

  it("stops the caret when a turn ends with no `_final` frame (voice reply / stop)", () => {
    // The voice-reply path suppresses `_final`, so the trailing segment is never
    // sealed. That alone must not keep a caret blinking on a finished answer.
    let msgs: ChatMessage[] = [{ role: "user", content: "note this" }];
    msgs = applyOutbound(msgs, frame("Here is the note.", { _progress: true, turn_id: "T1" }));
    render(<View {...props} streaming={false} messages={msgs} />);

    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(0);
    expect(screen.queryByTestId("thinking-indicator")).toBeNull();
  });

  it("keeps the caret while that same turn is genuinely still running", () => {
    let msgs: ChatMessage[] = [{ role: "user", content: "note this" }];
    msgs = applyOutbound(msgs, frame("Here is the note.", { _progress: true, turn_id: "T1" }));
    render(<View {...props} streaming messages={msgs} />);

    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(1);
    expect(screen.getAllByTestId("thinking-indicator")).toHaveLength(1);
  });

  it("claims no bubble while the turn has produced nothing yet", () => {
    // The optimistic window: the user just sent, no frame has landed. The strip
    // under the transcript is the status — no finished bubble may light up.
    let msgs: ChatMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "second question" },
    ];
    render(<View {...props} streaming messages={msgs} />);

    expect(screen.queryByTestId("thinking-indicator")).toBeNull();
    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(0);
  });

  it("still pulses the live bubble when a `/steer` ack lands after it", () => {
    // A notice is appended AFTER the turn's bubble mid-turn; the live bubble is
    // still the one it is writing.
    let msgs: ChatMessage[] = [{ role: "user", content: "do it" }];
    msgs = applyOutbound(msgs, frame("Working on it.", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("🎯 Steer noted", { _notice: true }));
    render(<View {...props} streaming messages={msgs} />);

    expect(screen.getAllByTestId("thinking-indicator")).toHaveLength(1);
    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(1);
  });
});

/**
 * Spec 138 §A — the monologue is packed as notes, the answer keeps the prose.
 *
 * Viswa's report, verbatim: "all this except after the 'Fixed and live, sir' is
 * your monologue. It is part of your thinking but still your final partials. In
 * olden view, this would still be streamed but as a partial.. so I know what is
 * happening and then in the end final response. can you make it that way? make
 * sure your current thinking collapse is still good. I also need it. But have a
 * different way to pack these monologues as well."
 *
 * The loop already tells us which half of the turn a segment is: prose shipped
 * ALONGSIDE a tool call (`_seal`) is the monologue, the turn's `_final` is the
 * reply. The reducer used to throw that away, so both rendered as equal-weight
 * prose and the reply was indistinguishable from the process.
 *
 * Frames run through the REAL reducer, so a regression in the reducer shows up
 * here too.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/** The monologue of a tool-calling turn, then the reply. */
function toolTurn(): ChatMessage[] {
  let msgs: ChatMessage[] = [{ role: "user", content: "fix the bug" }];
  msgs = applyOutbound(msgs, frame("Now the failing test that pins the defect:", { _progress: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("Now the failing test that pins the defect:", { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('write_file("x.test.tsx")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("Green. Now the full suite:", { _progress: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("Green. Now the full suite:", { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('shell("npm test")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("Fixed and live, sir.", { _final: true, turn_id: "T" }));
  return msgs;
}

describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>],
  ["mobile", MobileChatView as React.ComponentType<any>],
])("%s — the monologue is packed as notes (spec 138 §A)", (_name, View) => {
  it("packs the monologue into one muted notes block, the reply as prose", () => {
    render(<View {...props} streaming={false} messages={toolTurn()} />);

    const notes = screen.getByTestId("trail-notes");
    expect(within(notes).getAllByTestId("trail-note")).toHaveLength(2);
    expect(within(notes).getByText("Now the failing test that pins the defect:")).toBeInTheDocument();
    expect(within(notes).getByText("Green. Now the full suite:")).toBeInTheDocument();

    // The reply is NOT a note — it is the bubble's prose.
    const answer = screen.getByTestId("trail-answer");
    expect(within(answer).getByText("Fixed and live, sir.")).toBeInTheDocument();
    expect(within(notes).queryByText("Fixed and live, sir.")).toBeNull();
  });

  it("still renders the whole turn as ONE bubble", () => {
    render(<View {...props} streaming={false} messages={toolTurn()} />);
    expect(screen.getAllByTestId("message-row-assistant")).toHaveLength(1);
  });

  it("keeps the thinking collapse — reasoning and tool chips still fold away", () => {
    render(<View {...props} streaming={false} messages={toolTurn()} />);

    expect(screen.getAllByTestId("thinking-toggle")).toHaveLength(1);
    const header = screen.getByTestId("thinking-toggle");
    expect(header).toHaveTextContent("Thinking");
    expect(within(header).getByTestId("thinking-meta")).toHaveTextContent("2 steps ·");
  });

  it("marks the step from process to reply with the trail divider", () => {
    render(<View {...props} streaming={false} messages={toolTurn()} />);
    // One divider: notes → answer. Not one between every pair of segments.
    expect(screen.getAllByTestId("trail-divider")).toHaveLength(1);
  });

  it("streams the live edge as prose, so a plain answer is never muted mid-flight", () => {
    // Mid-turn: the newest narration has not been sealed yet. Until the loop
    // commits it, nobody knows whether it is the reply — so it renders at the
    // bubble's full weight, and the caret rides it.
    let msgs: ChatMessage[] = [{ role: "user", content: "fix the bug" }];
    msgs = applyOutbound(msgs, frame("First note.", { _progress: true, _seal: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame('shell("npm test")', { _progress: true, _tool_hint: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Now let me check the served bundle", { _progress: true, turn_id: "T" }));
    render(<View {...props} streaming messages={msgs} />);

    const answer = screen.getByTestId("trail-answer");
    expect(within(answer).getByText(/Now let me check the served bundle/)).toBeInTheDocument();
    expect(within(screen.getByTestId("trail-notes")).getByText("First note.")).toBeInTheDocument();
    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(1);
  });

  it("renders a turn with no monologue as a single prose block, no divider", () => {
    let msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    msgs = applyOutbound(msgs, frame("Hello, sir.", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Hello, sir.", { _final: true, turn_id: "T" }));
    render(<View {...props} streaming={false} messages={msgs} />);

    expect(screen.queryByTestId("trail-notes")).toBeNull();
    expect(screen.getAllByTestId("trail-answer")).toHaveLength(1);
    expect(screen.queryAllByTestId("trail-divider")).toHaveLength(0);
  });

  it("treats a stored (pre-138) transcript as the answer, never as notes", () => {
    // A reload carries `content` only — no segments, no kinds. It must not be
    // mistaken for monologue and muted.
    render(
      <View
        {...props}
        streaming={false}
        messages={[
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello there." },
        ]}
      />,
    );
    expect(screen.queryByTestId("trail-notes")).toBeNull();
    expect(within(screen.getByTestId("trail-answer")).getByText("Hello there.")).toBeInTheDocument();
  });

  it("keeps consecutive notes in ONE block, in order", () => {
    let msgs: ChatMessage[] = [{ role: "user", content: "go" }];
    for (const line of ["First.", "Second.", "Third."]) {
      msgs = applyOutbound(msgs, frame(line, { _progress: true, _seal: true, turn_id: "T" }));
    }
    msgs = applyOutbound(msgs, frame("Done.", { _final: true, turn_id: "T" }));
    render(<View {...props} streaming={false} messages={msgs} />);

    const notes = within(screen.getByTestId("trail-notes")).getAllByTestId("trail-note");
    expect(notes.map((n) => n.textContent)).toEqual(["First.", "Second.", "Third."]);
  });
});

/**
 * The packing must not be re-implemented per surface — the same structural guard
 * the one-bubble spec uses, extended to the notes.
 */
describe("the notes packing lives in the shared module", () => {
  it("is rendered by TurnSegments, not by either ChatView", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    for (const view of ["src/views/ChatView.tsx", "src/mobile/ChatView.tsx"]) {
      const src = fs.readFileSync(view, "utf-8");
      expect(src).not.toContain("trail-notes");
      expect(src).not.toContain("trail-note");
      expect(src).not.toContain("trail-answer");
    }
    const shared = fs.readFileSync("src/components/AssistantTurn.tsx", "utf-8");
    expect(shared).toContain("trail-notes");
    expect(shared).toContain("trail-answer");
  });

  it("styles the notes in the shared stylesheet, muted and ruled", () => {
    const css = readFileSync(resolve(__dirname, "../index.css"), "utf-8");
    const block = css.slice(css.indexOf(".trail-notes {"), css.indexOf(".trail-note .md {"));
    expect(block).toContain("border-left");
    expect(block).toContain("var(--muted-foreground)");
    // Smaller than the bubble's 15px prose, so a note can never out-shout the
    // answer it sits above.
    expect(css).toMatch(/\.trail-notes \{[\s\S]*?font-size: 0\.8125rem;/);
  });
});

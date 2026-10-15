/**
 * Spec 135 §A/§B — one assistant bubble per turn + composer alignment.
 *
 * Viswa's report, verbatim: "I don't want a second bubble. Have one assistant
 * response bubble where all thinking/reasoning goes into the toggle and every
 * assistant prose gets appended with a horizontal subtle line to show the
 * trail." The reducer half is pinned in `transcript.test.ts`; this proves each
 * surface actually RENDERS that model, and that neither can drift from the
 * other — both consume the same `TurnSegments` / `ThinkingSection`.
 *
 * The render tests run the REAL frames through `applyOutbound` (not hand-built
 * bubbles), so a regression in the reducer shows up here too.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyOutbound, type TurnSegment } from "@/lib/transcript";
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
  /* `asChild` is consumed by the real Radix trigger and must NOT reach the
     child: a `Button` that receives it flips to Slot mode and renders its
     icon in place of the button element. */
  TooltipTrigger: ({ children, asChild: _asChild, ...props }: any) =>
    React.cloneElement(children, props),
  TooltipContent: () => null,
}));

import { ChatView as DesktopChatView } from "@/views/ChatView";
import { ChatView as MobileChatView } from "@/mobile/ChatView";

const props = {
  /** Default; every test that cares about the live turn passes it explicitly. */
  streaming: false,
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

/**
 * The frame sequence of a real two-tool-call turn, folded by the shared
 * reducer: narration → seal → tool call → narration → seal → tool call →
 * answer. Pre-135 this rendered as THREE assistant bubbles.
 */
function toolCallingTurn(): ChatMessage[] {
  let msgs: ChatMessage[] = [{ role: "user", content: "what is in these photos?" }];
  msgs = applyOutbound(msgs, frame("🖼️ Preparing images…", { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("Two images; let me look at both.", { _progress: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("Two images; let me look at both.", { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('describe_image("a.png")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("The first is a cat.", { _progress: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("The first is a cat.", { _progress: true, _seal: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame('describe_image("b.png")', { _progress: true, _tool_hint: true, turn_id: "T" }));
  msgs = applyOutbound(msgs, frame("The second is a bus.", { _final: true, turn_id: "T" }));
  return msgs;
}

describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>],
  ["mobile", MobileChatView as React.ComponentType<any>],
])("%s — one assistant bubble per turn (spec 135 §A)", (_name, View) => {
  it("renders the whole turn as ONE bubble, not one per narration iteration", () => {
    render(<View {...props} streaming={false} messages={toolCallingTurn()} />);

    // The headline: one assistant row, however many iterations the turn took.
    expect(screen.getAllByTestId("message-row-assistant")).toHaveLength(1);
    expect(screen.getAllByTestId("message-row-user")).toHaveLength(1);
  });

  it("stacks the turn's prose in order, separated by the trail divider", () => {
    // While the turn is LIVE the whole trail is inline: the monologue packed as
    // notes, the divider, then the answer. Once it settles the monologue moves
    // into the collapse (spec 139 §A — see turnSettling139).
    render(<View {...props} streaming messages={toolCallingTurn()} />);

    const segments = screen.getByTestId("assistant-turn-segments");
    expect(within(segments).getByText(/Two images; let me look at both\./)).toBeInTheDocument();
    expect(within(segments).getByText("The first is a cat.")).toBeInTheDocument();
    expect(within(segments).getByText("The second is a bus.")).toBeInTheDocument();

    const notes = screen.getByTestId("trail-notes");
    expect(within(notes).getAllByTestId("trail-note")).toHaveLength(2);

    // One divider: process → reply. The trail is still there — it is just no
    // longer drawn between *every* pair of segments.
    const dividers = screen.getAllByTestId("trail-divider");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveTextContent("⁂");
  });

  it("keeps reasoning and tool calls in the ONE collapse header, as chips", () => {
    render(<View {...props} streaming={false} messages={toolCallingTurn()} />);

    // One header, one toggle, for the entire turn.
    expect(screen.getAllByTestId("thinking-toggle")).toHaveLength(1);
    const header = screen.getByTestId("thinking-toggle");
    expect(header).toHaveTextContent("Thinking");
    expect(within(header).getByTestId("thinking-meta")).toHaveTextContent("3 steps ·");

    // Collapsed by default: the tool calls are NOT on screen as raw text.
    expect(screen.queryByTestId("tool-chips")).toBeNull();
    expect(screen.queryByText(/describe_image\(/)).toBeNull();

    // Expanded: icon + tool name + one-line summary, not a mono line.
    fireEvent.click(header);
    const chips = screen.getAllByTestId("tool-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent("🖼️ Preparing images…");
    expect(chips[1]).toHaveTextContent("describe_image");
    expect(chips[1]).toHaveTextContent("a.png");
  });

  it("shows the live pulse in the header and no second indicator", () => {
    // Genuinely mid-turn: the last narration segment is still streaming.
    let live = toolCallingTurn();
    live = applyOutbound(live, frame("The second looks like a red double-decker", { _progress: true, turn_id: "T" }));
    render(<View {...props} streaming messages={live} />);

    const header = screen.getByTestId("thinking-toggle");
    expect(within(header).getByTestId("thinking-indicator")).toBeInTheDocument();
    expect(screen.getAllByTestId("thinking-indicator")).toHaveLength(1);
    expect(screen.queryAllByTestId("reaction-chip")).toHaveLength(0);
    expect(screen.queryByText("Thinking…")).toBeNull();

    // Still ONE bubble — the streaming segment is appended to the same bubble.
    expect(screen.getAllByTestId("message-row-assistant")).toHaveLength(1);

    // The caret rides the NEWEST segment only — the trail above it is settled.
    expect(document.querySelectorAll(".streaming-caret")).toHaveLength(1);
  });

  it("empty state is the one slim header row", () => {
    // A live turn that has narrated but not spoken: the "ugly empty bubble"
    // Viswa flagged (header + big placeholder + chip) is one row.
    let msgs: ChatMessage[] = [{ role: "user", content: "look" }];
    msgs = applyOutbound(msgs, frame("🔍 Sending image to VLM…", { _progress: true, _tool_hint: true, turn_id: "T" }));
    render(<View {...props} streaming messages={msgs} />);

    expect(screen.getAllByTestId("message-row-assistant")).toHaveLength(1);
    expect(screen.getByTestId("thinking-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-turn-segments")).toBeNull();
    expect(screen.queryAllByTestId("reaction-chip")).toHaveLength(0);
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("renders a stored (pre-135) transcript as one segment, no divider", () => {
    // What a refresh loads from `/api/session/archive`: role + content only.
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
    expect(screen.getByTestId("assistant-turn-segments")).toBeInTheDocument();
    expect(screen.queryAllByTestId("trail-divider")).toHaveLength(0);
    expect(screen.getByText("Hello there.")).toBeInTheDocument();
  });

  it("still renders an out-of-band ack (/steer) as its own bubble", () => {
    // The one deliberate exception to "one bubble per turn": a notice is not
    // turn content (spec 127), so it keeps its own bubble beside the turn's.
    let msgs = applyOutbound(
      [{ role: "user", content: "do it" }],
      frame("🎯 Steer noted", { _notice: true }),
    );
    msgs = applyOutbound(msgs, frame("Working on it.", { _progress: true, turn_id: "T" }));
    msgs = applyOutbound(msgs, frame("Done.", { _final: true, turn_id: "T" }));

    render(<View {...props} streaming={false} messages={msgs} />);
    expect(screen.getAllByTestId("message-row-assistant")).toHaveLength(2);
    expect(screen.getByTestId("command-notice")).toHaveTextContent("Steer noted");
  });
});

/**
 * Spec 135 §B — the composer row is one control, not four.
 *
 * The report: the rocket (send) was `Button size="icon"` = 40px while attach
 * and mic were 36px, so on the `items-end` row the send button was the tallest
 * thing in the composer and read as floating next to the input box.
 */
describe("desktop composer — one footprint, one radius, one accent (spec 135 §B)", () => {
  it("puts attach, mic and send on the same 36px square footprint", () => {
    render(<DesktopChatView {...props} messages={[]} />);

    const send = screen.getByRole("button", { name: "Send" });
    const mic = screen.getByRole("button", { name: /record voice/i });
    const attach = screen.getByLabelText("Attach file");

    for (const el of [send, mic, attach]) {
      expect(el.className).toContain("size-9");
      expect(el.className).toContain("rounded-lg");
      expect(el.className).toContain("shrink-0");
    }
  });

  it("groups attach + mic as a ghost cluster and leaves send alone on the right", () => {
    render(<DesktopChatView {...props} messages={[]} />);

    const send = screen.getByRole("button", { name: "Send" });
    const mic = screen.getByRole("button", { name: /record voice/i });
    const attach = screen.getByLabelText("Attach file");

    // attach and mic share a parent (the tight cluster); send does not.
    expect(mic.parentElement).toBe(attach.parentElement);
    expect(send.parentElement).not.toBe(attach.parentElement);
    // The cluster reads as one unit: no gap between its two members.
    expect(attach.parentElement?.className).toContain("gap-0.5");
  });

  it("shares the accent between the input's focus ring and the send button", () => {
    render(<DesktopChatView {...props} messages={[]} />);

    const input = screen.getByPlaceholderText(/Message Sarathy/);
    const send = screen.getByRole("button", { name: "Send" });
    // One accent (`primary`) for both: the composer lights up as one unit.
    expect(input.className).toContain("focus-visible:ring-primary");
    expect(input.className).toContain("focus-visible:border-primary");
    expect(send.className).toContain("rounded-lg");
    // Symmetric vertical padding, so the first line starts level with the 36px
    // controls whether the box holds one line or ten.
    expect(input.className).toContain("py-3");
  });
});

describe("mobile composer mirrors the desktop treatment (spec 135 §B)", () => {
  it("keeps every control the same square with the input's radius", () => {
    render(<MobileChatView {...props} messages={[]} />);

    const send = screen.getByTestId("mobile-send");
    const mic = screen.getByTestId("mobile-mic");
    const attach = screen.getByLabelText("Attach file");

    for (const el of [send, mic, attach]) {
      // 44px stays (spec 126 §F touch target) — but the SHAPE is now coherent:
      // a circle send button among rounded squares was the mobile tell.
      expect(el.className).toContain("size-11");
      expect(el.className).toContain("rounded-lg");
      expect(el.className).not.toContain("rounded-full");
    }
  });

  it("shares the accent with the input", () => {
    render(<MobileChatView {...props} messages={[]} />);
    const input = screen.getByTestId("mobile-composer-input");
    expect(input.className).toContain("focus-visible:ring-primary");
    expect(input.className).toContain("rounded-lg");
  });
});

/**
 * The segment helper both SPAs render from is the shared module, not a copy —
 * this is the structural guard against the two implementations drifting.
 */
describe("both SPAs render the same shared turn module", () => {
  it("uses TurnSegments/TurnSegment from components/AssistantTurn + lib/transcript", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    for (const view of ["src/views/ChatView.tsx", "src/mobile/ChatView.tsx"]) {
      const src = fs.readFileSync(view, "utf-8");
      expect(src).toContain('from "@/components/AssistantTurn"');
      expect(src).toContain("TurnSegments");
      expect(src).toContain("turnSegments(");
      // The prose must not be re-implemented per surface.
      expect(src).not.toContain("trail-divider");
      expect(src).not.toContain("tool-chip");
    }
  });

  it("keeps the segment order the reducer produced", () => {
    const msgs = toolCallingTurn();
    const segments: TurnSegment[] = msgs[1].segments ?? [];
    expect(segments.map((s) => s.text)).toEqual([
      "Two images; let me look at both.",
      "The first is a cat.",
      "The second is a bus.",
    ]);
    expect(segments.every((s) => s.sealed)).toBe(true);
    // …and each segment knows which half of the turn it is (spec 138 §A): the
    // prose shipped with a tool call is a note, the `_final` is the answer.
    expect(segments.map((s) => s.kind)).toEqual(["note", "note", "answer"]);
  });
});
/**
 * Motion gating: the trail and the caret animate, and under
 * `prefers-reduced-motion` they hold still. Nothing about the reduced-motion
 * state carries less information — only the movement goes.
 */
describe("the trail + caret animations are motion-gated (spec 135 §A)", () => {
  const css = readFileSync(resolve(__dirname, "../index.css"), "utf-8");

  it("animates .trail-segment once per segment", () => {
    expect(css).toContain("@keyframes trail-in");
    expect(css).toContain("animation: trail-in 240ms ease-out backwards");
  });

  it("kills both under prefers-reduced-motion", () => {
    const block = css.slice(css.indexOf(".trail-segment {"));
    const reduced = block.slice(0, 600);
    expect(reduced).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.trail-segment\s*\{\s*animation: none;/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.streaming-caret\s*\{\s*animation: none;/,
    );
  });

  it("fades the trail rule out at both ends with a centred glyph", () => {
    const rule = css.slice(css.indexOf(".trail-rule {"), css.indexOf(".trail-glyph {"));
    expect(rule).toContain("linear-gradient");
    expect(rule).toContain("90deg");
    expect(rule).toContain("transparent");
    expect(css).toContain(".trail-glyph {");
  });
});

/**
 * Spec 134 §B — the live status strip on BOTH SPAs.
 *
 * The report this locks: on Telegram the streaming draft narrates the image
 * pipeline ("Preparing image…", "Sending image to VLM…"), but on the dashboard
 * those frames only ever appeared inside the collapsed Thinking section — i.e.
 * never while the turn was running. Both ChatViews now render the same
 * `LiveStatus` strip off the same `deriveLiveTurnStatus` derivation, so the two
 * SPAs cannot drift (the 127/131/134 rule).
 *
 * The reducer-level derivation is pinned in `transcript.test.ts`; this file
 * proves each surface actually renders it.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

import { ChatView as DesktopChatView, type ChatMessage } from "@/views/ChatView";
import { ChatView as MobileChatView } from "@/mobile/ChatView";

const props = {
  onSend: vi.fn(),
  onStop: vi.fn(),
  onNewChat: vi.fn(),
};

/** A live turn mid image→VLM: the bubble exists, its text has not started. */
const describing = (hint: string): ChatMessage[] => [
  { role: "user", content: "what's in this photo?" },
  {
    role: "assistant",
    content: "",
    turnId: "T",
    bubbleId: "T#1",
    progress: false,
    toolHint: hint,
    toolHints: [hint],
  },
];

describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>],
  ["mobile", MobileChatView as React.ComponentType<any>],
])("%s — live image-pipeline status (spec 134 §B)", (_name, View) => {
  it("shows the newest pipeline phase while the turn is running", () => {
    render(<View {...props} streaming messages={describing("🔍 Sending image to VLM…")} />);
    expect(screen.getByTestId("live-status-label")).toHaveTextContent(
      "🔍 Sending image to VLM…",
    );
  });

  it("advances the label as the pipeline advances", () => {
    const { rerender } = render(
      <View {...props} streaming messages={describing("🖼️ Preparing image…")} />,
    );
    expect(screen.getByTestId("live-status-label")).toHaveTextContent("🖼️ Preparing image…");

    rerender(<View {...props} streaming messages={describing("✅ Image description received")} />);
    expect(screen.getByTestId("live-status-label")).toHaveTextContent(
      "✅ Image description received",
    );
  });

  it("falls back to 'Sarathy is responding…' before the turn says anything", () => {
    render(<View {...props} streaming messages={[{ role: "user", content: "hi" }]} />);
    expect(screen.getByTestId("live-status-label")).toHaveTextContent(
      "Sarathy is responding…",
    );
    // The working chip still rides along in this state.
    expect(screen.getByTestId("reaction-chip")).toHaveAttribute("data-state", "working");
  });

  it("keeps the collapsed Thinking history intact while narrating live", () => {
    render(
      <View
        {...props}
        streaming
        messages={[
          {
            role: "assistant",
            content: "",
            toolHints: ["🖼️ Preparing image…", "🔍 Sending image to VLM…"],
            thinkingContent: "The user sent a photo; describe it first.",
          },
        ]}
      />,
    );
    // Phase on screen AND still in the collapse — surfacing must not consume it.
    expect(screen.getByTestId("live-status-label")).toHaveTextContent(
      "🔍 Sending image to VLM…",
    );
    expect(screen.getByRole("button", { name: /thinking/i })).toBeInTheDocument();
    // Spec 135 §A: the step count moved into that one header.
    expect(screen.getByTestId("thinking-meta")).toHaveTextContent("2 steps");
  });

  it("shows no strip once the turn has ended", () => {
    render(
      <View
        {...props}
        streaming={false}
        messages={[{ role: "assistant", content: "A tabby cat." }]}
      />,
    );
    expect(screen.queryByTestId("live-status")).toBeNull();
  });
});

/**
 * Spec 135 §A — the turn has exactly ONE status row.
 *
 * Job 134 shipped the narration with a `working` ReactionChip in the live
 * bubble, on top of the collapse header AND a big ThinkingIndicator
 * placeholder: three indicators stacked for one turn, which is what Viswa
 * flagged. The live pulse now lives INSIDE the header row and the chip is
 * gone; the strip still narrates, but it no longer doubles the bubble up.
 */
describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>],
  ["mobile", MobileChatView as React.ComponentType<any>],
])("%s — one status row per turn (spec 135 §A)", (_name, View) => {
  const live = (extra: Record<string, unknown> = {}): ChatMessage[] => [
    { role: "user", content: "what's in this photo?" },
    {
      role: "assistant",
      content: "",
      turnId: "T",
      bubbleId: "T#1",
      toolHints: ["🔍 Sending image to VLM…"],
      ...extra,
    },
  ];

  it("puts the live pulse INSIDE the single header row", () => {
    render(<View {...props} streaming messages={live()} />);
    const header = screen.getByTestId("thinking-toggle");
    // The travelling dots are the header's own live affordance…
    expect(within(header).getByTestId("thinking-indicator")).toBeInTheDocument();
    // …and they are the ONLY indicator on screen.
    expect(screen.getAllByTestId("thinking-indicator")).toHaveLength(1);
  });

  it("drops the separate working chip and the big placeholder", () => {
    render(<View {...props} streaming messages={live()} />);
    // No `working` ReactionChip anywhere: the header is the status row.
    expect(screen.queryAllByTestId("reaction-chip")).toHaveLength(0);
    // No standalone "Thinking…" placeholder paragraph either.
    expect(screen.queryByText("Thinking…")).toBeNull();
    // The bubble is the header row and nothing else (no prose yet).
    expect(screen.queryByTestId("assistant-turn-segments")).toBeNull();
  });
});

describe("the phase fade is motion-gated (spec 134 §B)", () => {
  const css = readFileSync(resolve(__dirname, "../index.css"), "utf-8");

  it("animates .live-hint and kills it under prefers-reduced-motion", () => {
    expect(css).toContain("@keyframes hint-in");
    expect(css).toContain("animation: hint-in 200ms ease-out backwards");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.live-hint\s*\{\s*animation: none;/,
    );
  });

  it("keeps the emoji colourable — no background-clip on the pipeline label", () => {
    // `.thinking-shimmer` clips a gradient to the glyphs, which drains the
    // pipeline emoji of their colour. The live hint must not do that.
    const liveHint = css.slice(css.indexOf(".live-hint {"));
    expect(liveHint.slice(0, liveHint.indexOf("}"))).not.toContain("background-clip");
  });
});
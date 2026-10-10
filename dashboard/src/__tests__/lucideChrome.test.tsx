/**
 * Spec 124 §D — chrome must be lucide-react icons, never emoji glyphs.
 *
 * The old chrome used emoji (hourglass/brain/wrench/check/cross in the
 * reaction chip, a robot-jar avatar, bolt/dollar signs in the usage footer and
 * a padlock on topic-locked sessions). They rendered differently per platform,
 * so each of these asserts BOTH that the lucide icon is present AND that no
 * emoji survives anywhere in the rendered output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: {
    sessionFooter: vi.fn(),
    sessions: vi.fn(),
    session: vi.fn(),
    me: vi.fn().mockResolvedValue({ ok: true }),
    status: vi.fn().mockResolvedValue({ version: "0.16.4", gateway: { running: true } }),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}));

import { api } from "@/lib/api";
import { ReactionChip, PresenceIndicator } from "@/components/Presence";
import { UsageFooter } from "@/components/UsageFooter";
import { SessionsView as DesktopSessionsView } from "@/views/SessionsView";
import { SessionsView as MobileSessionsView } from "@/mobile/SessionsView";
import { reactionFor } from "@/lib/reactions";
import type { ReactionState } from "@/lib/reactions";

/**
 * Emoji + pictograph ranges (superset of the spec §6 grep, which also covers
 * the dingbat block). Typographic marks like "↩" (U+21A9) are NOT in these
 * ranges and are deliberately left alone.
 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

/** Assert the rendered container carries no emoji anywhere in its subtree. */
function expectNoEmoji(container: HTMLElement) {
  expect(container.textContent ?? "").not.toMatch(EMOJI_RE);
}

/** Every lucide icon renders an inline <svg> with the given class. */
function iconSvgs(container: HTMLElement): SVGSVGElement[] {
  return Array.from(container.querySelectorAll("svg"));
}

describe("ReactionChip — lucide icon, no emoji", () => {
  afterEach(cleanup);

  it.each([
    ["queued", "loader-circle"],
    ["working", "loader-circle"],
    ["thinking", "brain"],
    ["tool", "wrench"],
    ["done", "circle-check"],
    ["failed", "circle-x"],
  ] as [ReactionState, string][])("renders the %s icon as an svg", (state, icon) => {
    const { container } = render(<ReactionChip state={state} />);
    const chip = screen.getByTestId("reaction-chip");

    // lucide icons are inline <svg>, and the name is asserted via the
    // data-icon attribute the chip stamps on it.
    const iconEl = screen.getByTestId("reaction-icon");
    expect(iconEl.tagName.toLowerCase()).toBe("svg");
    expect(iconEl.getAttribute("data-icon")).toBe(icon);
    expect(iconSvgs(chip).length).toBeGreaterThan(0);

    // The state/label vocabulary is unchanged by the icon swap.
    expect(chip.getAttribute("data-state")).toBe(state);
    expect(chip.textContent).toContain(reactionFor(state).label);

    expectNoEmoji(container);
  });

  it("renders elapsed/tokens counters without emoji", () => {
    const { container } = render(
      <ReactionChip state="working" elapsedMs={1500} tokens={42} />,
    );
    expect(screen.getByTestId("reaction-elapsed")).toHaveTextContent("1.5s");
    expect(screen.getByTestId("reaction-tokens")).toHaveTextContent("42 tkn");
    expectNoEmoji(container);
  });
});

describe("PresenceIndicator — lucide avatar, no emoji", () => {
  afterEach(cleanup);

  it.each(["queued", "thinking", "done", "failed"] as ReactionState[])(
    "renders an svg avatar for %s",
    (state) => {
      const { container } = render(<PresenceIndicator state={state} />);
      const avatar = screen.getByTestId("presence-avatar");

      // The jar emoji is gone; an inline lucide svg stands in for it.
      expect(iconSvgs(avatar).length).toBeGreaterThan(0);
      expect(avatar.textContent?.trim()).toBe("");
      expect(
        screen.getByTestId("presence-indicator").getAttribute("data-presence"),
      ).toBe(state);

      expectNoEmoji(container);
    },
  );
});

describe("UsageFooter — lucide icons, no emoji", () => {
  beforeEach(() => {
    vi.mocked(api.sessionFooter).mockResolvedValue({
      sessionKey: "dashboard:console",
      tokens: 1234,
      tokensPerSec: 42.5,
      cost: 0.0123,
      topic: null,
      contextUsedTokens: null,
      contextLength: null,
      contextPct: null,
      model: "qwen3",
      provider: "ollama",
      messageCount: 4,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(api.sessionFooter).mockReset();
  });

  it("renders token and cost figures with inline svg icons", async () => {
    const { container } = render(<UsageFooter sessionKey="dashboard:console" />);

    const tokens = await screen.findByTestId("footer-tokens");
    const cost = screen.getByTestId("footer-cost");

    expect(iconSvgs(tokens).length).toBe(1);
    expect(iconSvgs(cost).length).toBe(1);
    expect(tokens).toHaveTextContent("1.2k tkn");
    expect(cost).toHaveTextContent("$0.0123 session");

    expectNoEmoji(container);
  });
});

describe("SessionsView — topic lock is a lucide icon", () => {
  // The calendar opens on the CURRENT month, so the fixture session has to be
  // dated today or its day cell is never rendered.
  const today = new Date();
  const dayKey = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, "0")}-${`${today.getDate()}`.padStart(2, "0")}`;
  const stamp = today.toISOString();

  const locked = {
    key: "dashboard:console",
    channel: "dashboard",
    topic: "locked topic",
    topic_user_set: true,
    created_at: stamp,
    updated_at: stamp,
  };

  beforeEach(() => {
    vi.mocked(api.sessions).mockResolvedValue({ sessions: [locked] } as never);
    vi.mocked(api.session).mockResolvedValue({
      key: locked.key,
      createdAt: locked.created_at,
      messages: [],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.mocked(api.sessions).mockReset();
    vi.mocked(api.session).mockReset();
  });

  /** Walk calendar → day → channel so the session list is on screen. */
  async function drillToChannelList() {
    fireEvent.click(await screen.findByTestId(`calendar-day-${dayKey}`));
    fireEvent.click(await screen.findByTestId("day-channel"));
  }

  it("desktop: renders a lock svg and no padlock emoji", async () => {
    const { container } = render(<DesktopSessionsView />);
    await drillToChannelList();

    const lock = await screen.findByTestId("topic-lock");
    expect(lock.tagName.toLowerCase()).toBe("svg");
    expect(iconSvgs(container).length).toBeGreaterThan(0);

    expectNoEmoji(container);
  });

  it("mobile: renders a lock svg and no padlock emoji", async () => {
    const { container } = render(<MobileSessionsView />);
    await drillToChannelList();

    const lock = await screen.findByTestId("topic-lock");
    expect(lock.tagName.toLowerCase()).toBe("svg");

    expectNoEmoji(container);
  });
});

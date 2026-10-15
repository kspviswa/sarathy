/**
 * Spec 141 §A — the contextual "jump to latest" pill.
 *
 * Viswa: "can you add scroll up bottom contextual button? It should appear when
 * I'm at the top or middle of the screen and chat is growing down."
 *
 * Two properties matter, and the second is the one that can regress silently:
 *
 *  1. The pill is CONTEXTUAL — drawn only while the reader is away from the
 *     newest content, so its presence always means "there is more below".
 *  2. Auto-follow STOPS the moment the reader scrolls away. Yanking the viewport
 *     back to the bottom while someone is reading history is the rudest thing a
 *     chat can do, and it is exactly what a naive "always scroll to bottom on
 *     new message" does.
 *
 * jsdom has no layout, so the geometry is stubbed per element. The render tests
 * drive the REAL views through the real hook rather than a harness, so a view
 * that forgets to attach `onScroll` fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

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
import { useChatScroll, jumpLabel } from "@/lib/useChatScroll";
import { JumpToLatest } from "@/components/JumpToLatest";
import type { ChatMessage } from "@/views/ChatView";

const props = { streaming: false, onSend: vi.fn(), onStop: vi.fn(), onNewChat: vi.fn() };

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 500;
/** The furthest a 1000px transcript can scroll in a 500px window. */
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT;
/** 1000 - 500 - 100 = 400 — anything above 400 is "away from the bottom". */
const AT_BOTTOM = BOTTOM;
const SCROLLED_UP = 100;

/** The bottom of a transcript of a given height. */
const bottomOf = (scrollHeight: number) => scrollHeight - CLIENT_HEIGHT;

/**
 * Give an element the geometry jsdom refuses to compute, and a `scrollTo` that
 * records the call instead of throwing "Not implemented".
 *
 * `scrollTop` CLAMPS, as a real element does. Without that the glide's last
 * frame — which may overshoot by a few pixels — would settle past the end of the
 * transcript, and a test asserting the final offset would be asserting an
 * artefact of the stub rather than where the reader actually ends up.
 */
function stubGeometry(el: HTMLElement, scrollTop: number, scrollHeight = SCROLL_HEIGHT) {
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: CLIENT_HEIGHT, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      const max = (el.scrollHeight || 0) - (el.clientHeight || 0);
      top = Math.max(0, Math.min(v, max));
    },
  });
  (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = vi.fn(function (
    this: HTMLElement,
    opts: ScrollToOptions,
  ) {
    this.scrollTop = opts.top ?? 0;
  });
}

/**
 * A STABLE empty transcript.
 *
 * The auto-follow effect keys off the identity of `messages`, so a harness that
 * built `{ messages: [] }` inline made the effect run on every render — pinning
 * the viewport to the bottom the instant the pill was clicked, before the glide
 * had drawn a single frame. No real view does that; they pass React state.
 */
const NO_MESSAGES: unknown[] = [];

/** The scroll container — the one element that owns the transcript. */
function scroller(): HTMLElement {
  const tagged = screen.queryByTestId("scroller");
  if (tagged) return tagged;
  const row = screen.getAllByTestId(/^message-row-/)[0];
  let el: HTMLElement | null = row.parentElement;
  while (el && !el.className.includes("overflow-y-auto")) el = el.parentElement;
  if (!el) throw new Error("no scroll container found");
  return el;
}

/**
 * Scroll the transcript to `scrollTop` and let React see the event.
 *
 * `scrollHeight` is a parameter because the transcript GROWS while a smooth
 * scroll animates, and a helper that always reset it to the original height made
 * a "lands short" case impossible to express — which quietly turned the test
 * below into a no-op.
 */
function scrollTo(scrollTop: number, scrollHeight = SCROLL_HEIGHT) {
  const el = scroller();
  stubGeometry(el, scrollTop, scrollHeight);
  fireEvent.scroll(el);
}

/**
 * Timers the glide needs faked.
 *
 * `requestAnimationFrame` is NOT in vitest's default `toFake` list, so without
 * naming it here the glide runs on real frames and `advanceTimersByTime` does
 * nothing to it — which is exactly how this test first passed while asserting a
 * single frame of movement.
 */
const GLIDE_TIMERS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

/**
 * Run the jump-to-latest glide to completion.
 *
 * The hop is animation-frame driven and aims at a live target, so it takes a few
 * frames to arrive — asserting the final offset synchronously would only ever
 * catch frame one.
 */
function settleGlide(ms = 2500) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("jumpLabel", () => {
  it("prompts without a count, and counts when there is one", () => {
    expect(jumpLabel(0)).toBe("Jump to latest");
    expect(jumpLabel(1)).toBe("1 new message");
    expect(jumpLabel(3)).toBe("3 new messages");
  });
});

describe("useChatScroll — the anchor's contract", () => {
  function Harness({ messages }: { messages: unknown[] }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const { showJump, newCount, jumpToLatest, onScroll } = useChatScroll(ref, { messages });
    React.useEffect(() => {
      if (ref.current) stubGeometry(ref.current, AT_BOTTOM);
    }, []);
    return (
      <div>
        <div ref={ref} onScroll={onScroll} className="overflow-y-auto" data-testid="scroller">
          {messages.length} messages
        </div>
        <JumpToLatest show={showJump} newCount={newCount} onClick={jumpToLatest} />
      </div>
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...GLIDE_TIMERS] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is hidden while pinned to the bottom", () => {
    render(<Harness messages={["a", "b"]} />);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("appears when the reader scrolls up", () => {
    render(<Harness messages={["a", "b"]} />);
    act(() => scrollTo(SCROLLED_UP));
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("Jump to latest");
  });

  it("counts what arrives while the reader is away", () => {
    const { rerender } = render(<Harness messages={["a", "b"]} />);
    act(() => scrollTo(SCROLLED_UP));
    rerender(<Harness messages={["a", "b", "c", "d"]} />);
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("2 new messages");
    expect(screen.getByTestId("jump-to-latest")).toHaveAttribute("data-new-count", "2");
  });

  it("clears the count and the pill when the reader returns to the bottom", () => {
    const { rerender } = render(<Harness messages={["a", "b"]} />);
    act(() => scrollTo(SCROLLED_UP));
    rerender(<Harness messages={["a", "b", "c"]} />);
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("1 new message");
    act(() => scrollTo(AT_BOTTOM));
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("returns to the bottom when the pill is clicked", () => {
    const { rerender } = render(<Harness messages={["a", "b"]} />);
    act(() => scrollTo(SCROLLED_UP));
    rerender(<Harness messages={["a", "b", "c"]} />);

    act(() => fireEvent.click(screen.getByTestId("jump-to-latest")));
    settleGlide();
    expect(scroller().scrollTop).toBe(BOTTOM);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });
});

describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>, 1440],
  ["mobile", MobileChatView as React.ComponentType<any>, 390],
])("%s — the contextual jump-to-latest pill (spec 141 §A)", (_name, View) => {
  /** A conversation long enough that being scrolled up is a real state. */
  function convo(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: "user", content: `question ${i}` });
      msgs.push({ role: "assistant", content: `answer ${i}` });
    }
    return msgs;
  }

  it("draws no pill while the reader is at the bottom", () => {
    render(<View {...props} messages={convo()} />);
    act(() => scrollTo(AT_BOTTOM));
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("shows the pill when the reader scrolls up, and hides it on return", () => {
    render(<View {...props} messages={convo()} />);
    act(() => scrollTo(AT_BOTTOM));
    act(() => scrollTo(SCROLLED_UP));
    expect(screen.getByTestId("jump-to-latest")).toBeInTheDocument();
    act(() => scrollTo(AT_BOTTOM));
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("does NOT yank the viewport back down while the reader is away", () => {
    // The regression this pins: a naive "scroll to bottom on new message" drags
    // a reader who is mid-history back to the bottom on every frame.
    const { rerender } = render(<View {...props} messages={convo()} />);
    act(() => scrollTo(AT_BOTTOM));
    act(() => scrollTo(SCROLLED_UP));

    rerender(<View {...props} messages={[...convo(), { role: "assistant", content: "a reply" }]} />);
    expect(scroller().scrollTop).toBe(SCROLLED_UP);

    rerender(
      <View
        {...props}
        streaming
        messages={[...convo(), { role: "assistant", content: "a reply, still growing" }]}
      />,
    );
    expect(scroller().scrollTop).toBe(SCROLLED_UP);
  });

  it("still follows the turn while the reader IS at the bottom", () => {
    const { rerender } = render(<View {...props} messages={convo()} />);
    act(() => scrollTo(AT_BOTTOM));
    rerender(<View {...props} messages={[...convo(), { role: "assistant", content: "a reply" }]} />);
    expect(scroller().scrollTop).toBe(BOTTOM);
  });
});

describe("a long smooth scroll does not re-show the pill it dismissed (spec 141 §A)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...GLIDE_TIMERS] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Measured on mobile: an 8k-pixel hop to the bottom outlived a 600ms
   * settle-guard, so the frames after the guard expired read "away from the
   * bottom" and put the pill back — leaving it stuck on screen at the bottom of
   * the transcript. The guard must end on ARRIVAL (or on the reader taking
   * over), never on a timer.
   */
  function Harness() {
    const ref = React.useRef<HTMLDivElement>(null);
    const { showJump, newCount, jumpToLatest, onScroll } = useChatScroll(ref, { messages: NO_MESSAGES });
    React.useEffect(() => {
      if (ref.current) stubGeometry(ref.current, AT_BOTTOM);
    }, []);
    return (
      <div>
        <div ref={ref} onScroll={onScroll} className="overflow-y-auto" data-testid="scroller" />
        <JumpToLatest show={showJump} newCount={newCount} onClick={jumpToLatest} />
      </div>
    );
  }

  it("stays hidden through a long descent, and after arrival", () => {
    render(<Harness />);
    act(() => scrollTo(SCROLLED_UP));
    expect(screen.getByTestId("jump-to-latest")).toBeInTheDocument();

    act(() => fireEvent.click(screen.getByTestId("jump-to-latest")));

    // The glide's intermediate frames: descending, so they are ours.
    for (const top of [300, 380, 440]) act(() => scrollTo(top));
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();

    // …and it arrives on its own, without the pill ever coming back. The glide
    // yields as soon as the position counts as "at the bottom", so the assertion
    // is a threshold, not an exact offset.
    settleGlide();
    expect(BOTTOM - scroller().scrollTop).toBeLessThanOrEqual(100);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("gives the pill back if the reader pulls up mid-flight", () => {
    render(<Harness />);
    act(() => scrollTo(SCROLLED_UP));
    act(() => fireEvent.click(screen.getByTestId("jump-to-latest")));

    act(() => scrollTo(300)); // descending — ours
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();

    act(() => scrollTo(120)); // the reader took over and pulled back up
    expect(screen.getByTestId("jump-to-latest")).toBeInTheDocument();

    // …and the glide yields for good: it must not drag them back down.
    settleGlide();
    expect(scroller().scrollTop).toBe(120);
    expect(screen.getByTestId("jump-to-latest")).toBeInTheDocument();
  });
});

describe("a hop that lands short still leaves the reader at the latest (spec 141 §A)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...GLIDE_TIMERS] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The transcript can grow while a long smooth scroll is animating, which makes
   * the target it was aimed at stale — the hop lands short of the bottom. The
   * frames of our own flight must not be read as a scroll-away, or the reader is
   * left stranded just above the bottom with the pill showing and a growing turn
   * no longer followed. Measured on a long transcript: 141px short.
   */
  function Harness({ messages }: { messages: unknown[] }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const { showJump, newCount, jumpToLatest, onScroll } = useChatScroll(ref, { messages });
    React.useEffect(() => {
      if (ref.current) stubGeometry(ref.current, AT_BOTTOM);
    }, []);
    return (
      <div>
        <div ref={ref} onScroll={onScroll} className="overflow-y-auto" data-testid="scroller" />
        <JumpToLatest show={showJump} newCount={newCount} onClick={jumpToLatest} />
      </div>
    );
  }

  it("re-pins to the bottom when the content grew mid-flight", () => {
    const { rerender } = render(<Harness messages={["a", "b"]} />);
    act(() => scrollTo(SCROLLED_UP));
    act(() => fireEvent.click(screen.getByTestId("jump-to-latest")));

    // The content grew, and the hop stopped short of the new bottom: 1200 - 600
    // - 500 = 100, which is not "near" at a threshold of 100.
    const el = scroller();
    act(() => scrollTo(600, 1200));
    // Still our flight — no pill, and the follow is still armed.
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();

    // More content arrives: because the follow was never disarmed, it pins.
    act(() => {
      Object.defineProperty(el, "scrollHeight", { value: 1400, configurable: true });
      rerender(<Harness messages={["a", "b", "c"]} />);
    });
    expect(scroller().scrollTop).toBe(bottomOf(1400));
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });
});

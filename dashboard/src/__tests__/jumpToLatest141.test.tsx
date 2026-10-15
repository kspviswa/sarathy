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
import { describe, it, expect, vi, beforeEach } from "vitest";
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
/** 1000 - 500 - 100 = 400 — anything above 400 is "away from the bottom". */
const AT_BOTTOM = 500;
const SCROLLED_UP = 100;

/**
 * Give an element the geometry jsdom refuses to compute, and a `scrollTo` that
 * records the call instead of throwing "Not implemented".
 */
function stubGeometry(el: HTMLElement, scrollTop: number) {
  Object.defineProperty(el, "scrollHeight", { value: SCROLL_HEIGHT, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: CLIENT_HEIGHT, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
  (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = vi.fn(function (
    this: HTMLElement,
    opts: ScrollToOptions,
  ) {
    this.scrollTop = opts.top ?? 0;
  });
}

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

/** Scroll the transcript to `scrollTop` and let React see the event. */
function scrollTo(scrollTop: number) {
  const el = scroller();
  stubGeometry(el, scrollTop);
  fireEvent.scroll(el);
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    expect(scroller().scrollTop).toBe(SCROLL_HEIGHT);
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
    expect(scroller().scrollTop).toBe(SCROLL_HEIGHT);
  });
});

describe("a long smooth scroll does not re-show the pill it dismissed (spec 141 §A)", () => {
  /**
   * Measured on mobile: an 8k-pixel hop to the bottom outlived a 600ms
   * settle-guard, so the frames after the guard expired read "away from the
   * bottom" and put the pill back — leaving it stuck on screen at the bottom of
   * the transcript. The guard must end on ARRIVAL (or on the reader taking
   * over), never on a timer.
   */
  function Harness() {
    const ref = React.useRef<HTMLDivElement>(null);
    const { showJump, newCount, jumpToLatest, onScroll } = useChatScroll(ref, { messages: [] });
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

    // The smooth scroll's intermediate frames: descending, so they are ours.
    for (const top of [300, 380, 440]) act(() => scrollTo(top));
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();

    act(() => scrollTo(AT_BOTTOM));
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
  });
});

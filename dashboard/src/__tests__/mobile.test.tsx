import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React, { useEffect } from "react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    sendChatFull: vi.fn().mockResolvedValue({ ok: true }),
    sendChatWithMedia: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn().mockResolvedValue({ ok: true, path: "/tmp/a.png" }),
    status: vi.fn().mockResolvedValue({ version: "0.5.0", gateway: { running: true } }),
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    session: vi.fn().mockResolvedValue({ key: "", createdAt: "", messages: [] }),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
    workspaceTree: vi.fn().mockResolvedValue({ root: "/ws", tree: [] }),
    getConfig: vi.fn().mockResolvedValue({}),
    putConfig: vi.fn().mockResolvedValue({ ok: true, restartRequired: false }),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    pushKey: vi.fn().mockResolvedValue({ publicKey: "test", available: false }),
    pushSubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    pushUnsubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    commands: vi.fn().mockResolvedValue({ commands: [] }),
    sessionFooter: vi.fn().mockResolvedValue(null),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn() }),
  Toaster: () => null,
}));

vi.mock("@/lib/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "dark", resolved: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/lib/ws", () => ({
  DashboardSocket: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
      onNotification: vi.fn(() => vi.fn()),
    };
  }),
}));

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => <div data-testid="logo" data-size={size} />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: any) => React.cloneElement(children, props),
  TooltipContent: () => null,
}));

import MobileApp from "@/mobile/App";
import { ChatView as MobileChatView } from "@/mobile/ChatView";
import { api } from "@/lib/api";
import { useNotifications } from "@/lib/useNotifications";

vi.mock("@/lib/useNotifications", () => ({
  useNotifications: vi.fn().mockReturnValue({
    notifications: [],
    unreadCount: 0,
    unreadIds: [],
    isUnread: () => false,
    markAllRead: vi.fn(),
    markRead: vi.fn(),
    remove: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock("@/lib/useNotificationPref", () => ({
  useNotificationPref: vi.fn(() => ({ enabled: true, setEnabled: vi.fn() })),
}));

// Injectable history: lets tests feed messages directly into the mobile chat.
vi.mock("@/lib/useLastSession", () => ({
  useLastSession: (_authed: boolean, setMessages: (m: unknown[]) => void) => {
    // Feed history in an effect (never during render — setState during render
    // would loop forever).
    useEffect(() => {
      if (mockHistory) setMessages(mockHistory);
    }, []);
    return false;
  },
  resetLastSession: vi.fn(),
  DASHBOARD_SESSION_KEY: "dashboard:console",
}));

let mockHistory: unknown[] | null = null;

describe("Mobile app — bottom tab bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with a bottom tab bar containing the 6 tabs", async () => {
    render(<MobileApp />);
    const tabbar = await screen.findByTestId("mobile-tabbar");
    expect(tabbar).toBeInTheDocument();

    const buttons = within(tabbar).getAllByRole("button");
    expect(buttons).toHaveLength(6);

    expect(screen.getByLabelText("Chat")).toBeInTheDocument();
    expect(screen.getByLabelText("Files")).toBeInTheDocument();
    expect(screen.getByLabelText("Sessions")).toBeInTheDocument();
    expect(screen.getByLabelText("Jobs")).toBeInTheDocument();
    expect(screen.getByLabelText("Config")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
  });

  it("shows the mobile app shell (header + tab bar)", async () => {
    render(<MobileApp />);
    expect(await screen.findByTestId("mobile-app")).toBeInTheDocument();
  });

  it("drills Sessions from calendar to transcript with back affordances (spec §C)", async () => {
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
    const iso = now.toISOString();

    vi.mocked(api.sessions).mockResolvedValue({
      sessions: [
        { key: "telegram:1", channel: "telegram", topic: "alpha", messageCount: 2, updated_at: iso },
        { key: "telegram:2", channel: "telegram", topic: "beta", messageCount: 3, updated_at: iso },
        { key: "email:7", channel: "email", topic: "digest", messageCount: 1, updated_at: iso },
      ],
    });
    vi.mocked(api.session).mockResolvedValue({
      key: "telegram:1",
      createdAt: iso,
      messages: [{ role: "user", content: "ping" }],
    } as never);

    render(<MobileApp />);
    const tabbar = await screen.findByTestId("mobile-tabbar");
    await act(async () => {
      fireEvent.click(within(tabbar).getByLabelText("Sessions"));
      await Promise.resolve();
    });

    // Level 1: calendar + marker.
    expect(screen.getByTestId("session-calendar")).toBeInTheDocument();
    const day = screen.getByTestId(`calendar-day-${todayKey}`);
    expect(day).toBeEnabled();
    expect(screen.getByTestId(`calendar-marker-${todayKey}`)).toBeInTheDocument();

    // Level 2: per-channel counts.
    await act(async () => {
      fireEvent.click(day);
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-sessions-day")).toBeInTheDocument();
    const telegramRow = screen
      .getAllByTestId("day-channel")
      .find((el) => el.getAttribute("data-channel") === "telegram")!;
    expect(within(telegramRow.closest("li")!).getByTestId("channel-count")).toHaveTextContent("2");

    // Level 3: channel list.
    await act(async () => {
      fireEvent.click(telegramRow);
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-sessions-channel")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-sessions-title")).toHaveTextContent("Telegram");

    // Back to the day view.
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-sessions-back"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-sessions-day")).toBeInTheDocument();

    // Level 4: transcript.
    const telegramRowAgain = screen
      .getAllByTestId("day-channel")
      .find((el) => el.getAttribute("data-channel") === "telegram")!;
    await act(async () => {
      fireEvent.click(telegramRowAgain);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("alpha"));
      await Promise.resolve();
    });
    expect(await screen.findByText("ping")).toBeInTheDocument();
  });

  describe("mobile ↔ desktop chat parity (v0.16.x)", () => {
    beforeEach(() => {
      mockHistory = null;
    });

    it("renders openUI blocks as interactive widgets, not raw code (parity with desktop ChatView)", async () => {
      mockHistory = [
        {
          role: "assistant",
          content: [
            "Here are the current conditions:",
            "",
            "```openui-lang",
            "root = Stack([card])",
            "card = Card([t, tbl])",
            't = TextContent("Current conditions")',
            "tbl = Table([c1])",
            'c1 = Col("Temp", ["3.6"])',
            "```",
          ].join("\n"),
        },
      ];
      render(<MobileApp />);
      // The renderer is lazy-loaded, so allow extra time for the chunk.
      const block = await screen.findByTestId("ui-block", {}, { timeout: 5000 });
      expect(block).toBeInTheDocument();
      await within(block).findByText("Current conditions", {}, { timeout: 5000 });
      expect(within(block).getByText("Temp")).toBeInTheDocument();
      expect(within(block).getByText("3.6")).toBeInTheDocument();
      // The raw openui-lang source must not leak as a code block.
      expect(screen.queryByText(/root = Stack\(/)).not.toBeInTheDocument();
      // A widget needs room: the bubble must widen to the available width
      // instead of collapsing to ~186px and crushing the table (desktop
      // MessageRow does the same).
      const bubble = block.closest(".rounded-2xl");
      expect(bubble?.className).toContain("w-full");
    });

    it("shows the commands trigger and opens the palette", async () => {
      render(<MobileApp />);
      const trigger = await screen.findByTestId("mobile-commands-trigger");
      expect(trigger).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(trigger);
        await Promise.resolve();
      });
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
      expect(screen.getByLabelText("Search commands")).toBeInTheDocument();
    });

    it("renders the live usage footer under the composer", async () => {
      mockHistory = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      vi.mocked(api.sessionFooter).mockResolvedValue({
        tokens: 1234,
        tokensPerSec: 12.3,
        cost: 0.0012,
        contextPct: 12,
        contextUsedTokens: 1200,
        contextLength: 10000,
        messageCount: 2,
        model: "test-model",
        provider: "test-provider",
        topic: null,
      } as never);
      render(<MobileApp />);
      const footer = await screen.findByTestId("usage-footer");
      expect(footer).toBeInTheDocument();
      expect(within(footer).getByTestId("footer-model")).toHaveTextContent("test-model");
    });

    it("pins the shell with the desktop standalone-fix viewport (no bottom gap on phones)", async () => {
      render(<MobileApp />);
      const shell = await screen.findByTestId("mobile-app");
      // Parity with the desktop shell: standalone-fix (100dvh + 100vh fallback)
      // + min-h-dvh + overflow-hidden. The old `h-dvh`-only shell left a dead
      // band below the tab bar on real phones when the browser URL bar hid.
      expect(shell.className).toContain("standalone-fix");
      expect(shell.className).toContain("min-h-dvh");
      expect(shell.className).toContain("overflow-hidden");
    });

    it("grows the composer textarea with content, bounded by min/max (no empty-state collapse)", async () => {
      render(<MobileApp />);
      const ta = (await screen.findByPlaceholderText(/Message Sarathy/)) as HTMLTextAreaElement;
      // Empty: the two-row composer's resting height (spec 126 §F). It dropped
      // from the desktop-matching 96px because the textarea now owns its own
      // full-width row with the actions beneath it, and 96px would have eaten a
      // third of a 360×640 viewport before anything was typed. Still roomy —
      // roughly two lines — so it is NOT a collapsed single-line box.
      expect(parseInt(ta.style.height, 10)).toBeGreaterThanOrEqual(64);
      // Multi-line: grows with content, capped at 200px. jsdom reports
      // jsdom reports scrollHeight 0, so stub it to simulate 10 lines of real layout.
      Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 210 });
      await act(async () => {
        fireEvent.change(ta, { target: { value: "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10" } });
      });
      expect(parseInt(ta.style.height, 10)).toBe(200);
      expect(parseInt(ta.style.height, 10)).toBeLessThanOrEqual(200);
      // Clearing returns to the resting height, not a collapsed sub-min box.
      Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 48 });
      await act(async () => {
        fireEvent.change(ta, { target: { value: "" } });
      });
      expect(parseInt(ta.style.height, 10)).toBeGreaterThanOrEqual(64);
    });

    it("gives the textarea its own full-width row, controls on a second row", async () => {
      // Spec 126 §F: attach + mic + textarea + send used to share ONE
      // `flex items-end gap-2` row, squeezing the input to a sliver between
      // three 44px controls at 360px. The textarea is now full width and the
      // three actions sit on a row of their own.
      render(<MobileApp />);
      const input = await screen.findByTestId("mobile-composer-input");
      const mic = await screen.findByTestId("mobile-mic");
      const send = await screen.findByTestId("mobile-send");

      expect(input.className).toContain("w-full");
      // The textarea is NOT a flex sibling of the controls any more.
      expect(input.className).not.toContain("flex-1");

      const rowOf = (el: HTMLElement) => el.closest('[data-testid="mobile-composer-actions"]');
      expect(rowOf(mic)).not.toBeNull();
      expect(rowOf(send)).toBe(rowOf(mic));
      // …and the textarea is not in that same row.
      expect(rowOf(input)).toBeNull();
    });

    it("keeps every composer control at a 44px touch target", async () => {
      render(<MobileApp />);
      const mic = await screen.findByTestId("mobile-mic");
      const send = await screen.findByTestId("mobile-send");
      for (const el of [mic, send]) {
        expect(el.className).toContain("size-11"); // 44px
        expect(el.className).toContain("shrink-0");
      }
      const attach = await screen.findByLabelText("Attach file");
      expect(attach.className).toContain("size-11");
      expect(attach.className).toContain("shrink-0");
    });

    it("keeps the composer footer compact — no standalone shortcuts line (parity with desktop)", async () => {
      render(<MobileApp />);
      await screen.findByPlaceholderText(/Message Sarathy/);
      // The shortcut hint lives in the placeholder, exactly like the desktop
      // ChatView — a separate line under the composer is mobile-only cruft
      // that inflated the footer.
      expect(screen.queryByText(/Enter = newline/)).not.toBeInTheDocument();
    });
  });
});

/**
 * Spec 126 §D + §F — quote-and-ask and notification-Reply, ported to the mobile
 * SPA. Functionality lives in the shared `@/lib/quotes` + `@/components/QuoteAsk`
 * modules; this only proves the mobile view binds them.
 */
describe("Mobile quote-and-ask (parity with desktop)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseProps = {
    streaming: false,
    onSend: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn(),
    onNewChat: vi.fn(),
  };

  function stubSelection(text: string, container: Element) {
    const range = document.createRange();
    range.selectNodeContents(container);
    // jsdom's Range has no layout, so give it the one method the hook needs.
    (range as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () =>
        ({
          top: 120,
          left: 40,
          right: 200,
          bottom: 140,
          width: 160,
          height: 20,
          x: 40,
          y: 120,
          toJSON: () => ({}),
        }) as DOMRect;
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => text,
      getRangeAt: () => range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(selection);
    return selection;
  }

  it("surfaces 'Add to follow-up' on an assistant selection and makes a chip", async () => {
    render(
      <MobileChatView
        {...baseProps}
        messages={[{ role: "assistant", content: "Hello from Sarathy" }]}
      />,
    );
    const list = screen.getByTestId("mobile-message-list");
    await act(async () => {
      stubSelection("Hello from Sarathy", list);
      document.dispatchEvent(new Event("selectionchange"));
      await Promise.resolve();
    });

    const bar = await screen.findByTestId("quote-action-bar");
    expect(bar).toHaveTextContent("Add to follow-up");

    await act(async () => {
      fireEvent.click(bar);
      await Promise.resolve();
    });
    expect(screen.getByTestId("quote-chips")).toBeInTheDocument();
    expect(screen.getByTestId("quote-chip")).toHaveTextContent("Hello from Sarathy");
  });

  it("travels with the next send as the `quotes` payload", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <MobileChatView
        {...baseProps}
        onSend={onSend}
        messages={[{ role: "assistant", content: "Hello from Sarathy" }]}
      />,
    );
    const list = screen.getByTestId("mobile-message-list");
    await act(async () => {
      stubSelection("Hello from Sarathy", list);
      document.dispatchEvent(new Event("selectionchange"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quote-action-bar"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("mobile-composer-input"), {
        target: { value: "explain this" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-send"));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    const args = onSend.mock.calls[0];
    expect(args[0]).toBe("explain this");
    expect(args[4]).toEqual([{ source_role: "assistant", text: "Hello from Sarathy" }]);
  });

  it("seeds a quote chip from a notification Reply (followUpSeed)", async () => {
    render(
      <MobileChatView
        {...baseProps}
        messages={[]}
        followUpSeed={{ text: "Job 126 finished", nonce: 1 }}
      />,
    );
    const chip = await screen.findByTestId("quote-chip");
    expect(chip).toHaveTextContent("Job 126 finished");
  });

  it("shows the bar from a touch selection (touchend) where selectionchange never fires", async () => {
    render(
      <MobileChatView
        {...baseProps}
        messages={[{ role: "assistant", content: "Hello from Sarathy" }]}
      />,
    );
    const list = screen.getByTestId("mobile-message-list");
    await act(async () => {
      stubSelection("Hello from Sarathy", list);
      // Deliberately NO selectionchange — this is the iOS behaviour.
      document.dispatchEvent(new Event("touchend", { bubbles: true }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId("quote-action-bar")).toBeInTheDocument();
  });

  it("still quotes the selection text after the tap collapses it (touch safety)", async () => {
    render(
      <MobileChatView
        {...baseProps}
        messages={[{ role: "assistant", content: "Hello from Sarathy" }]}
      />,
    );
    const list = screen.getByTestId("mobile-message-list");
    await act(async () => {
      stubSelection("Hello from Sarathy", list);
      document.dispatchEvent(new Event("touchend", { bubbles: true }));
      await Promise.resolve();
    });
    const bar = await screen.findByTestId("quote-action-bar");

    // Tapping the bar collapses the live selection before the click handler runs.
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      rangeCount: 0,
      toString: () => "",
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    await act(async () => {
      fireEvent.click(bar);
      await Promise.resolve();
    });

    expect(screen.getByTestId("quote-chip")).toHaveTextContent("Hello from Sarathy");
  });
});

describe("Mobile — notification Reply quotes into the CURRENT session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not archive the session; quotes the item into the open chat", async () => {
    vi.mocked(useNotifications).mockReturnValue({
      notifications: [
        {
          id: "n1",
          title: "Job 126 completed",
          body: "All suites green.",
          tab: "jobs",
          timestamp: "2026-10-11T00:00:00.000Z",
        },
      ],
      unreadCount: 1,
      unreadIds: ["n1"],
      isUnread: () => true,
      markAllRead: vi.fn(),
      markRead: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
    } as never);

    render(<MobileApp />);
    await screen.findByTestId("mobile-tabbar");

    await act(async () => {
      fireEvent.click(screen.getByTestId("notifications-bell"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("notifications-reply"));
      await Promise.resolve();
    });

    // The whole point (parity with desktop): a turn in the live session, never
    // a fresh session — replying must not throw away the open conversation.
    expect(api.sessionNew).not.toHaveBeenCalled();
    const chip = await screen.findByTestId("quote-chip");
    expect(chip).toHaveTextContent("Job 126 completed");
  });
});

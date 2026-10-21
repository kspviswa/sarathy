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
    status: vi
      .fn()
      .mockResolvedValue({ version: "0.5.0", gateway: { running: true }, channels: [] }),
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    session: vi.fn().mockResolvedValue({ key: "", createdAt: "", messages: [] }),
    sessionsArchive: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionArchive: vi
      .fn()
      .mockResolvedValue({ id: "", key: "", channel: "", createdAt: "", messages: [] }),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
    workspaceTree: vi.fn().mockResolvedValue({ root: "/ws", tree: [] }),
    readFile: vi.fn().mockResolvedValue({ path: "/ws/a.txt", content: "hello" }),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
    getConfig: vi.fn().mockResolvedValue({}),
    putConfig: vi.fn().mockResolvedValue({ ok: true, restartRequired: false }),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    modalities: vi.fn().mockResolvedValue({
      main: { provider: "", model: "" },
      local: { provider: "", model: "" },
      image: { provider: "", model: "" },
      active: "",
    }),
    usageSummary: vi.fn().mockResolvedValue({ available: false }),
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
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
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

vi.mock("@/lib/useLastSession", () => ({
  useLastSession: (_authed: boolean, setMessages: (m: unknown[]) => void) => {
    useEffect(() => {
      setMessages([]);
    }, []);
    return false;
  },
  resetLastSession: vi.fn(),
  DASHBOARD_SESSION_KEY: "dashboard:console",
}));

/** The notification centre's "go to X" hook — captured so a deep link can
 *  be simulated (the shell routes it through `toSection()`). */
const nav = vi.hoisted(() => ({
  navigateTo: null as null | ((tab: string) => void),
}));

vi.mock("@/lib/useNotifications", () => ({
  useNotifications: vi.fn(
    (
      _socket: unknown,
      opts?: { navigateTo?: (tab: string) => void },
    ) => {
      if (opts?.navigateTo) nav.navigateTo = opts.navigateTo;
      return {
        notifications: [],
        unreadCount: 0,
        unreadIds: [],
        isUnread: () => false,
        markAllRead: vi.fn(),
        markRead: vi.fn(),
        remove: vi.fn(),
        clearAll: vi.fn(),
      };
    },
  ),
}));

vi.mock("@/lib/useNotificationPref", () => ({
  useNotificationPref: vi.fn(() => ({ enabled: true, setEnabled: vi.fn() })),
}));

import MobileApp from "@/mobile/App";
import { toSection } from "@/lib/navigation";

/**
 * The mobile shell after job 146 Run 2 §A.
 *
 * Viswa's correction: *"I expect the tabs to horizontally scroll with more or
 * '>' on the tab bar. I didn't ask you to drop anything."*
 *
 * So the bar carries SIX tabs — Chat · Ask · Jobs · Settings · Sessions ·
 * Files — in a horizontally scrollable strip, with a `>` affordance that
 * flips to `<` at the end. Nothing is folded away.
 */

/**
 * jsdom has no layout: `clientWidth` / `scrollWidth` are 0 and `scrollLeft`
 * is inert. The strip's geometry is stubbed per test so the overflow logic
 * can be exercised.
 */
function stubStrip(
  strip: HTMLElement,
  metrics: { clientWidth: number; scrollWidth: number; scrollLeft?: number },
) {
  Object.defineProperty(strip, "clientWidth", {
    configurable: true,
    value: metrics.clientWidth,
  });
  Object.defineProperty(strip, "scrollWidth", {
    configurable: true,
    value: metrics.scrollWidth,
  });
  Object.defineProperty(strip, "scrollLeft", {
    configurable: true,
    writable: true,
    value: metrics.scrollLeft ?? 0,
  });
}

/** Let the rAF-throttled scroll handler run and React flush. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

/** jsdom does not implement `scrollIntoView`; the shell guards the call, so a
 *  stub is needed to observe it. */
const scrollIntoView = vi.fn<(opts?: ScrollIntoViewOptions) => void>();

describe("Mobile nav — six scrollable tabs, nothing dropped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    nav.navigateTo = null;
    (
      Element.prototype as unknown as {
        scrollIntoView: (opts?: ScrollIntoViewOptions) => void;
      }
    ).scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders six tabs, in the order Chat, Ask, Jobs, Settings, Sessions, Files", async () => {
    render(<MobileApp />);
    const strip = await screen.findByTestId("mobile-tabbar-scroll");

    const labels = within(strip)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

    expect(labels).toEqual([
      "Chat",
      "Ask",
      "Jobs",
      "Settings",
      "Sessions",
      "Files",
    ]);
  });

  it("the tab strip is a horizontal scroll container that never wraps", async () => {
    render(<MobileApp />);
    const strip = await screen.findByTestId("mobile-tabbar-scroll");

    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.className).toContain("flex-nowrap");
    expect(strip.className).toContain("scroll-smooth");
    // The scrollbar stays out of sight (both engines).
    expect(strip.className).toContain("no-scrollbar");
    expect(strip.className).toContain("[-webkit-overflow-scrolling:touch]");

    // The safe-area padding of the bar survives.
    expect(screen.getByTestId("mobile-tabbar").className).toContain("safe-bottom");

    // Every tab keeps a min-width, so a label is never squeezed.
    for (const id of ["chat", "ask", "jobs", "settings", "sessions", "files"]) {
      expect(screen.getByTestId(`mobile-tab-${id}`).className).toMatch(/min-w-/);
    }
  });

  it("shows the `>` affordance when the strip overflows and hides it when it does not", async () => {
    render(<MobileApp />);
    const strip = await screen.findByTestId("mobile-tabbar-scroll");

    // No overflow → nothing to scroll → no control.
    stubStrip(strip, { clientWidth: 400, scrollWidth: 400 });
    await settle();
    expect(screen.queryByTestId("mobile-tab-scroll")).not.toBeInTheDocument();

    // Overflow → the control appears, pointing right.
    stubStrip(strip, { clientWidth: 320, scrollWidth: 640 });
    fireEvent.scroll(strip);
    await settle();

    const control = screen.getByTestId("mobile-tab-scroll");
    expect(control).toBeInTheDocument();
    expect(control.getAttribute("aria-label")).toBe("Scroll tabs right");
  });

  it("the affordance flips to `<` once the strip is scrolled to the end", async () => {
    render(<MobileApp />);
    const strip = await screen.findByTestId("mobile-tabbar-scroll");

    stubStrip(strip, { clientWidth: 320, scrollWidth: 640, scrollLeft: 0 });
    fireEvent.scroll(strip);
    await settle();
    expect(
      screen.getByTestId("mobile-tab-scroll").getAttribute("aria-label"),
    ).toBe("Scroll tabs right");

    // Scrolled to the end: there is nothing left to the right, so the same
    // control now scrolls BACK.
    strip.scrollLeft = 320;
    fireEvent.scroll(strip);
    await settle();

    expect(
      screen.getByTestId("mobile-tab-scroll").getAttribute("aria-label"),
    ).toBe("Scroll tabs left");
  });

  it("tapping the affordance scrolls the strip by ~0.7 of a viewport", async () => {
    render(<MobileApp />);
    const strip = await screen.findByTestId("mobile-tabbar-scroll");

    stubStrip(strip, { clientWidth: 320, scrollWidth: 640, scrollLeft: 0 });
    fireEvent.scroll(strip);
    await settle();

    const scrolls: number[] = [];
    strip.scrollBy = ((opts?: ScrollToOptions) => {
      scrolls.push(Number(opts?.left ?? 0));
    }) as Element["scrollBy"];

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-tab-scroll"));
      await Promise.resolve();
    });

    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]).toBeCloseTo(320 * 0.7, 5);
  });

  it("the active tab scrolls into view when the tab changes", async () => {
    render(<MobileApp />);
    await screen.findByTestId("mobile-tabbar-scroll");

    scrollIntoView.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-tab-files"));
      await Promise.resolve();
    });

    expect(scrollIntoView).toHaveBeenCalled();
    const args = scrollIntoView.mock.calls[0]?.[0];
    expect(args?.inline).toBe("nearest");
    expect(args?.block).toBe("nearest");
  });

  it("the Sessions tab renders the sessions view", async () => {
    render(<MobileApp />);
    await screen.findByTestId("mobile-tabbar-scroll");

    expect(screen.queryByTestId("mobile-sessions")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-tab-sessions"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("mobile-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-sessions-title")).toHaveTextContent("Sessions");
  });

  it("the Files tab renders the files view", async () => {
    render(<MobileApp />);
    await screen.findByTestId("mobile-tabbar-scroll");

    expect(screen.queryByTestId("mobile-files")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-tab-files"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("mobile-files")).toBeInTheDocument();
  });

  it("the old tab ids still land somewhere sensible", () => {
    // Config and Status merged into Settings (spec §B).
    expect(toSection("status")?.section).toBe("settings");
    expect(toSection("status")?.settingsSegment).toBe("status");
    expect(toSection("config")?.section).toBe("settings");
    expect(toSection("config")?.settingsSegment).toBe("form");

    // Sessions and Files are TABS again (spec §A, Run 2).
    expect(toSection("sessions")?.section).toBe("sessions");
    expect(toSection("files")?.section).toBe("files");

    // An unknown id is ignored, never a blank screen.
    expect(toSection("does-not-exist")).toBeNull();
    expect(toSection(undefined)).toBeNull();
  });

  it("a notification asking for sessions or files lands on the tab", async () => {
    render(<MobileApp />);
    await screen.findByTestId("mobile-tabbar-scroll");

    expect(nav.navigateTo).toBeTypeOf("function");

    await act(async () => {
      nav.navigateTo?.("sessions");
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-sessions")).toBeInTheDocument();

    await act(async () => {
      nav.navigateTo?.("files");
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-files")).toBeInTheDocument();

    // `config` / `status` land on the Settings tab (its own segment).
    await act(async () => {
      nav.navigateTo?.("status");
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-tab-settings")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("the Sessions drawer still opens from the Chat header (extra shortcut)", async () => {
    render(<MobileApp />);
    await screen.findByTestId("mobile-tabbar");

    expect(screen.queryByTestId("mobile-sessions-drawer")).not.toBeInTheDocument();

    const toggle = await screen.findByTestId("mobile-sessions-drawer-toggle");
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    expect(screen.getByTestId("mobile-sessions-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-sessions-drawer-panel")).toBeInTheDocument();
    // The archive browser is inside it.
    expect(screen.getByTestId("mobile-sessions")).toBeInTheDocument();
  });

  it("the Files sheet still opens from the attachment picker (extra shortcut)", async () => {
    render(<MobileApp />);
    await screen.findByTestId("mobile-tabbar");

    expect(screen.queryByTestId("mobile-files-sheet")).not.toBeInTheDocument();

    // The attach button opens the attachment source sheet.
    const attach = screen.getByLabelText("Attach file");
    await act(async () => {
      fireEvent.click(attach);
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-attach-sheet")).toBeInTheDocument();

    // "Browse workspace files" opens the full-screen Files sheet.
    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-attach-files"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("mobile-files-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-files")).toBeInTheDocument();
  });
});

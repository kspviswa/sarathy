import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, within } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    sendChatFull: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn(),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
    session: vi.fn().mockResolvedValue({ key: "telegram:123", createdAt: "", messages: [] }),
    sessionFooter: vi.fn().mockResolvedValue({
      sessionKey: "dashboard:console",
      tokens: 0,
      tokensPerSec: 0,
      cost: null,
      topic: null,
      contextUsedTokens: null,
      contextLength: null,
      contextPct: null,
      model: null,
      provider: null,
      messageCount: 0,
    }),
    commands: vi.fn().mockResolvedValue({ commands: [], count: 0 }),
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    pushKey: vi.fn().mockResolvedValue({ publicKey: "test", available: false }),
    pushSubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    pushUnsubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    workspaceTree: vi.fn().mockResolvedValue({ root: "/ws", tree: [] }),
    jobs: vi.fn().mockResolvedValue({ jobs: [] }),
    job: vi.fn().mockResolvedValue({ job: null, events: [], spec_text: null, result_text: null }),
    getConfig: vi.fn().mockResolvedValue({}),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    usageSummary: vi.fn().mockResolvedValue({ available: false }),
    status: vi
      .fn()
      .mockResolvedValue({ version: "0.16.0", gateway: { running: true }, channels: [], providers: [] }),
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

type NotifyHandler = (n: {
  type: "notification";
  payload: { title: string; body?: string; tab?: string; timestamp: string };
}) => void;

/** DashboardSocket stub that captures the notification callback so tests can
 *  push a real frame through the app's own subscription path. */
const socketState: { notify: NotifyHandler | null } = { notify: null };

vi.mock("@/lib/ws", () => ({
  DashboardSocket: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
      onNotification: vi.fn((cb: NotifyHandler) => {
        socketState.notify = cb;
        return () => {
          socketState.notify = null;
        };
      }),
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

vi.mock("@/lib/useLastSession", () => ({
  useLastSession: vi.fn().mockReturnValue(false),
  resetLastSession: vi.fn(),
  DASHBOARD_SESSION_KEY: "dashboard:console",
}));

import DesktopApp from "@/App";
import { ChatView } from "@/views/ChatView";
import { NotificationCenter } from "@/components/NotificationCenter";
import { relativeTime } from "@/lib/relativeTime";
import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT } from "@/views/ChatView";
import { api } from "@/lib/api";

async function renderApp() {
  render(<DesktopApp />);
  await act(async () => {
    await Promise.resolve();
  });
}

function emitNotification(
  payload: { title: string; body?: string; tab?: string; timestamp: string },
) {
  act(() => {
    socketState.notify?.({ type: "notification", payload });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  socketState.notify = null;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/* ------------------------------------------------------------------ §A tabs */

describe("Section navigation — tabs, not drawers", () => {
  it("renders a nav item for every section including the restored Sessions tab", async () => {
    await renderApp();
    const nav = screen.getByTestId("section-nav");
    for (const label of ["Chat", "Sessions", "Files", "Jobs", "Config", "Status"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByTestId("nav-sessions")).toBeInTheDocument();
  });

  it("swaps the main content area to the Sessions view with no drawer overlay", async () => {
    await renderApp();
    expect(screen.getByTestId("chat-view")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("nav-sessions"));
    });

    expect(screen.getByTestId("sessions-view")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-view")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drawer-scrim")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drawer-panel")).not.toBeInTheDocument();
  });

  it("swaps to each secondary section and back to chat", async () => {
    await renderApp();
    for (const id of ["jobs", "files", "config", "status", "chat"]) {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`nav-${id}`));
      });
      if (id === "chat") {
        expect(screen.getByTestId("chat-view")).toBeInTheDocument();
      } else {
        expect(screen.queryByTestId("drawer-panel")).not.toBeInTheDocument();
        expect(screen.getByTestId("nav-" + id)).toHaveAttribute("aria-current", "page");
      }
    }
  });

  it("no longer renders the dead Profile label; the session badge is real", async () => {
    await renderApp();
    expect(screen.queryByText("Profile")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-badge")).toHaveTextContent("dashboard:console");
  });

  it("no longer lists Recent conversations in the rail (spec §B)", async () => {
    vi.mocked(api.sessions).mockResolvedValue({
      sessions: [
        {
          key: "telegram:123",
          topic: "Deploy notes",
          preview: "shipped the dashboard",
          messageCount: 4,
        },
      ],
    });

    await renderApp();

    expect(screen.queryByText("Recent conversations")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("rail-session")).toHaveLength(0);

    // The conversations are reachable through the Sessions tab instead.
    await act(async () => {
      fireEvent.click(screen.getByTestId("nav-sessions"));
    });
    expect(screen.getByTestId("sessions-view")).toBeInTheDocument();
  });

  it("drills into a session through the calendar, day channels, and list", async () => {
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
    const iso = now.toISOString();

    vi.mocked(api.sessions).mockResolvedValue({
      sessions: [
        { key: "telegram:1", channel: "telegram", topic: "alpha", messageCount: 2, updated_at: iso },
        { key: "telegram:2", channel: "telegram", topic: "beta", messageCount: 3, updated_at: iso },
        { key: "discord:9", channel: "discord", topic: "gamma", messageCount: 1, updated_at: iso },
      ],
    });
    vi.mocked(api.session).mockResolvedValue({
      key: "telegram:1",
      createdAt: iso,
      messages: [{ role: "user", content: "ping" }],
    } as never);

    await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByTestId("nav-sessions"));
      await Promise.resolve();
    });

    // Level 1: calendar with a marker on today.
    expect(screen.getByTestId("session-calendar")).toBeInTheDocument();
    expect(screen.getByTestId(`calendar-marker-${todayKey}`)).toBeInTheDocument();
    const day = screen.getByTestId(`calendar-day-${todayKey}`);
    expect(day).toBeEnabled();

    // Level 2: per-channel session counts for that day.
    await act(async () => {
      fireEvent.click(day);
      await Promise.resolve();
    });
    expect(screen.getByTestId("sessions-day-view")).toBeInTheDocument();
    const telegramRow = screen
      .getAllByTestId("day-channel")
      .find((el) => el.getAttribute("data-channel") === "telegram")!;
    const discordRow = screen
      .getAllByTestId("day-channel")
      .find((el) => el.getAttribute("data-channel") === "discord")!;
    expect(
      within(telegramRow.closest("li")!).getByTestId("channel-count"),
    ).toHaveTextContent("2");
    expect(within(discordRow.closest("li")!).getByTestId("channel-count")).toHaveTextContent("1");

    // Level 3: the channel's session list.
    await act(async () => {
      fireEvent.click(telegramRow);
      await Promise.resolve();
    });
    expect(screen.getByTestId("sessions-channel-view")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();

    // Level 4: transcript.
    await act(async () => {
      fireEvent.click(screen.getByText("alpha"));
      await Promise.resolve();
    });
    expect(await screen.findByText("ping")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ §B layout */

describe("Chat layout — full width bottom bar and message column", () => {
  it("composer and footer span the window (no max-width cap)", () => {
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    const composer = screen.getByTestId("composer");
    expect(composer.className).not.toMatch(/max-w-/);
    const band = composer.firstElementChild?.nextElementSibling as HTMLElement;
    expect(band.className).toContain("w-full");
    expect(band.className).not.toMatch(/max-w-/);
  });

  it("message list uses a wide cap, not the old 672px centered rail", () => {
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    const list = screen.getByTestId("message-list");
    expect(list.className).toContain("w-full");
    expect(list.className).not.toContain("max-w-2xl");
    expect(list.className).toContain("max-w-5xl");
  });
});

/* ------------------------------------------------------- §E resizeable composer */

describe("Composer — drag to resize, no expand toggle", () => {
  it("renders a resize handle instead of the old expand button", () => {
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    expect(screen.getByTestId("composer-resize-handle")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /expand composer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /collapse composer/i })).not.toBeInTheDocument();
  });

  it("dragging the handle up grows the textarea and persists the height", () => {
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    const handle = screen.getByTestId("composer-resize-handle");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 200, pointerId: 1 });

    expect(parseInt(textarea.style.height, 10)).toBeGreaterThan(96);
    expect(Number(localStorage.getItem("sarathy_composer_height"))).toBe(
      parseInt(textarea.style.height, 10),
    );
  });

  it("clamps the composer height to its bounds", () => {
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    const handle = screen.getByTestId("composer-resize-handle");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: -5000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: -5000, pointerId: 1 });
    expect(parseInt(textarea.style.height, 10)).toBe(COMPOSER_MAX_HEIGHT);

    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 9000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 9000, pointerId: 1 });
    expect(parseInt(textarea.style.height, 10)).toBe(COMPOSER_MIN_HEIGHT);
  });

  it("restores a persisted composer height on the next mount", () => {
    localStorage.setItem("sarathy_composer_height", "200");
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(parseInt(textarea.style.height, 10)).toBe(200);
  });

  it("arrow keys nudge the handle for keyboard users", () => {
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    const handle = screen.getByTestId("composer-resize-handle");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(parseInt(textarea.style.height, 10)).toBe(120);
  });
});

/* ------------------------------------------------- §F notification sidebar */

describe("Notification sidebar", () => {
  beforeEach(() => {
    // Single-bell control (spec §D): start with notifications already on.
    localStorage.setItem("sarathy_notifications_enabled", "true");
  });

  it("shows exactly one bell with an unread badge and opens a right-side panel", async () => {
    await renderApp();
    const bells = screen.getAllByTestId("notifications-bell");
    expect(bells).toHaveLength(1);
    expect(bells[0]).toHaveAttribute("data-enabled", "true");
    expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument();

    emitNotification({ title: "Backup done", body: "All good", tab: "status", timestamp: new Date().toISOString() });
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("notifications-bell"));
    const panel = screen.getByTestId("notifications-panel");
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByText("Backup done")).toBeInTheDocument();
    expect(within(panel).getByText("All good")).toBeInTheDocument();
    // The drawer houses the on/off switch.
    expect(within(panel).getByTestId("notifications-switch")).toBeInTheDocument();
  });

  it("is a single toggle: turning notifications off swaps to bell-off (spec §D)", async () => {
    await renderApp();
    const bell = screen.getByTestId("notifications-bell");
    expect(bell).toHaveAttribute("data-enabled", "true");

    emitNotification({ title: "Ping", timestamp: new Date().toISOString() });
    expect(screen.getByTestId("notifications-badge")).toBeInTheDocument();

    fireEvent.click(bell);
    const panel = screen.getByTestId("notifications-panel");
    fireEvent.click(within(panel).getByTestId("notifications-switch"));

    // Off: no panel, no badge, bell-off, and the pref is persisted.
    expect(screen.queryByTestId("notifications-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("notifications-bell")).toHaveAttribute("data-enabled", "false");
    expect(localStorage.getItem("sarathy_notifications_enabled")).toBe("false");
  });

  it("shows an empty state before any notification arrives", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(screen.getByTestId("notifications-empty")).toHaveTextContent("No notifications yet");
  });

  it("mark all read clears the badge", async () => {
    await renderApp();
    emitNotification({ title: "One", timestamp: new Date().toISOString() });
    fireEvent.click(screen.getByTestId("notifications-bell"));
    fireEvent.click(screen.getByTestId("notifications-mark-all"));

    expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument();
    // The list itself stays, it is just no longer unread.
    expect(screen.getAllByTestId("notifications-item")).toHaveLength(1);
  });

  it("clicking a notification with a tab navigates to that section", async () => {
    await renderApp();
    emitNotification({ title: "Job failed", tab: "jobs", timestamp: new Date().toISOString() });

    fireEvent.click(screen.getByTestId("notifications-bell"));
    fireEvent.click(screen.getAllByTestId("notifications-item")[0]);

    expect(screen.queryByTestId("notifications-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("nav-jobs")).toHaveAttribute("aria-current", "page");
  });

  it("clicking a notification without a tab only marks it read", async () => {
    await renderApp();
    emitNotification({ title: "Heads up", timestamp: new Date().toISOString() });
    fireEvent.click(screen.getByTestId("notifications-bell"));
    fireEvent.click(screen.getAllByTestId("notifications-item")[0]);

    expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-view")).toBeInTheDocument();
  });

  it("ignores an unknown notification tab instead of blanking the main area", async () => {
    await renderApp();
    emitNotification({ title: "Weird", tab: "does-not-exist", timestamp: new Date().toISOString() });

    fireEvent.click(screen.getByTestId("notifications-bell"));
    fireEvent.click(screen.getAllByTestId("notifications-item")[0]);

    expect(screen.getByTestId("chat-view")).toBeInTheDocument();
  });

  it("renders relative timestamps in the panel", () => {
    render(
      <NotificationCenter
        notifications={[
          {
            id: "1",
            title: "Now",
            body: "b",
            tab: "chat",
            timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
          },
        ]}
        unreadIds={["1"]}
        open
        onOpenChange={vi.fn()}
        onMarkAllRead={vi.fn()}
        onMarkRead={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("notifications-time")).toHaveTextContent("2m ago");
  });
});

/* ---------------------------------------------------------- relativeTime util */

describe("relativeTime", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  it("renders coarse relative labels", () => {
    expect(relativeTime("2026-08-28T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-08-28T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-08-28T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-08-26T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("falls back to a date for old stamps and never throws on junk", () => {
    expect(relativeTime("2026-06-01T12:00:00.000Z", now)).toMatch(/Jun/);
    expect(relativeTime("not-a-date", now)).toBe("");
    expect(relativeTime(undefined, now)).toBe("");
  });

  it("does not render negative ages for clock skew", () => {
    expect(relativeTime("2026-08-28T12:05:00.000Z", now)).toBe("just now");
  });
});

/* ------------------------------------------------------------- §C footer live */

describe("UsageFooter — live numbers", () => {
  it("refetches when the chat reports a new message", async () => {
    vi.mocked(api.sessionFooter).mockClear();
    const { rerender } = render(
      <ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const initial = vi.mocked(api.sessionFooter).mock.calls.length;
    expect(initial).toBeGreaterThan(0);

    rerender(
      <ChatView
        messages={[{ role: "assistant", content: "done" }]}
        streaming={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(api.sessionFooter).mock.calls.length).toBeGreaterThan(initial);
  });

  it("re-reads after a turn settles so the final numbers are not stale", async () => {
    vi.useFakeTimers();
    vi.mocked(api.sessionFooter).mockClear();
    try {
      const { rerender } = render(
        <ChatView messages={[]} streaming onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const whileStreaming = vi.mocked(api.sessionFooter).mock.calls.length;

      rerender(
        <ChatView
          messages={[{ role: "assistant", content: "done" }]}
          streaming={false}
          onSend={vi.fn()}
          onStop={vi.fn()}
          onNewChat={vi.fn()}
        />,
      );
      const atSettle = vi.mocked(api.sessionFooter).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      const afterTrailing = vi.mocked(api.sessionFooter).mock.calls.length;

      expect(whileStreaming).toBeGreaterThan(0);
      expect(atSettle).toBeGreaterThan(whileStreaming);
      expect(afterTrailing).toBeGreaterThan(atSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the values returned by the endpoint, nothing hardcoded", async () => {
    vi.mocked(api.sessionFooter).mockResolvedValue({
      sessionKey: "dashboard:console",
      tokens: 4321,
      tokensPerSec: 88.5,
      cost: 0.1234,
      topic: "Live numbers",
      contextUsedTokens: 1000,
      contextLength: 8000,
      contextPct: 13,
      model: "qwen3",
      provider: "ollama",
      messageCount: 4,
    });
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("footer-tokens")).toHaveTextContent("4.3k tkn");
    expect(screen.getByTestId("footer-tps")).toHaveTextContent("88.5 tps");
    expect(screen.getByTestId("footer-cost")).toHaveTextContent("$0.1234");
    expect(screen.getByTestId("footer-model")).toHaveTextContent("qwen3 · ollama");
  });

  it("renders no telemetry for a fresh session (messageCount === 0)", async () => {
    vi.mocked(api.sessionFooter).mockResolvedValue({
      sessionKey: "dashboard:console",
      tokens: 0,
      tokensPerSec: 0,
      cost: null,
      topic: null,
      contextUsedTokens: null,
      contextLength: null,
      contextPct: null,
      model: "qwen3",
      provider: "ollama",
      messageCount: 0,
    });
    render(<ChatView messages={[]} streaming={false} onSend={vi.fn()} onStop={vi.fn()} onNewChat={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("footer-tokens")).not.toBeInTheDocument();
    expect(screen.queryByTestId("footer-tps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("footer-cost")).not.toBeInTheDocument();
    expect(screen.queryByTestId("footer-context")).not.toBeInTheDocument();
    // Only the model/provider line may remain.
    expect(screen.getByTestId("footer-model")).toHaveTextContent("qwen3 · ollama");
  });
});
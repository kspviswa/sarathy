import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sessions: vi.fn(),
    session: vi.fn(),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    sendChatWithMedia: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn(),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
    workspaceTree: vi.fn().mockResolvedValue({ root: "/ws", tree: [] }),
    getConfig: vi.fn().mockResolvedValue({}),
    putConfig: vi.fn().mockResolvedValue({ ok: true, restartRequired: false }),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    status: vi.fn().mockResolvedValue({ version: "0.6.0", gateway: { running: true } }),
    sendChatFull: vi.fn().mockResolvedValue({ ok: true }),
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
    pushKey: vi.fn().mockResolvedValue({ publicKey: "test", available: false }),
    pushSubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
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

import { api, getToken } from "@/lib/api";
import { resetLastSession, DASHBOARD_SESSION_KEY, clearResetFlag, WS_OPEN_EVENT } from "@/lib/useLastSession";
import { DashboardSocket } from "@/lib/ws";
import DesktopApp from "@/App";
import MobileApp from "@/mobile/App";

function setupWithMessages() {
  api.sessions.mockReset();
  api.sessions.mockResolvedValue({
    sessions: [
      {
        key: "dashboard:console",
        created_at: "2026-01-01T00:00:00",
        updated_at: "2026-01-01T00:00:00",
        path: "/ws/sess.json",
      },
    ],
  });
  api.session.mockReset();
  api.session.mockResolvedValue({
    key: "dashboard:console",
    createdAt: "2026-01-01T00:00:00",
    messages: [
      { role: "user", content: "hello prior", timestamp: "t1" },
      { role: "assistant", content: "hi back prior", timestamp: "t2" },
    ],
  });
}

function setupEmptySession() {
  api.sessions.mockReset();
  api.sessions.mockResolvedValue({
    sessions: [
      {
        key: "dashboard:console",
        created_at: "2026-01-01T00:00:00",
        updated_at: "2026-01-01T00:00:00",
        path: "/ws/sess.json",
      },
    ],
  });
  api.session.mockReset();
  api.session.mockResolvedValue({
    key: "dashboard:console",
    createdAt: "2026-01-01T00:00:00",
    messages: [],
  });
}

function setupNoSessions() {
  api.sessions.mockReset();
  api.sessions.mockResolvedValue({ sessions: [] });
  api.session.mockReset();
  api.session.mockResolvedValue({ key: "", createdAt: "", messages: [] });
}

function setupNullContentToolRows() {
  api.sessions.mockReset();
  api.sessions.mockResolvedValue({
    sessions: [{ key: "dashboard:console", created_at: "t", updated_at: "t" }],
  });
  api.session.mockReset();
  api.session.mockResolvedValue({
    key: "dashboard:console",
    createdAt: "t",
    messages: [
      { role: "user", content: "hello prior", timestamp: "t1" },
      { role: "assistant", content: "", timestamp: "t2" },
      { role: "tool", content: "some tool result", timestamp: "t3" },
      { role: "assistant", content: "hi back prior", timestamp: "t4" },
    ],
  });
}

describe("Last session load — desktop App", () => {
  beforeEach(() => {
    api.me.mockReset();
    api.me.mockResolvedValue({ ok: true });
    api.sessions.mockReset();
    api.sessions.mockResolvedValue({ sessions: [] });
    api.session.mockReset();
    api.session.mockResolvedValue({ key: "", createdAt: "", messages: [] });
    clearResetFlag();
    DashboardSocket.mockReset();
    DashboardSocket.mockImplementation(function () {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        onNotification: vi.fn(() => vi.fn()),
      };
    });
    getToken.mockReturnValue("test-token");
  });

  it("loads dashboard:console history into the chat on mount", async () => {
    setupWithMessages();
    render(<DesktopApp />);

    expect(await screen.findByText("hello prior")).toBeInTheDocument();
    expect(screen.getByText("hi back prior")).toBeInTheDocument();
  });

  it("keeps chat empty when no sessions exist", async () => {
    setupNoSessions();

    render(<DesktopApp />);

    await waitFor(() => expect(api.sessions).toHaveBeenCalled());
    // Empty state is now the greeting view with mascot + suggestion chips.
    expect(await screen.findByTestId("greeting-state")).toBeInTheDocument();
    expect(screen.getByTestId("suggestion-chips")).toBeInTheDocument();
    expect(screen.queryByText("hello prior")).not.toBeInTheDocument();
  });

  it("does not crash when history contains null-content assistant tool rows (real dashboard:console shape)", async () => {
    setupNullContentToolRows();

    render(<DesktopApp />);

    expect(await screen.findByText("hello prior")).toBeInTheDocument();
    expect(screen.getByText("hi back prior")).toBeInTheDocument();
  });
});

describe("Last session load — mobile App", () => {
  beforeEach(() => {
    api.me.mockReset();
    api.me.mockResolvedValue({ ok: true });
    api.sessions.mockReset();
    api.sessions.mockResolvedValue({ sessions: [] });
    api.session.mockReset();
    api.session.mockResolvedValue({ key: "", createdAt: "", messages: [] });
    clearResetFlag();
    DashboardSocket.mockReset();
    DashboardSocket.mockImplementation(function () {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        onNotification: vi.fn(() => vi.fn()),
      };
    });
    getToken.mockReturnValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("loads dashboard:console history into the chat on mount", async () => {
    setupWithMessages();
    render(<MobileApp />);

    expect(await screen.findByText("hello prior")).toBeInTheDocument();
    expect(screen.getByText("hi back prior")).toBeInTheDocument();
  });
});

describe("Last session load — mobile App (empty session)", () => {
  beforeEach(() => {
    api.me.mockReset();
    api.me.mockResolvedValue({ ok: true });
    api.sessions.mockReset();
    api.sessions.mockResolvedValue({
      sessions: [{ key: "dashboard:console", created_at: "t", updated_at: "t", path: "/ws/sess.json" }],
    });
    api.session.mockReset();
    api.session.mockResolvedValue({ key: "dashboard:console", createdAt: "t", messages: [] });
    clearResetFlag();
    DashboardSocket.mockReset();
    DashboardSocket.mockImplementation(function () {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        onNotification: vi.fn(() => vi.fn()),
      };
    });
    getToken.mockReturnValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps chat empty when the session has no messages", async () => {
    render(<MobileApp />);
    // Robust: re-query on every poll. The empty-state node can be detached by
    // re-renders (socket connect, loading flip) and the mock may transiently
    // resolve to {} under parallel load — waitFor + queryByText tolerates both.
    await waitFor(
      () => {
        expect(screen.queryByText(/Say hello to Sarathy/)).toBeInTheDocument();
        expect(screen.queryByText("hello prior")).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});

/**
 * Spec 124 §B1/B2 — a browser refresh during a restart window must recover.
 *
 * The dashboard socket reopens once the gateway is back; that (re)open is the
 * signal that history can be re-fetched. Until then the failure is surfaced,
 * never used to blank what is already on screen.
 */
describe("Last session reload — reconnect refetch (spec 124 §B1/B2)", () => {
  // Typed views onto the mocked module (vi.mocked, not raw property access).
  const meApi = vi.mocked(api.me);
  const sessionsApi = vi.mocked(api.sessions);
  const sessionApi = vi.mocked(api.session);
  const footerApi = vi.mocked(api.sessionFooter);
  const SocketMock = vi.mocked(DashboardSocket);
  const getTokenMock = vi.mocked(getToken);

  const CONSOLE_SESSION = {
    key: "dashboard:console",
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    path: "/ws/sess.json",
  };

  beforeEach(() => {
    meApi.mockReset();
    meApi.mockResolvedValue({
      deviceId: "test-device",
      deviceName: "test",
      version: "0.16.4",
    });
    sessionsApi.mockReset();
    sessionApi.mockReset();
    footerApi.mockClear();
    clearResetFlag();
    SocketMock.mockReset();
    SocketMock.mockImplementation(function () {
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        onNotification: vi.fn(() => vi.fn()),
        onOpen: vi.fn(() => vi.fn()),
      };
    });
    getTokenMock.mockReturnValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  /** Mount-time load fails: the gateway is down (restart window). */
  function setupGatewayDown() {
    sessionsApi.mockRejectedValue(new Error("gateway unavailable"));
    sessionApi.mockRejectedValue(new Error("gateway unavailable"));
  }

  /** The gateway is back: the console session now has a message in it. */
  function setupRecovered(text: string) {
    sessionsApi.mockResolvedValue({ sessions: [CONSOLE_SESSION] });
    sessionApi.mockResolvedValue({
      key: "dashboard:console",
      createdAt: "2026-01-01T00:00:00",
      messages: [{ role: "user", content: text, timestamp: "t9" }],
    });
  }

  /** Simulate the socket (re)opening. */
  function reopenSocket() {
    act(() => {
      window.dispatchEvent(new CustomEvent(WS_OPEN_EVENT));
    });
  }

  it("refetches history when the socket reopens after a failed first load", async () => {
    setupGatewayDown();
    render(<DesktopApp />);

    // The mount load failed: no history yet, but the failure IS surfaced.
    expect(await screen.findByTestId("history-error")).toBeInTheDocument();

    // The gateway comes back up and the socket reopens.
    setupRecovered("restart the gateway");
    reopenSocket();

    expect(await screen.findByText("restart the gateway")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("history-error")).not.toBeInTheDocument(),
    );
  });

  it("recovers on mobile too", async () => {
    setupGatewayDown();
    render(<MobileApp />);

    expect(await screen.findByTestId("history-error")).toBeInTheDocument();

    setupRecovered("restart the gateway");
    reopenSocket();

    expect(await screen.findByText("restart the gateway")).toBeInTheDocument();
  });

  it("refetches on reconnect even when the first load succeeded", async () => {
    setupRecovered("first load");
    render(<DesktopApp />);
    expect(await screen.findByText("first load")).toBeInTheDocument();

    const before = sessionsApi.mock.calls.length;
    reopenSocket();
    await waitFor(() =>
      expect(sessionsApi.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("keeps existing messages when a later refetch fails", async () => {
    setupRecovered("already on screen");
    render(<DesktopApp />);
    expect(await screen.findByText("already on screen")).toBeInTheDocument();

    sessionsApi.mockRejectedValue(new Error("gateway unavailable"));
    reopenSocket();

    // The failure is reported...
    expect(await screen.findByTestId("history-error")).toBeInTheDocument();
    // ...and it did NOT wipe the transcript.
    expect(screen.getByText("already on screen")).toBeInTheDocument();
  });

  it("retries with backoff after a reconnect, then stops without blanking", async () => {
    vi.useFakeTimers();
    try {
      setupGatewayDown();
      render(<DesktopApp />);
      await act(async () => {
        await Promise.resolve();
      });

      const mountCalls = sessionsApi.mock.calls.length;
      reopenSocket();
      await act(async () => {
        await Promise.resolve();
      });
      expect(sessionsApi.mock.calls.length).toBeGreaterThan(mountCalls);

      // Bounded retries: the backoff schedule is finite, not an infinite poll.
      const afterReconnect = sessionsApi.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      const total = sessionsApi.mock.calls.length;
      expect(total).toBeGreaterThan(afterReconnect);
      expect(total).toBeLessThan(afterReconnect + 10);

      // Still nothing was blanked, and the error stayed visible.
      expect(screen.getByTestId("history-error")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
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
import { resetLastSession, DASHBOARD_SESSION_KEY, clearResetFlag } from "@/lib/useLastSession";
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
    expect(await screen.findByText(/Say hello to Sarathy/)).toBeInTheDocument();
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

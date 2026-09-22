import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

import { api } from "@/lib/api";
import DesktopApp from "@/App";
import MobileApp from "@/mobile/App";

function setupSessions() {
  const sessions = vi.mocked(api.sessions);
  const session = vi.mocked(api.session);

  sessions.mockResolvedValue({
    sessions: [
      {
        key: "dashboard:console",
        created_at: "2026-01-01T00:00:00",
        updated_at: "2026-01-01T00:00:00",
        path: "/ws/sess.json",
      },
    ],
  });
  session.mockResolvedValue({
    key: "dashboard:console",
    createdAt: "2026-01-01T00:00:00",
    messages: [
      { role: "user", content: "hello prior", timestamp: "t1" },
      { role: "assistant", content: "hi back prior", timestamp: "t2" },
    ],
  });
  return { sessions, session };
}

describe("Last session load — desktop App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads dashboard:console history into the chat on mount", async () => {
    setupSessions();
    render(<DesktopApp />);

    expect(await screen.findByText("hello prior")).toBeInTheDocument();
    expect(screen.getByText("hi back prior")).toBeInTheDocument();
  });

  it("keeps chat empty when no sessions exist", async () => {
    vi.mocked(api.sessions).mockResolvedValue({ sessions: [] });

    render(<DesktopApp />);

    await waitFor(() => expect(api.sessions).toHaveBeenCalled());
    expect(await screen.findByText(/Say hello to Sarathy/)).toBeInTheDocument();
    expect(screen.queryByText("hello prior")).not.toBeInTheDocument();
  });

  it("does not crash when history contains null-content assistant tool rows (real dashboard:console shape)", async () => {
    // Regression: the live dashboard:console session stores assistant tool-call
    // rows with `content: null` alongside normal text messages. These must be
    // filtered out at load — rendering them crashed MessageRow's
    // `message.content.length` and unmounted the app (blank screen, 0.6.0).
    vi.mocked(api.sessions).mockResolvedValue({
      sessions: [{ key: "dashboard:console", created_at: "t", updated_at: "t" }],
    });
    vi.mocked(api.session).mockResolvedValue({
      key: "dashboard:console",
      createdAt: "t",
      messages: [
        { role: "user", content: "hello prior", timestamp: "t1" },
        { role: "assistant", content: "", timestamp: "t2" },
        { role: "tool", content: "some tool result", timestamp: "t3" },
        { role: "assistant", content: "hi back prior", timestamp: "t4" },
      ],
    });

    render(<DesktopApp />);

    // Real text messages still render; null-content tool rows must not crash.
    expect(await screen.findByText("hello prior")).toBeInTheDocument();
    expect(screen.getByText("hi back prior")).toBeInTheDocument();
  });
});

describe("Last session load — mobile App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads dashboard:console history into the chat on mount", async () => {
    setupSessions();
    render(<MobileApp />);

    expect(await screen.findByText("hello prior")).toBeInTheDocument();
    expect(screen.getByText("hi back prior")).toBeInTheDocument();
  });

  it("keeps chat empty when the session has no messages", async () => {
    vi.mocked(api.sessions).mockResolvedValue({
      sessions: [{ key: "dashboard:console", created_at: "t", updated_at: "t" }],
    });
    vi.mocked(api.session).mockResolvedValue({
      key: "dashboard:console",
      createdAt: "t",
      messages: [],
    });

    render(<MobileApp />);

    expect(await screen.findByText(/Say hello to Sarathy/)).toBeInTheDocument();
    expect(screen.queryByText("hello prior")).not.toBeInTheDocument();
  });
});

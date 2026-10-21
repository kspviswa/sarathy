import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";

/**
 * The Ask history shortcut (job 150 §C).
 *
 * The Ask history lives in the Sessions surface, behind its `Chats / Asks`
 * switch. The Ask canvas carries a history icon button that takes the user
 * there — from a cold Ask tab, with nothing loaded.
 */

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
      contextPercent: null,
      model: null,
      provider: null,
      messageCount: 0,
    }),
    commands: vi.fn().mockResolvedValue({ commands: [], count: 0 }),
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionsArchive: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionArchive: vi.fn().mockResolvedValue({
      id: "session-2026-10-13T20-31.jsonl",
      key: "telegram:1",
      channel: "telegram",
      createdAt: "",
      messages: [],
    }),
    pushKey: vi.fn().mockResolvedValue({ publicKey: "test", available: false }),
    pushSubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    workspaceTree: vi.fn().mockResolvedValue({ root: "/ws", tree: [] }),
    jobs: vi.fn().mockResolvedValue({ jobs: [] }),
    job: vi.fn().mockResolvedValue({ job: null, events: [], spec_text: null, result_text: null }),
    getConfig: vi.fn().mockResolvedValue({}),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    modalities: vi.fn().mockResolvedValue({
      main: { provider: "", model: "" },
      local: { provider: "", model: "" },
      image: { provider: "", model: "" },
      active: "",
    }),
    usageSummary: vi.fn().mockResolvedValue({ available: false }),
    status: vi
      .fn()
      .mockResolvedValue({ version: "0.19.4", gateway: { running: true }, channels: [], providers: [] }),
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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: any) => React.cloneElement(children, props),
  TooltipContent: () => null,
}));

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => <div data-testid="logo" data-size={size} />,
}));

vi.mock("@/lib/useLastSession", () => ({
  useLastSession: vi.fn().mockReturnValue(false),
  resetLastSession: vi.fn(),
  DASHBOARD_SESSION_KEY: "dashboard:console",
}));

import DesktopApp from "@/App";
import MobileApp from "@/mobile/App";
import { setActiveAskThreadId } from "@/lib/ask";

/** The gateway's Ask endpoints — the list and an empty history. */
function stubGateway() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/api/ask/threads")) {
        return new Response(JSON.stringify({ threads: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setActiveAskThreadId(null);
  stubGateway();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("The Ask history shortcut — the shell navigates to the history", () => {
  it("the desktop shell switches to the Sessions surface", async () => {
    render(<DesktopApp />);
    await act(async () => {
      await Promise.resolve();
    });

    // The Ask tab.
    fireEvent.click(screen.getByTestId("nav-ask"));
    await waitFor(() => expect(screen.getByTestId("ask-surface")).toBeInTheDocument());

    // The history button — a cold Ask tab, nothing loaded.
    expect(screen.getByTestId("ask-history")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ask-history"));

    // The Sessions surface, with the Ask list selected.
    await waitFor(() => expect(screen.getByTestId("sessions-view")).toBeInTheDocument());
    expect(screen.getByTestId("sessions-mode-asks")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("the mobile shell switches to the Sessions tab", async () => {
    render(<MobileApp />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("mobile-tab-ask"));
    await waitFor(() => expect(screen.getByTestId("ask-mobile")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-history"));

    await waitFor(() => expect(screen.getByTestId("mobile-sessions")).toBeInTheDocument());
    expect(screen.getByTestId("sessions-mode-asks")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

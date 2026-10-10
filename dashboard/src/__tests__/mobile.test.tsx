import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
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
import { api } from "@/lib/api";

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
});

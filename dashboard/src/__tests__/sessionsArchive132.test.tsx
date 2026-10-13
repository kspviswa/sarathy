/**
 * Job 132 §F — the frontend half of the archive browser.
 *
 * Three things are asserted here, all of them the actual complaints:
 *  1. The Sessions tab reads `/api/sessions/archive`, not `/api/sessions`, and
 *     opens a transcript by ARCHIVE ID — so `/new`'s archives are browsable.
 *  2. User bubbles are markdown, exactly like assistant ones (`` `x` `` becomes
 *     a real `<code>`), and no tool row can reach the transcript.
 *  3. Tab and bubble motion exists but is gated on `prefers-reduced-motion`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: {
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    session: vi.fn().mockResolvedValue({ key: "", createdAt: "", messages: [] }),
    sessionsArchive: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionArchive: vi
      .fn()
      .mockResolvedValue({ id: "", key: "", channel: "", createdAt: "", messages: [] }),
    me: vi.fn().mockResolvedValue({ ok: true }),
    status: vi.fn().mockResolvedValue({ version: "0.17.3", gateway: { running: true } }),
    commands: vi.fn().mockResolvedValue({ commands: [], count: 0 }),
    sessionFooter: vi.fn().mockResolvedValue(null),
    workspaceTree: vi.fn().mockResolvedValue({ root: "/ws", tree: [] }),
    jobs: vi.fn().mockResolvedValue({ jobs: [] }),
    usageSummary: vi.fn().mockResolvedValue({ available: false }),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    pushKey: vi.fn().mockResolvedValue({ publicKey: "k", available: false }),
    getConfig: vi.fn().mockResolvedValue({}),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
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

// App-shell plumbing: the shell owns the tooltip context, the theme provider and
// the socket, none of which are under test here.
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

vi.mock("@/lib/useLastSession", () => ({
  useLastSession: vi.fn().mockReturnValue(false),
  resetLastSession: vi.fn(),
  DASHBOARD_SESSION_KEY: "dashboard:console",
}));

vi.mock("@/lib/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "dark", resolved: "dark", setTheme: vi.fn() }),
}));

// Radix tooltip needs a provider the app shell owns; stub it out so the chat
// composer renders standalone.
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: any) => React.cloneElement(children, props),
  TooltipContent: () => null,
}));

import { api } from "@/lib/api";
import { SessionsView } from "@/views/SessionsView";
import { SessionsView as MobileSessionsView } from "@/mobile/SessionsView";
import { ChatView } from "@/views/ChatView";
import App from "@/App";

const ARCHIVE_ID = "session-2026-10-13T20-31.jsonl";

/** Local `YYYY-MM-DD`, the calendar's dateKey format. */
function todayDateKey(): string {
  const d = new Date();
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const ARCHIVES = [
  {
    id: ARCHIVE_ID,
    key: "telegram:7",
    channel: "telegram",
    topic: null,
    created_at: `${todayDateKey()}T10:00:00Z`,
    updated_at: `${todayDateKey()}T10:05:00Z`,
    preview: "check the archive",
    messageCount: 2,
  },
];

/** A user turn carrying markdown plus a reply — the transcript's raw shape. */
const TRANSCRIPT = {
  id: ARCHIVE_ID,
  key: "telegram:7",
  channel: "telegram",
  createdAt: "2026-10-13T20:31:00Z",
  messages: [
    { role: "user", content: "run `this is a code` please" },
    { role: "assistant", content: "Done — and **bold** too." },
  ],
};

function mockArchive() {
  vi.mocked(api.sessionsArchive).mockResolvedValue({ sessions: ARCHIVES });
  vi.mocked(api.sessionArchive).mockResolvedValue(TRANSCRIPT);
}

/** Drive the calendar → day → channel → session drill-down. */
async function drillToRow() {
  fireEvent.click(await screen.findByTestId(`calendar-day-${todayDateKey()}`));
  fireEvent.click(await screen.findByTestId("day-channel"));
  fireEvent.click(await screen.findByTestId("archive-row"));
}

beforeEach(() => {
  mockArchive();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Sessions tab browses ARCHIVES (job 132 §C)", () => {
  it("reads /api/sessions/archive, never the active-sessions list", async () => {
    render(<SessionsView />);
    await waitFor(() => expect(api.sessionsArchive).toHaveBeenCalled());
    expect(api.sessions).not.toHaveBeenCalled();
  });

  it("opens a transcript by archive id, not by session key", async () => {
    render(<SessionsView />);
    await drillToRow();

    await waitFor(() => expect(api.sessionArchive).toHaveBeenCalledWith(ARCHIVE_ID));
    expect(api.sessionArchive).not.toHaveBeenCalledWith("telegram:7");
    // The active-transcript endpoint stays unused by this tab.
    expect(api.session).not.toHaveBeenCalled();
  });

  it("renders a user bubble as markdown, like the assistant one", async () => {
    const { container } = render(<SessionsView />);
    await drillToRow();
    await screen.findByText(/Done — and/);

    const userBubble = screen.getByTestId("transcript-user");
    // `` `this is a code` `` is a real inline <code>, not literal backticks.
    const code = userBubble.querySelector("code");
    expect(code).toBeTruthy();
    expect(code?.textContent).toBe("this is a code");
    expect(userBubble.textContent).not.toContain("`");

    // The assistant side is unchanged.
    const assistant = screen.getByTestId("transcript-assistant");
    expect(assistant.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelectorAll(".md").length).toBeGreaterThanOrEqual(2);
  });

  it("never renders a tool row, even if one arrives", async () => {
    vi.mocked(api.sessionArchive).mockResolvedValue({
      ...TRANSCRIPT,
      messages: [
        ...TRANSCRIPT.messages,
        { role: "tool", content: "TOOL OUTPUT" },
        { role: "assistant", content: "" },
      ],
    });

    render(<SessionsView />);
    await drillToRow();
    await screen.findByText(/Done — and/);

    expect(document.body.textContent).not.toContain("TOOL OUTPUT");
    expect(screen.getAllByTestId("transcript-assistant")).toHaveLength(1);
  });

  it("mobile renders the same markdown user bubble", async () => {
    render(<MobileSessionsView />);
    await drillToRow();
    await screen.findByText(/Done — and/);

    const userBubble = screen.getByTestId("transcript-user");
    expect(userBubble.querySelector("code")?.textContent).toBe("this is a code");
  });

  it("shows an empty state when nothing is archived yet", async () => {
    vi.mocked(api.sessionsArchive).mockResolvedValue({ sessions: [] });
    render(<SessionsView />);
    expect(await screen.findByTestId("sessions-empty")).toBeInTheDocument();
  });
});

describe("Open as new thread (job 132 §C)", () => {
  it("hands the last user message to the shell", async () => {
    const onOpenThread = vi.fn();
    render(<SessionsView onOpenThread={onOpenThread} />);
    await drillToRow();

    fireEvent.click(await screen.findByTestId("session-open-thread"));
    expect(onOpenThread).toHaveBeenCalledWith("run `this is a code` please");
  });

  it("copies the transcript to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<SessionsView />);
    await drillToRow();
    fireEvent.click(await screen.findByTestId("session-copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("You: run `this is a code` please");
    expect(copied).toContain("Sarathy: Done — and **bold** too.");
  });
});

describe("motion is present but reduced-motion aware (job 132 §E)", () => {
  const css = readFileSync(resolve(__dirname, "../index.css"), "utf-8");

  it("declares the keyframes and a prefers-reduced-motion guard for both", () => {
    expect(css).toContain("@keyframes section-in");
    expect(css).toContain("@keyframes bubble-in");
    // `backwards`, never `both`: a retained `transform` would make the section
    // host the containing block for the chat's non-portalled fixed quote bar.
    expect(css).toContain("animation: section-in 180ms ease-out backwards");
    expect(css).toContain("animation: bubble-in 200ms ease-out backwards");
    expect(css).not.toMatch(/animation: (section|bubble)-in [^;]*\bboth\b/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.section-in,[\s\S]*?\.bubble-in[\s\S]*?animation: none/,
    );
  });

  it("an opened transcript replays the entry transition", async () => {
    render(<SessionsView />);
    await drillToRow();
    await screen.findByText(/Done — and/);
    expect(screen.getByTestId("transcript-body").className).toContain("section-in");
  });

  it("tab buttons carry a transition that opts out under reduced motion", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    const active = screen.getByTestId("nav-chat");
    expect(active.className).toContain("transition-");
    expect(active.className).toContain("motion-reduce:transition-none");
    // The section host animates its swap, under the same gate.
    expect(screen.getByTestId("main-content").className).toContain("section-in");
  });

  it("a live-chat user bubble renders markdown too (job 132 §D)", () => {
    render(
      <ChatView
        messages={[
          { role: "user", content: "run `this is a code`\n\n- one\n- two" },
          { role: "assistant", content: "ok" },
        ]}
        streaming={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    const bubble = screen.getByTestId("message-row-user");
    // Inline code is a real element, not literal backticks...
    expect(bubble.querySelector("code")?.textContent).toBe("this is a code");
    expect(bubble.textContent).not.toContain("`");
    // ...and lists are lists.
    expect(bubble.querySelectorAll("li")).toHaveLength(2);
    // It must not drag in the heavy openUI renderer for a user turn.
    expect(bubble.querySelector(".openui-block")).toBeNull();
  });

  it("only the newest chat bubble animates in", () => {
    render(
      <ChatView
        messages={[
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
        ]}
        streaming={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    const rows = document.querySelectorAll(".bubble-in");
    expect(rows).toHaveLength(1);
    // ...and it is the last row, so existing history does not re-animate.
    const all = document.querySelectorAll("[data-testid^='message-row-']");
    expect(all).toHaveLength(2);
    expect(rows[0]).toContainElement(all[1]);
  });
});
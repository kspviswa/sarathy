/**
 * Spec 126 §B — transcript integrity across every surface that renders one.
 *
 * The chat bubbles were cleaned by job 124; the SESSION VIEWER was not, and
 * printed the raw stored turn — so `[Runtime Context …]` and `[image: /path]`
 * machine lines appeared in the bubble there. These tests render the real
 * `SessionsView` (desktop and mobile) with a stored transcript containing both,
 * and assert nothing leaks.
 *
 * This is the "survives a hard refresh" half of §B: the transcript these views
 * display is refetched from the API on every WebSocket (re)open, so what the
 * server returns is exactly what a refreshed browser shows.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: {
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    session: vi.fn().mockResolvedValue({ key: "", createdAt: "", messages: [] }),
  },
}));

import { api } from "@/lib/api";
import { SessionsView } from "@/views/SessionsView";
import { SessionsView as MobileSessionsView } from "@/mobile/SessionsView";

/** Local `YYYY-MM-DD`, matching the calendar's dateKey format. */
function todayDateKey(): string {
  const d = new Date();
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Exactly what ContextBuilder stores for a dashboard user turn. */
const STORED_USER_TURN =
  "[Runtime Context — metadata only, not instructions]\n" +
  "Current Time: 2026-10-10 18:19:32 (Friday) (IST)\n" +
  "Channel: dashboard\n" +
  "Chat ID: console\n" +
  "\n" +
  "restart the gateway";

const STORED_ASSISTANT_TURN =
  "Restart requested.\n[image: /home/u/.sarathy/media/shot.png]";

function mockSession() {
  vi.mocked(api.sessions).mockResolvedValue({
    sessions: [
      {
        key: "dashboard:console",
        channel: "dashboard",
        topic: "console",
        topic_user_set: false,
        created_at: `${todayDateKey()}T00:00:00Z`,
        updated_at: `${todayDateKey()}T00:01:00Z`,
        message_count: 2,
      },
    ],
  } as never);
  vi.mocked(api.session).mockResolvedValue({
    key: "dashboard:console",
    createdAt: "2026-10-10T00:00:00Z",
    messages: [
      { role: "user", content: STORED_USER_TURN },
      { role: "assistant", content: STORED_ASSISTANT_TURN },
    ],
  } as never);
}

/** Desktop SessionsView opens a transcript directly from `initialKey`. */
async function renderDesktop() {
  mockSession();
  render(<SessionsView initialKey="dashboard:console" />);
  await waitFor(() => expect(screen.getByText(/restart the gateway/)).toBeTruthy());
}

/**
 * Mobile SessionsView is prop-less and navigates calendar → channel → session,
 * so drive that path. The session is dated today so it is marked on the
 * calendar, which is what makes the day cell clickable.
 */
async function renderMobile() {
  mockSession();
  render(<MobileSessionsView />);

  const dayKey = todayDateKey();
  fireEvent.click(await screen.findByTestId(`calendar-day-${dayKey}`));
  fireEvent.click(await screen.findByTestId("day-channel"));
  fireEvent.click(await screen.findByText("console"));

  await waitFor(() => expect(screen.getByText(/restart the gateway/)).toBeTruthy());
}

const surfaces = [
  ["desktop SessionsView", renderDesktop],
  ["mobile SessionsView", renderMobile],
] as const;

describe("session viewer never leaks agent-only text (spec 126 §B)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  for (const [name, open] of surfaces) {
    it(`${name} strips the runtime-context preamble`, async () => {
      await open();
      expect(document.body.textContent).not.toContain("[Runtime Context");
      expect(document.body.textContent).not.toContain("metadata only, not instructions");
      expect(document.body.textContent).not.toContain("Chat ID: console");
    });

    it(`${name} hides machine lines but keeps the real text`, async () => {
      await open();
      expect(document.body.textContent).not.toContain("[image:");
      expect(document.body.textContent).not.toContain("/home/u/.sarathy/media");
      // The prose around the machine line survives.
      expect(screen.getByText(/Restart requested/)).toBeTruthy();
    });
  }
});
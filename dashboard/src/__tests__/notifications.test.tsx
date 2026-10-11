import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import type { NotificationFrame } from "@/lib/ws";
import { useNotifications } from "@/lib/useNotifications";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    session: vi.fn().mockResolvedValue({ key: "", createdAt: "", messages: [] }),
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
    usageSummary: vi.fn().mockResolvedValue({ available: false, window_days: 7, totals: { requests: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_hit_pct: 0 }, by_model: [], timeseries: [] }),
    jobs: vi.fn().mockResolvedValue({ jobs: [] }),
    job: vi.fn().mockResolvedValue({ job: null, events: [], spec_text: null, result_text: null }),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  // The notification controls call both `toast(...)` and `toast.info/error(...)`.
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  }),
  Toaster: () => null,
}));

import { toast } from "sonner";

import { NotificationCenter } from "@/components/NotificationCenter";
import { NotificationControls } from "@/components/NotificationControls";
import type { AppNotification } from "@/lib/useNotifications";

type NotifyHandler = (n: NotificationFrame) => void;

function makeSocket() {
  let handler: NotifyHandler | null = null;
  return {
    onNotification: vi.fn((cb: NotifyHandler) => {
      handler = cb;
      return () => {
        handler = null;
      };
    }),
    emit: (n: NotificationFrame) => handler?.(n),
  };
}

function frame(
  payload: Partial<NotificationFrame["payload"]> = {},
): NotificationFrame {
  return {
    type: "notification",
    payload: {
      title: "Backup done",
      body: "Backup completed",
      tab: "status",
      timestamp: "2026-08-28T00:00:00.000Z",
      ...payload,
    },
  };
}

const toastMock = toast as unknown as ReturnType<typeof vi.fn>;

describe("useNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.title = "Sarathy";
    vi.stubGlobal("navigator", {
      setAppBadge: vi.fn(() => Promise.resolve()),
      clearAppBadge: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.title = "Sarathy";
  });

  it("increments unreadCount, fires a toast and updates the app badge on a notification frame", () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useNotifications(socket as never));

    act(() => socket.emit(frame()));

    expect(result.current.unreadCount).toBe(1);
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]).toMatchObject({
      title: "Backup done",
      body: "Backup completed",
      tab: "status",
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith("Backup done", expect.any(Object));
    expect(navigator.setAppBadge).toHaveBeenCalledWith(1);
  });

  it("dedupes identical frames by timestamp+title", () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useNotifications(socket as never));

    act(() => socket.emit(frame()));
    act(() => socket.emit(frame()));
    act(() => socket.emit(frame({ title: "Second", timestamp: "2026-08-28T00:00:01.000Z" })));

    expect(result.current.unreadCount).toBe(2);
    expect(result.current.notifications).toHaveLength(2);
    expect(toastMock).toHaveBeenCalledTimes(2);
    expect(navigator.setAppBadge).toHaveBeenLastCalledWith(2);
  });

  it("caps the notification list at 50", () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useNotifications(socket as never));

    for (let i = 0; i < 55; i += 1) {
      act(() =>
        socket.emit(
          frame({
            title: `Notif ${i}`,
            timestamp: `2026-08-28T${String(i).padStart(2, "0")}:00:00.000Z`,
          }),
        ),
      );
    }

    expect(result.current.notifications).toHaveLength(50);
    expect(result.current.unreadCount).toBe(55);
    expect(result.current.notifications[0].title).toBe("Notif 54");
  });

  it("markAllRead resets the count and clears the app badge", () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useNotifications(socket as never));

    act(() => socket.emit(frame()));
    act(() => socket.emit(frame({ timestamp: "2026-08-28T00:00:01.000Z", title: "Second" })));
    expect(result.current.unreadCount).toBe(2);

    act(() => result.current.markAllRead());

    expect(result.current.unreadCount).toBe(0);
    expect(navigator.clearAppBadge).toHaveBeenCalled();
  });

  it("falls back to a (N) document.title prefix when the Badging API is unavailable", () => {
    vi.stubGlobal("navigator", {});
    const socket = makeSocket();
    const { result } = renderHook(() => useNotifications(socket as never));

    act(() => socket.emit(frame()));

    expect(navigator.setAppBadge).toBeUndefined();
    expect(document.title).toBe("(1) Sarathy");

    act(() => result.current.markAllRead());
    expect(document.title).toBe("Sarathy");
  });

  it("remove(id) drops the notification from the list", () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useNotifications(socket as never));

    act(() => socket.emit(frame()));
    const id = result.current.notifications[0].id;

    act(() => result.current.remove(id));

    expect(result.current.notifications).toHaveLength(0);
  });

  it("clicking the toast action marks all read and navigates to the tab", () => {
    const socket = makeSocket();
    const navigateTo = vi.fn();
    const { result } = renderHook(() =>
      useNotifications(socket as never, { navigateTo }),
    );

    act(() => socket.emit(frame()));
    const toastOptions = toastMock.mock.calls[0][1];

    act(() => toastOptions.action.onClick());

    expect(result.current.unreadCount).toBe(0);
    expect(navigator.clearAppBadge).toHaveBeenCalled();
    expect(navigateTo).toHaveBeenCalledWith("status");
  });

  it("remove drops one notification; clearAll empties the list and the badge", () => {
    const socket = makeSocket();
    const { result } = renderHook(() => useNotifications(socket as never));

    act(() => socket.emit(frame({ title: "One" })));
    act(() => socket.emit(frame({ title: "Two", timestamp: "2026-08-28T00:00:01.000Z" })));
    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.unreadCount).toBe(2);

    act(() => result.current.remove(result.current.notifications[0].id));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.unreadCount).toBe(1);

    act(() => result.current.clearAll());
    expect(result.current.notifications).toHaveLength(0);
    expect(result.current.unreadCount).toBe(0);
  });
});

/* ------------------------------------------------- §B controls: toggle + bell */

function notif(id: string, over: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    title: `Ping ${id}`,
    body: "body",
    tab: "jobs",
    timestamp: new Date().toISOString(),
    ...over,
  };
}

function renderControls(enabled: boolean | null) {
  const onEnabledChange = vi.fn();
  const utils = render(
    <NotificationControls
      enabled={enabled}
      onEnabledChange={onEnabledChange}
      notifications={[notif("1"), notif("2")]}
      unreadIds={["1", "2"]}
      onMarkAllRead={vi.fn()}
      onMarkRead={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
  return { ...utils, onEnabledChange };
}

describe("NotificationControls (toggle first, bell second)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", {
      serviceWorker: undefined,
      setAppBadge: vi.fn(() => Promise.resolve()),
      clearAppBadge: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the toggle when notifications are OFF, and no bell", () => {
    renderControls(false);
    expect(screen.getByTestId("notifications-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-toggle")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("notifications-bell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument();
  });

  it("renders toggle THEN bell when enabled, in that order", () => {
    renderControls(true);
    const controls = screen.getByTestId("notification-controls");
    const toggle = within(controls).getByTestId("notifications-toggle");
    const bell = within(controls).getByTestId("notifications-bell");

    expect(toggle).toBeInTheDocument();
    expect(bell).toBeInTheDocument();
    // The toggle must come first in the top bar.
    expect(
      toggle.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the unread badge count on the bell", () => {
    renderControls(true);
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("2");
  });

  it("renders no bell and a disabled toggle while the pref is still resolving", () => {
    renderControls(null);
    expect(screen.getByTestId("notifications-toggle")).toBeDisabled();
    expect(screen.queryByTestId("notifications-bell")).not.toBeInTheDocument();
  });

  it("toggling off asks the caller to disable notifications", () => {
    const { onEnabledChange } = renderControls(true);
    fireEvent.click(screen.getByTestId("notifications-toggle"));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });
});

/* ------------------------------------------------- §B2 macOS-style side panel */

describe("NotificationCenter panel (no dimming scrim)", () => {
  afterEach(cleanup);

  function renderPanel(over: Record<string, unknown> = {}) {
    return render(
      <NotificationCenter
        notifications={[notif("1")]}
        unreadIds={["1"]}
        open
        onOpenChange={vi.fn()}
        onMarkAllRead={vi.fn()}
        onMarkRead={vi.fn()}
        onNavigate={vi.fn()}
        {...over}
      />,
    );
  }

  it("has no full-screen dim scrim", () => {
    const { container } = renderPanel();

    // The old drawer's dimming overlay is gone for good.
    expect(screen.queryByTestId("notifications-scrim")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/notifications-scrim/);

    // Whatever covers the viewport must carry no background at all, so the
    // app behind the panel stays fully lit.
    const dismiss = screen.getByTestId("notifications-dismiss");
    expect(dismiss.className).not.toMatch(/bg-|backdrop-blur|opacity-/);
  });

  it("portals to <body> so the fixed panel escapes the blurred top bar", () => {
    const { container } = renderPanel();
    // The top bar has a backdrop-filter, which makes it a containing block for
    // `position: fixed`; without the portal the panel would be clipped to it.
    expect(within(container).queryByTestId("notifications-panel")).toBeNull();
    expect(document.body.querySelector('[data-testid="notifications-panel"]')).not.toBeNull();
  });

  it("renders as a right-anchored, full-height side panel", () => {
    renderPanel();
    const panel = screen.getByTestId("notifications-panel");
    expect(panel.className).toContain("fixed");
    expect(panel.className).toContain("inset-y-0");
    expect(panel.className).toContain("right-0");
    expect(panel.className).toContain("max-w-sm");
    expect(panel.className).toContain("border-l");
  });

  it("keeps the header, unread marker, timestamp and empty state", () => {
    renderPanel();
    const panel = screen.getByTestId("notifications-panel");
    expect(within(panel).getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-mark-all")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-time")).toBeInTheDocument();
    expect(screen.getAllByTestId("notifications-item")[0]).toHaveAttribute("data-unread", "true");

    cleanup();
    renderPanel({ notifications: [], unreadIds: [] });
    expect(screen.getByTestId("notifications-empty")).toHaveTextContent("No notifications yet");
  });
});

/**
 * Spec 126 §D — notification items show the FULL message and offer a follow-up.
 *
 * They used to `truncate` the title and `line-clamp-2` the body, so a long job
 * ping was cut off with no way to read the rest of it.
 */
describe("NotificationCenter full message + Reply (spec 126 §D)", () => {
  afterEach(cleanup);

  const LONG_TITLE =
    "Job 126 [feature] — completed · all backend suites green, frontend build clean";
  const LONG_BODY = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

  function renderPanel(over: Record<string, unknown> = {}) {
    const n: AppNotification = {
      id: "1",
      title: LONG_TITLE,
      body: LONG_BODY,
      tab: "jobs",
      timestamp: "2026-10-10T00:00:00.000Z",
    };
    return render(
      <NotificationCenter
        notifications={[n]}
        unreadIds={["1"]}
        open
        onOpenChange={vi.fn()}
        onMarkAllRead={vi.fn()}
        onMarkRead={vi.fn()}
        onNavigate={vi.fn()}
        {...over}
      />,
    );
  }

  it("does not truncate the title", () => {
    renderPanel();
    const title = screen.getByTestId("notifications-title");
    expect(title.className).not.toContain("truncate");
    expect(title.className).toContain("break-words");
  });

  it("does not clamp the body to two lines", () => {
    renderPanel();
    const body = screen.getByTestId("notifications-body");
    expect(body.className).not.toContain("line-clamp-2");
    expect(body.className).not.toContain("line-clamp");
    expect(body.className).not.toContain("truncate");
  });

  it("renders every line of a long body, not just the first two", () => {
    renderPanel();
    const body = screen.getByTestId("notifications-body");
    for (let i = 1; i <= 12; i++) {
      expect(body.textContent).toContain(`line ${i}`);
    }
  });

  it("renders the full title text, not an ellipsized fragment", () => {
    renderPanel();
    expect(screen.getByTestId("notifications-title").textContent).toBe(LONG_TITLE);
  });

  it("scrolls within the panel rather than clipping", () => {
    renderPanel();
    const list = screen.getByTestId("notifications-panel").querySelector(".overflow-y-auto");
    expect(list).not.toBeNull();
  });

  it("renders a job ping's bold header and working deep link, not literal tags", () => {
    renderPanel({
      notifications: [
        {
          id: "2",
          title: "Job 126 · completed",
          body:
            "<b>Job 126 [feature]</b> — completed\nAll tests green.\n\n" +
            '<a href="https://skandpriya.com/dashboard/#/jobs/126">Open in dashboard</a>',
          tab: "jobs",
          timestamp: "2026-10-10T00:00:00.000Z",
        } satisfies AppNotification,
      ],
      unreadIds: ["2"],
    });
    const body = screen.getByTestId("notifications-body");
    // Bold rendered as an element, not escaped source.
    expect(body.querySelector("b")).not.toBeNull();
    expect(body.textContent).not.toContain("<b>");
    // Link rendered as a real anchor with its href intact.
    const link = body.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://skandpriya.com/dashboard/#/jobs/126");
    expect(link?.textContent).toBe("Open in dashboard");
  });

  it("strips scripts from a notification body", () => {
    renderPanel({
      notifications: [
        {
          id: "3",
          title: "t",
          body: '<script>alert(1)</script>ok<a href="javascript:alert(1)">x</a>',
          timestamp: "2026-10-10T00:00:00.000Z",
        } satisfies AppNotification,
      ],
      unreadIds: ["3"],
    });
    const body = screen.getByTestId("notifications-body");
    expect(body.querySelector("script")).toBeNull();
    expect(body.innerHTML).not.toContain("javascript:");
  });

  it("offers a Reply action per item when onReply is provided", () => {
    const onReply = vi.fn();
    renderPanel({ onReply });
    const reply = screen.getByTestId("notifications-reply");
    expect(reply).toHaveTextContent("Reply");

    fireEvent.click(reply);
    expect(onReply).toHaveBeenCalledTimes(1);
    // It hands over the notification itself, so the caller can quote it into
    // the current chat.
    expect(onReply.mock.calls[0][0]).toMatchObject({
      title: LONG_TITLE,
      body: LONG_BODY,
      tab: "jobs",
    });
  });

  it("omits Reply when no handler is wired", () => {
    renderPanel();
    expect(screen.queryByTestId("notifications-reply")).toBeNull();
  });

  it("Reply does NOT mark read or navigate — it quotes into the current chat", () => {
    const onMarkRead = vi.fn();
    const onNavigate = vi.fn();
    const onOpenChange = vi.fn();
    renderPanel({ onReply: vi.fn(), onMarkRead, onNavigate, onOpenChange });

    fireEvent.click(screen.getByTestId("notifications-reply"));

    expect(onMarkRead).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("tapping the body keeps the pre-existing mark-read + navigate behavior", () => {
    const onMarkRead = vi.fn();
    const onNavigate = vi.fn();
    const onOpenChange = vi.fn();
    renderPanel({ onReply: vi.fn(), onMarkRead, onNavigate, onOpenChange });

    fireEvent.click(screen.getByTestId("notifications-item"));

    expect(onMarkRead).toHaveBeenCalledWith("1");
    expect(onNavigate).toHaveBeenCalledWith("jobs");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the macOS look — no dim scrim reintroduced", () => {
    renderPanel({ onReply: vi.fn() });
    expect(screen.queryByTestId("notifications-scrim")).toBeNull();
    const dismiss = screen.getByTestId("notifications-dismiss");
    expect(dismiss.className).not.toMatch(/bg-|backdrop-blur|opacity-/);
  });
});

/* ----------------------------- §E delete / clear-all / swipe (mobile opt-in) */

/**
 * Delete, clear-all and swipe are OPT-IN props on the shared panel. A surface
 * that does not pass them (the desktop SPA) must render exactly as before —
 * that is what keeps the desktop UI frozen while the mobile SPA gains the
 * affordances.
 */
describe("NotificationCenter delete + clear all + swipe (opt-in)", () => {
  afterEach(cleanup);

  function renderPanel(over: Record<string, unknown> = {}) {
    return render(
      <NotificationCenter
        notifications={[notif("1"), notif("2")]}
        unreadIds={["1"]}
        open
        onOpenChange={vi.fn()}
        onMarkAllRead={vi.fn()}
        onMarkRead={vi.fn()}
        onNavigate={vi.fn()}
        {...over}
      />,
    );
  }

  it("adds no delete/clear/swipe affordance when the surface does not opt in (desktop unchanged)", () => {
    renderPanel();
    expect(screen.queryByTestId("notifications-delete")).toBeNull();
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();
    expect(screen.queryByTestId("swipe-row")).toBeNull();
  });

  it("renders a per-row delete control that removes that notification", () => {
    const onDelete = vi.fn();
    renderPanel({ onDelete, onClearAll: vi.fn() });

    const deletes = screen.getAllByTestId("notifications-delete");
    expect(deletes).toHaveLength(2);
    fireEvent.click(deletes[0]);
    expect(onDelete).toHaveBeenCalledWith("1");
    // Deleting must not also trigger the row's mark-read/navigate.
    expect(screen.getAllByTestId("notifications-item")).toHaveLength(2);
  });

  it("renders a Clear all control wired to onClearAll", () => {
    const onClearAll = vi.fn();
    renderPanel({ onDelete: vi.fn(), onClearAll });
    fireEvent.click(screen.getByTestId("notifications-clear-all"));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("wraps each row in a swipe container only when swipeToDismiss is set", () => {
    renderPanel({ onDelete: vi.fn(), swipeToDismiss: true });
    expect(screen.getAllByTestId("swipe-row")).toHaveLength(2);
  });
});


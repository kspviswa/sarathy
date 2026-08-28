import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { NotificationFrame } from "@/lib/ws";
import { useNotifications } from "@/lib/useNotifications";

vi.mock("sonner", () => ({
  toast: vi.fn(),
  Toaster: () => null,
}));

import { toast } from "sonner";

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
});
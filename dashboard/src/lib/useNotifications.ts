import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { DashboardSocket, NotificationFrame } from "@/lib/ws";

export interface AppNotification {
  id: string;
  title: string;
  body?: string;
  tab?: string;
  timestamp: string;
}

export interface UseNotificationsOptions {
  navigateTo?: (tab: string) => void;
  onMarkAllRead?: () => void;
}

const MAX_NOTIFICATIONS = 50;

function supportsBadging(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.setAppBadge === "function" &&
    typeof navigator.clearAppBadge === "function"
  );
}

function updateAppBadge(count: number): void {
  if (!supportsBadging()) return;
  try {
    const result =
      count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {
    // Badging API unavailable at call time; degrade to title fallback.
  }
}

/**
 * Subscribe once to ws.onNotification, keep a capped list of notifications,
 * and surface an unread badge via the Badging API (with document.title
 * fallback). markAllRead() clears the unread count and the PWA/app badge.
 */
export function useNotifications(
  socket: DashboardSocket | null,
  options?: UseNotificationsOptions,
) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const seen = useRef(new Set<string>());
  const counter = useRef(0);
  const baseTitle = useRef(
    typeof document !== "undefined" ? document.title : "Sarathy",
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!socket) return;
    return socket.onNotification((frame: NotificationFrame) => {
      const { title, body, tab, timestamp } = frame.payload;
      const stamp = timestamp ?? new Date().toISOString();
      const dedupeKey = `${stamp}|${title}`;
      if (seen.current.has(dedupeKey)) return;
      seen.current.add(dedupeKey);

      const notification: AppNotification = {
        id: `${stamp}-${counter.current}`,
        title,
        body,
        tab,
        timestamp: stamp,
      };
      counter.current += 1;

      setNotifications((prev) =>
        [notification, ...prev].slice(0, MAX_NOTIFICATIONS),
      );
      setUnreadCount((prev) => prev + 1);

      toast(title, {
        description: body,
        action: {
          label: tab ? "View" : "Read",
          onClick: () => {
            markAllRead();
            if (tab) optionsRef.current?.navigateTo?.(tab);
          },
        },
      });
    });
  }, [socket]);

  useEffect(() => {
    if (supportsBadging()) {
      updateAppBadge(unreadCount);
    } else {
      document.title =
        unreadCount > 0
          ? `(${unreadCount}) ${baseTitle.current}`
          : baseTitle.current;
    }
  }, [unreadCount]);

  const markAllRead = useCallback(() => {
    setUnreadCount(0);
    optionsRef.current?.onMarkAllRead?.();
  }, []);

  const remove = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { notifications, unreadCount, markAllRead, remove };
}
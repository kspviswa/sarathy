import { Bell } from "lucide-react";

import { NotificationCenter } from "@/components/NotificationCenter";
import type { AppNotification } from "@/lib/useNotifications";
import { cn } from "@/lib/utils";

/**
 * The notification bell + unread badge (spec 125 §B1).
 *
 * Purely presentational: it renders only when notifications are ENABLED (its
 * caller, `NotificationControls`, decides that) and does nothing but open the
 * macOS-style notification center. Enable/disable lives in the top-bar toggle
 * next to it.
 */
export function NotificationBell({
  unreadIds,
  open,
  onOpenChange,
  notifications,
  onMarkAllRead,
  onMarkRead,
  onNavigate,
  onReply,
  onDelete,
  onClearAll,
  swipeToDismiss,
  notificationsEnabled = true,
  onNotificationsEnabledChange,
  className,
}: {
  unreadIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: AppNotification[];
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onNavigate: (tab: string) => void;
  /** Forwarded to the panel's per-item Reply action. */
  onReply?: (notification: AppNotification) => void;
  /** Forwarded to the panel's per-item delete action. */
  onDelete?: (id: string) => void;
  /** Forwarded to the panel's "Clear all" action. */
  onClearAll?: () => void;
  /** Forwarded to the panel — enable touch swipe-to-dismiss. */
  swipeToDismiss?: boolean;
  /** Forwarded to the panel's secondary enable/disable switch. */
  notificationsEnabled?: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
  className?: string;
}) {
  const unreadCount = unreadIds.length;

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label="Notifications"
        aria-expanded={open}
        title="Notifications"
        data-testid="notifications-bell"
        className={cn(
          "relative inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
          className,
        )}
      >
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground tabular-nums"
            data-testid="notifications-badge"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <NotificationCenter
          notifications={notifications}
          unreadIds={unreadIds}
          open={open}
          onOpenChange={onOpenChange}
          onMarkAllRead={onMarkAllRead}
          onMarkRead={onMarkRead}
          onNavigate={onNavigate}
          onReply={onReply}
          onDelete={onDelete}
          onClearAll={onClearAll}
          swipeToDismiss={swipeToDismiss}
          notificationsEnabled={notificationsEnabled}
          onNotificationsEnabledChange={onNotificationsEnabledChange}
        />
      )}
    </>
  );
}

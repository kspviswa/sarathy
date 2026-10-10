import { BellRing, CheckCheck, X } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { relativeTime } from "@/lib/relativeTime";
import type { AppNotification } from "@/lib/useNotifications";
import { cn } from "@/lib/utils";

/**
 * Right-side notification drawer (spec §D).
 *
 * The bell lives in `NotificationBell` (single-bell control); this component is
 * only the viewing surface. When `onNotificationsEnabledChange` is provided the
 * header renders an on/off switch so notifications can be disabled from inside
 * the drawer (which also turns off the feed/badge and best-effort unsubscribes
 * push).
 */
export function NotificationCenter({
  notifications,
  unreadIds,
  open,
  onOpenChange,
  onMarkAllRead,
  onMarkRead,
  onNavigate,
  notificationsEnabled = true,
  onNotificationsEnabledChange,
  className,
}: {
  notifications: AppNotification[];
  unreadIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onNavigate: (tab: string) => void;
  /** Present when the caller owns the single on/off notification control. */
  notificationsEnabled?: boolean;
  onNotificationsEnabledChange?: (enabled: boolean) => void;
  className?: string;
}) {
  const unreadCount = unreadIds.length;

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-background/40 backdrop-blur-[2px]"
      onClick={() => onOpenChange(false)}
      data-testid="notifications-scrim"
    >
      <aside
        className={cn("flex h-full w-full max-w-sm flex-col border-l border-border bg-background shadow-2xl", className)}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Notifications"
        data-testid="notifications-panel"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <BellRing className="size-4 text-muted-foreground" />
          <h2 className="flex-1 text-sm font-semibold">Notifications</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onMarkAllRead}
            disabled={unreadCount === 0}
            title="Mark all as read"
            data-testid="notifications-mark-all"
          >
            <CheckCheck className="size-3.5" />
            <span className="text-xs">Mark all read</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label="Close notifications"
          >
            <X className="size-4" />
          </Button>
        </div>

        {onNotificationsEnabledChange && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <label
              htmlFor="notifications-enabled"
              className="flex flex-1 items-center gap-2 text-sm"
            >
              Notifications
            </label>
            <Switch
              id="notifications-enabled"
              checked={notificationsEnabled}
              onCheckedChange={(checked) => {
                if (!checked) onOpenChange(false);
                onNotificationsEnabledChange(checked);
              }}
              data-testid="notifications-switch"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {notifications.length === 0 ? (
            <p
              className="px-4 py-10 text-center text-sm text-muted-foreground"
              data-testid="notifications-empty"
            >
              No notifications yet
            </p>
          ) : (
            <ul>
              {notifications.map((n) => {
                const unread = unreadIds.includes(n.id);
                return (
                  <li key={n.id} className="border-b border-border/60 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => {
                        onMarkRead(n.id);
                        onOpenChange(false);
                        if (n.tab) onNavigate(n.tab);
                      }}
                      data-testid="notifications-item"
                      data-unread={unread ? "true" : "false"}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors hover:bg-accent",
                        unread && "bg-accent/40",
                      )}
                    >
                      <span className="flex w-full items-center gap-2">
                        {unread && (
                          <span
                            className="size-1.5 shrink-0 rounded-full bg-primary"
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-sm",
                            unread ? "font-semibold" : "font-medium",
                          )}
                        >
                          {n.title}
                        </span>
                        <span
                          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                          data-testid="notifications-time"
                        >
                          {relativeTime(n.timestamp)}
                        </span>
                      </span>
                      {n.body && (
                        <span className="line-clamp-2 w-full text-xs text-muted-foreground">
                          {n.body}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
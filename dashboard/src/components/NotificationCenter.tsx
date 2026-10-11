import { BellRing, CheckCheck, CornerDownRight, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { SwipeRow } from "@/components/SwipeRow";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SAFE_REHYPE_PLUGINS, SafeLink } from "@/lib/markdown";
import { relativeTime } from "@/lib/relativeTime";
import type { AppNotification } from "@/lib/useNotifications";
import { cn } from "@/lib/utils";

/**
 * macOS-Notification-Center-style side panel (spec 125 §B2).
 *
 * The old drawer dimmed and blurred the entire app behind it, which made the
 * panel feel like a modal and Viswa read it as an ugly overlap. This one slides
 * in from the right, full height, with a left border + drop shadow and a
 * slightly translucent panel background — the app behind stays fully lit.
 *
 * The click-catcher below is transparent on purpose: it only exists so a click
 * outside closes the panel. It carries NO background, so nothing dims.
 *
 * The header keeps a secondary enable/disable switch; the primary toggle lives
 * in the top bar beside the bell (`NotificationControls`).
 *
 * It renders through a portal on <body>: the panel is `position: fixed`, and
 * the top bar that hosts the bell has a `backdrop-filter`, which makes it a
 * containing block for fixed descendants — without the portal the panel would
 * be clipped to the header instead of running the full height of the viewport.
 *
 * Items show the FULL message (spec 126 §D). They used to `truncate` the title
 * and `line-clamp-2` the body, so a long job ping was unreadable with no way to
 * reach the rest; the title now wraps, the body is unclamped, and the list
 * scrolls within the panel. Body text goes through the same sanitized markdown
 * pipeline as chat bubbles, so a job ping's bold header and deep link render
 * here exactly as they do on Telegram.
 *
 * Each item also offers "Reply", which quotes the notification into the session
 * already open (as a composer quote chip) so the follow-up is added as another
 * turn of the live conversation rather than spinning up a new session. Tapping
 * the body keeps the pre-existing mark-read + navigate behavior — the two are
 * separate controls, so a stray tap never silently throws away the current
 * conversation.
 */
export function NotificationCenter({
  notifications,
  unreadIds,
  open,
  onOpenChange,
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
  notifications: AppNotification[];
  unreadIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onNavigate: (tab: string) => void;
  /** Quote this notification into the current chat as the next turn. */
  onReply?: (notification: AppNotification) => void;
  /** Delete one notification. When provided, each row shows a delete control. */
  onDelete?: (id: string) => void;
  /** Clear the whole list. When provided, the header shows a "Clear all". */
  onClearAll?: () => void;
  /** Add a left swipe-to-dismiss gesture to each row (touch surfaces). */
  swipeToDismiss?: boolean;
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

  return createPortal(
    <>
      {/* Transparent click-catcher: closes the panel, dims nothing. */}
      <div
        className="fixed inset-0 z-40"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
        data-testid="notifications-dismiss"
      />
      <aside
        className={cn(
          "safe-top safe-bottom fixed inset-y-0 right-0 z-50 flex w-full max-w-sm animate-[notify-slide-in_180ms_ease-out] flex-col border-l border-border bg-background/95 shadow-[0_0_40px_-8px_rgb(0_0_0/0.35)] backdrop-blur-md supports-[backdrop-filter]:bg-background/80",
          className,
        )}
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
          {onClearAll && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClearAll}
              disabled={notifications.length === 0}
              aria-label="Clear all notifications"
              title="Clear all"
              data-testid="notifications-clear-all"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
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
                  <li
                    key={n.id}
                    className="border-b border-border/60 last:border-b-0"
                    data-testid="notifications-row"
                  >
                    <SwipeRow
                      onDismiss={
                        swipeToDismiss && onDelete ? () => onDelete(n.id) : undefined
                      }
                    >
                    <div
                      className={cn(
                        "relative flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left",
                        // Reserve room so the timestamp never sits under the X.
                        onDelete && "pr-9",
                      )}
                    >
                      {onDelete && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(n.id);
                          }}
                          data-testid="notifications-delete"
                          aria-label="Delete notification"
                          title="Delete"
                          className="absolute right-2 top-2.5 z-10 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
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
                          "flex w-full flex-col items-start gap-0.5 text-left transition-colors hover:bg-accent",
                          unread && "bg-accent/40",
                        )}
                      >
                        {/* Title wraps — no `truncate`: a long header must be
                            fully readable, with the timestamp beside it. */}
                        <span className="flex w-full items-start gap-2">
                          {unread && (
                            <span
                              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className={cn(
                              "min-w-0 flex-1 break-words text-sm",
                              unread ? "font-semibold" : "font-medium",
                            )}
                            data-testid="notifications-title"
                          >
                            {n.title}
                          </span>
                          <span
                            className="shrink-0 pt-0.5 text-[11px] text-muted-foreground tabular-nums"
                            data-testid="notifications-time"
                          >
                            {relativeTime(n.timestamp)}
                          </span>
                        </span>
                        {/* Full body — no `line-clamp-2`. Markdown + a
                            sanitized HTML subset, so a job ping's <b> and
                            deep link render instead of showing as source. */}
                        {n.body && (
                          <div
                            className="w-full break-words text-xs text-muted-foreground [&_a]:underline"
                            data-testid="notifications-body"
                          >
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={SAFE_REHYPE_PLUGINS}
                              components={{
                                a: ({ children, href, ...props }) => (
                                  <SafeLink
                                    {...props}
                                    href={href}
                                    onClick={(e) => {
                                      // The link is the notification's own deep
                                      // link: open it without also closing the
                                      // panel or marking the item navigated.
                                      e.stopPropagation();
                                    }}
                                  >
                                    {children}
                                  </SafeLink>
                                ),
                                p: ({ children }) => (
                                  <p className="mb-1 last:mb-0">{children}</p>
                                ),
                              }}
                            >
                              {n.body}
                            </ReactMarkdown>
                          </div>
                        )}
                      </button>

                      {onReply && (
                        <button
                          type="button"
                          onClick={() => onReply(n)}
                          data-testid="notifications-reply"
                          className={cn(
                            "mt-1.5 inline-flex items-center gap-1 rounded-md px-2 py-1",
                            "text-[11px] font-medium text-muted-foreground",
                            "transition-colors hover:bg-accent hover:text-foreground",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )}
                          title="Quote this notification into the current chat"
                        >
                          <CornerDownRight className="size-3" aria-hidden="true" />
                          Reply
                        </button>
                      )}
                    </div>
                    </SwipeRow>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
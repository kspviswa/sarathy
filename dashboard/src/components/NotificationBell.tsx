import { Bell, BellOff, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { NotificationCenter } from "@/components/NotificationCenter";
import { api } from "@/lib/api";
import {
  describePushSupport,
  detectPushSupport,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push";
import type { AppNotification } from "@/lib/useNotifications";
import { cn } from "@/lib/utils";

/**
 * The single notification bell (spec §D).
 *
 * Merges the old PushToggle + NotificationCenter into one control:
 *  - OFF: a muted bell-off icon. Clicking turns notifications on (web push
 *    subscribe when supported; the in-app feed/badge always comes on). If push
 *    is genuinely unavailable the real reason is surfaced as a toast rather
 *    than silently doing nothing.
 *  - ON: a bell with a red unread badge. Clicking opens the notification
 *    drawer, whose header hosts the on/off switch (disabling also
 *    best-effort unsubscribes web push).
 */
export function NotificationBell({
  enabled,
  onEnabledChange,
  notifications,
  unreadIds,
  onMarkAllRead,
  onMarkRead,
  onNavigate,
  className,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  notifications: AppNotification[];
  unreadIds: string[];
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onNavigate: (tab: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const support = detectPushSupport();
      if (support === "insecure" || support === "unsupported") {
        // Feed/badge still turns on; the user just learns why they get no push.
        toast.info(describePushSupport(support));
      } else {
        try {
          const { publicKey, available } = await api.pushKey();
          if (!available) {
            toast.error("Push is unavailable on the server");
          } else {
            const result = await subscribeToPush(publicKey);
            if (result.ok) {
              const registration = await navigator.serviceWorker.ready;
              const subscription = await registration.pushManager.getSubscription();
              const payload = subscription?.toJSON();
              if (payload) await api.pushSubscribe(payload);
            } else if (result.reason) {
              toast.info(result.reason);
            }
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not enable notifications");
        }
      }
      onEnabledChange(true);
    } finally {
      setBusy(false);
    }
  }, [onEnabledChange]);

  const disable = useCallback(async () => {
    setOpen(false);
    onEnabledChange(false);
    let unsubscribed = false;
    try {
      unsubscribed = await unsubscribeFromPush();
    } catch {
      unsubscribed = false;
    }
    if (unsubscribed) toast.info("Notifications disabled");
    else toast.info("Notifications turned off");
  }, [onEnabledChange]);

  const unreadCount = unreadIds.length;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!enabled) void enable();
          else setOpen((v) => !v);
        }}
        disabled={busy}
        aria-label={enabled ? "Notifications" : "Enable notifications"}
        aria-expanded={enabled ? open : undefined}
        title={enabled ? "Notifications" : "Enable notifications"}
        data-testid="notifications-bell"
        data-enabled={enabled}
        className={cn(
          "relative inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
          open && "bg-accent text-foreground",
          className,
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : enabled ? (
          <Bell className="size-4" />
        ) : (
          <BellOff className="size-4" />
        )}
        {enabled && unreadCount > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground tabular-nums"
            data-testid="notifications-badge"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {enabled && (
        <NotificationCenter
          notifications={notifications}
          unreadIds={unreadIds}
          open={open}
          onOpenChange={setOpen}
          onMarkAllRead={onMarkAllRead}
          onMarkRead={onMarkRead}
          onNavigate={onNavigate}
          notificationsEnabled={enabled}
          onNotificationsEnabledChange={(checked) => {
            if (checked) void enable();
            else void disable();
          }}
        />
      )}
    </>
  );
}
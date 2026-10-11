import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { NotificationBell } from "@/components/NotificationBell";
import { NotificationToggle } from "@/components/NotificationToggle";
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
 * Top-bar notification controls: TOGGLE first, BELL second (spec 125 §B1).
 *
 * The two were one merged control before, which made "is it on?" and "what
 * did I miss?" the same button and hid the unread count whenever notifications
 * were off. They are now separate:
 *  - `NotificationToggle` is always visible and owns enable/disable (web-push
 *    subscribe/unsubscribe, best-effort).
 *  - `NotificationBell` renders only when enabled and carries the unread badge.
 *
 * `enabled` is `null` until the persisted preference resolves; the toggle is
 * disabled and the bell stays hidden during that window so neither control
 * flashes the wrong state.
 */
export function NotificationControls({
  enabled,
  onEnabledChange,
  notifications,
  unreadIds,
  onMarkAllRead,
  onMarkRead,
  onNavigate,
  onReply,
  onDelete,
  onClearAll,
  swipeToDismiss,
  className,
}: {
  enabled: boolean | null;
  onEnabledChange: (enabled: boolean) => void;
  notifications: AppNotification[];
  unreadIds: string[];
  onMarkAllRead: () => void;
  onMarkRead: (id: string) => void;
  onNavigate: (tab: string) => void;
  /** Quote this notification into the current chat as the next turn. */
  onReply?: (notification: AppNotification) => void;
  /** Delete a single notification. Enables per-row delete controls. */
  onDelete?: (id: string) => void;
  /** Clear the whole notification list. */
  onClearAll?: () => void;
  /** Enable touch swipe-to-dismiss on notification rows. */
  swipeToDismiss?: boolean;
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

  const resolved = enabled !== null;
  const isOn = enabled === true;

  return (
    <div
      className={cn("flex items-center gap-2", className)}
      data-testid="notification-controls"
      data-resolved={resolved ? "true" : "false"}
      data-enabled={isOn ? "true" : "false"}
    >
      <NotificationToggle
        checked={isOn}
        disabled={!resolved || busy}
        onCheckedChange={(checked) => {
          if (checked) void enable();
          else void disable();
        }}
      />
      {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      {resolved && isOn && (
        <NotificationBell
          open={open}
          onOpenChange={setOpen}
          notifications={notifications}
          unreadIds={unreadIds}
          onMarkAllRead={onMarkAllRead}
          onMarkRead={onMarkRead}
          onNavigate={onNavigate}
          onReply={onReply}
          onDelete={onDelete}
          onClearAll={onClearAll}
          swipeToDismiss={swipeToDismiss}
          notificationsEnabled={isOn}
          onNotificationsEnabledChange={(checked) => {
            if (checked) void enable();
            else void disable();
          }}
        />
      )}
    </div>
  );
}

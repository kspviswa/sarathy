import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import {
  describePushSupport,
  detectPushSupport,
  hasExistingSubscription,
  subscribeToPush,
  type PushSupport,
} from "@/lib/push";
import { cn } from "@/lib/utils";

/**
 * Push notification subscribe button (spec §G).
 *
 * Honest about capability: it surfaces the *real* reason push is unavailable
 * (insecure context, unsupported browser, permission denied) instead of
 * silently doing nothing — which is exactly the iOS bug this feature exists to
 * fix.
 *
 * Deliberately does NOT attempt dock badges: PWAs cannot set them, and faking
 * it would just be a lie in the UI.
 */
export function PushToggle({ className }: { className?: string }) {
  const [support, setSupport] = useState<PushSupport>("unknown");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSupport(detectPushSupport());
    void hasExistingSubscription().then(setSubscribed);
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const { publicKey, available } = await api.pushKey();
      if (!available) {
        toast.error("Push is unavailable on the server");
        return;
      }
      const result = await subscribeToPush(publicKey);
      if (!result.ok) {
        toast.error(result.reason || "Could not enable notifications");
        return;
      }
      const json = await navigator.serviceWorker.ready.then(
        (reg) => reg.pushManager.getSubscription(),
      );
      const payload = json?.toJSON();
      if (payload) await api.pushSubscribe(payload);
      setSubscribed(true);
      setSupport("granted");
      toast.success("Notifications enabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  }, []);

  const unsupported = support === "unsupported" || support === "insecure";
  const Icon = subscribed ? Bell : BellOff;

  return (
    <button
      type="button"
      onClick={() => void enable()}
      disabled={busy || unsupported || support === "denied"}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
        className,
      )}
      title={
        unsupported || support === "denied"
          ? describePushSupport(support)
          : subscribed
            ? "Notifications enabled"
            : "Enable notifications"
      }
      aria-label={
        unsupported || support === "denied"
          ? describePushSupport(support)
          : "Enable notifications"
      }
      data-testid="push-toggle"
      data-subscribed={subscribed}
      data-support={support}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
    </button>
  );
}
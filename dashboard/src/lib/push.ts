/**
 * Web Push subscription lifecycle (browser side).
 *
 * Capability detection is deliberately explicit: iOS Safari only supports Web
 * Push from iOS 16.4+ and only for a PWA installed to the home screen, and it
 * requires a user gesture. We report the real reason instead of silently
 * failing, because "notifications don't work on my phone" was the exact bug
 * this feature exists to fix.
 */

export type PushSupport =
  | "granted"
  | "denied"
  | "default"
  | "unsupported" // no serviceWorker / no PushManager (older iOS, non-HTTPS)
  | "insecure" // PushManager requires a secure context
  | "unknown";

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  [key: string]: unknown;
}

export function detectPushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  // PushManager is gated behind secure contexts; http:// on a LAN is the most
  // common cause of "it silently does nothing".
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window)) return "unsupported";

  const permission = Notification.permission;
  if (permission === "granted" || permission === "denied") return permission;
  return "default";
}

/** Human-readable explanation for a support state. */
export function describePushSupport(support: PushSupport): string {
  switch (support) {
    case "granted":
      return "Notifications enabled";
    case "denied":
      return "Notifications blocked — enable them in your browser settings";
    case "default":
      return "Click to enable notifications";
    case "insecure":
      return "Push needs HTTPS (or localhost)";
    case "unsupported":
      return "This browser doesn't support Web Push. On iOS, install the app to your home screen (iOS 16.4+)";
    default:
      return "Notifications unavailable";
  }
}

/**
 * Whether a service worker is already controlling the page.
 *
 * iOS only grants push to an installed home-screen PWA, where the SW is always
 * active. On desktop the SW may still be installing after first paint.
 */
export function hasServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasServiceWorker()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** URL-safe base64 → Uint8Array (the VAPID key format browsers expect). */
export function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export interface SubscribeResult {
  ok: boolean;
  reason?: string;
  endpoint?: string;
}

/**
 * Subscribe this device to push.
 *
 * Must be called from a user gesture (click) — browsers reject the permission
 * prompt otherwise, and iOS rejects it outside an installed PWA.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<SubscribeResult> {
  const support = detectPushSupport();
  if (support === "unsupported" || support === "insecure") {
    return { ok: false, reason: describePushSupport(support) };
  }
  if (support === "denied") return { ok: false, reason: describePushSupport("denied") };

  const registration = await getRegistration();
  if (!registration) return { ok: false, reason: "Service worker not ready" };

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, reason: describePushSupport(permission) };
    }

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(vapidPublicKey) as BufferSource,
      }));

    const payload = subscription.toJSON() as PushSubscriptionPayload | null;
    if (!payload?.endpoint) return { ok: false, reason: "Subscription has no endpoint" };

    return { ok: true, endpoint: payload.endpoint };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Subscription failed",
    };
  }
}

/** Build the JSON body sent to `POST /api/push/subscribe`. */
export function buildSubscribeBody(payload: PushSubscriptionPayload): {
  subscription: PushSubscriptionPayload;
} {
  return { subscription: payload };
}

/** True when this browser already has a push subscription for the app. */
export async function hasExistingSubscription(): Promise<boolean> {
  const registration = await getRegistration();
  if (!registration) return false;
  try {
    return Boolean(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Unsubscribe locally and tell the server to drop it.
 *
 * Never throws: cleanup must not be able to break the UI.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  const registration = await getRegistration();
  if (!registration) return false;
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return false;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => null);
    return true;
  } catch {
    return false;
  }
}
/**
 * Web Push handler for the Sarathy dashboard service worker.
 *
 * Injected into the workbox-generated sw.js via `workbox.importScripts`, so
 * this file is the only place that deals with push payloads.
 *
 * Honest platform limits (documented deliberately):
 * - PWAs CANNOT set dock/app badges. That is a native-only capability, so we
 *   do not attempt it rather than shipping a badge that never appears.
 * - iOS may delay background delivery while the app is suspended; on tap we
 *   focus an existing client instead of relying on the notification alone.
 */

/* global self, clients */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    // A non-JSON payload should still surface as *something* rather than
    // silently dropping the notification on the floor.
    payload = { title: "Sarathy", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Sarathy";
  const options = {
    body: payload.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: payload.tag || "sarathy-message",
    data: { url: payload.url || "/" },
    // Background delivery can be delayed; don't auto-dismiss.
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client && client.url !== new URL(target, self.location.origin).href) {
            return client.navigate(target).then((navigated) => navigated && navigated.focus());
          }
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});
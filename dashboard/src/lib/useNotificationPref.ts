import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";

const STORAGE_KEY = "sarathy_notifications_enabled";
/** Hard bound on the server read so the control can never hang (spec 127 §D). */
const SERVER_READ_TIMEOUT_MS = 3000;

function readLocal(): boolean | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/**
 * On/off notification preference for the merged single-bell control (spec 125
 * §D, reworked by spec 127 §D).
 *
 * The toggle's usability must NOT depend on the service worker: `enabled` is
 * resolved SYNCHRONOUSLY from localStorage, defaulting to OFF when unset, so the
 * control is usable on the first paint. The service-worker state gates only the
 * actual push *subscription* action, never the toggle.
 *
 * The preference is server-owned (spec §D.2): once the (bounded) `/api/notifications/pref`
 * read resolves, its value wins and is cached locally for the next cold launch.
 */
export function useNotificationPref() {
  const [enabled, setEnabledState] = useState<boolean>(() => readLocal() ?? false);

  useEffect(() => {
    let mounted = true;
    const local = readLocal();
    const read =
      typeof api.notificationsPref === "function"
        ? api.notificationsPref().catch(() => null)
        : Promise.resolve(null);
    const bounded = Promise.race([
      read,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SERVER_READ_TIMEOUT_MS)),
    ]);
    bounded
      .then((res) => {
        if (!mounted || !res || typeof res.enabled !== "boolean") return;
        localStorage.setItem(STORAGE_KEY, String(res.enabled));
        // Only override a local value the server disagrees with; identical
        // values are a no-op so we don't cause a needless re-render.
        if (res.enabled !== local) setEnabledState(res.enabled);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(value));
    setEnabledState(value);
    // Fire-and-forget: the UI must never wait on the network to flip the toggle.
    try {
      if (typeof api.setNotificationsPref === "function") {
        void api.setNotificationsPref(value).catch(() => undefined);
      }
    } catch {
      /* best effort */
    }
  }, []);

  return { enabled, setEnabled };
}

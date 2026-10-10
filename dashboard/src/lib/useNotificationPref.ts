import { useCallback, useEffect, useState } from "react";

import { hasExistingSubscription } from "@/lib/push";

const STORAGE_KEY = "sarathy_notifications_enabled";

/**
 * On/off notification preference for the merged single-bell control (spec §D).
 *
 * Persisted in localStorage; on load it defaults to ON when the user enabled
 * it previously OR a live push subscription already exists. While the initial
 * state is still being resolved the value is `null` so callers can avoid
 * flashing the wrong bell.
 */
export function useNotificationPref() {
  const [enabled, setEnabledState] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setEnabledState(stored === "true");
      return;
    }
    hasExistingSubscription()
      .then((exists) => {
        if (mounted) setEnabledState(exists);
      })
      .catch(() => {
        if (mounted) setEnabledState(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(value));
    setEnabledState(value);
  }, []);

  return { enabled, setEnabled };
}
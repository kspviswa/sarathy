import type { DeviceInfo } from "./types";

/**
 * Shared paired-device helpers (spec 128 §B).
 *
 * Both the desktop and mobile SPAs render paired devices through the same
 * `<DevicesPanel>` component, which in turn uses these helpers — so the two
 * surfaces can never drift in how they label, sort, or age a device.
 */

/** Devices unseen for longer than this are flagged stale in the UI. */
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A short, human-scannable handle for a device id (first 6 chars). */
export function deviceShortId(id: string | null | undefined): string {
  return (id ?? "").slice(0, 6);
}

/**
 * Relative age from a unix-seconds `lastSeen`. Future/invalid timestamps clamp
 * to "just now" rather than rendering a negative age.
 */
export function formatLastSeen(
  epochSeconds: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return "never";
  const diffMs = Math.max(0, now - epochSeconds * 1000);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** True when a device has not been seen within `STALE_AFTER_DAYS`. */
export function isStaleDevice(
  device: DeviceInfo,
  now: number = Date.now(),
  staleAfterDays: number = STALE_AFTER_DAYS,
): boolean {
  const seen = device.lastSeen ?? device.createdAt;
  if (!seen) return false;
  return now - seen * 1000 > staleAfterDays * DAY_MS;
}

/** Newest-first, with the current device always pinned to the top. */
export function sortDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
  });
}

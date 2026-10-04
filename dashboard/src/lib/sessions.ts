import type { SessionInfo } from "./types";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function asDate(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Short-form date, e.g. `7 July 2026` (no leading zero). */
export function formatSessionDate(iso?: string | null): string {
  const d = asDate(iso);
  if (!d) return "Unknown date";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Stable `yyyy-mm-dd` key for grouping/filtering (local time). */
export function sessionDateKey(iso?: string | null): string {
  const d = asDate(iso);
  if (!d) return "unknown";
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function preferredTimestamp(s: SessionInfo): string | undefined {
  return s.updated_at ?? s.created_at;
}

/** Channel for grouping: explicit field, else key prefix, else `cli`. */
export function sessionChannel(s: SessionInfo): string {
  if (s.channel) return s.channel;
  if (s.key.includes(":")) {
    const prefix = s.key.split(":", 1)[0];
    if (prefix) return prefix;
  }
  return "cli";
}

/** `telegram` → `Telegram`. */
export function channelLabel(channel: string): string {
  if (!channel) return "Other";
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

/** Row title: topic when set, else the session key. */
export function sessionTitle(s: SessionInfo): string {
  return s.topic?.trim() ? s.topic : s.key;
}

export interface SessionDateGroup {
  dateKey: string;
  label: string;
  sessions: SessionInfo[];
}

export interface SessionChannelGroup {
  channel: string;
  label: string;
  dates: SessionDateGroup[];
}

/** Group sessions by channel → date (short form) → topic list. */
export function groupSessions(sessions: SessionInfo[]): SessionChannelGroup[] {
  const byChannel = new Map<string, Map<string, SessionInfo[]>>();
  for (const s of sessions) {
    const channel = sessionChannel(s);
    const key = sessionDateKey(preferredTimestamp(s));
    let dates = byChannel.get(channel);
    if (!dates) {
      dates = new Map();
      byChannel.set(channel, dates);
    }
    const list = dates.get(key);
    if (list) list.push(s);
    else dates.set(key, [s]);
  }

  const byTime = (a: SessionInfo, b: SessionInfo) =>
    (preferredTimestamp(b) ?? "").localeCompare(preferredTimestamp(a) ?? "");

  return [...byChannel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, dates]) => ({
      channel,
      label: channelLabel(channel),
      dates: [...dates.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([dateKey, list]) => ({
          dateKey,
          label: formatSessionDate(preferredTimestamp(list[0])),
          sessions: [...list].sort(byTime),
        })),
    }));
}

/** Distinct dates across sessions for the date filter (newest first). */
export function sessionDateOptions(
  sessions: SessionInfo[],
): Array<{ dateKey: string; label: string }> {
  const seen = new Map<string, string>();
  for (const s of sessions) {
    const ts = preferredTimestamp(s);
    const key = sessionDateKey(ts);
    if (!seen.has(key)) seen.set(key, formatSessionDate(ts));
  }
  return [...seen.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, label]) => ({ dateKey, label }));
}

/** Narrow the already-fetched list to one short-form date (`all` = no filter). */
export function filterSessionsByDate(
  sessions: SessionInfo[],
  dateKey: string | "all",
): SessionInfo[] {
  if (dateKey === "all") return sessions;
  return sessions.filter((s) => sessionDateKey(preferredTimestamp(s)) === dateKey);
}

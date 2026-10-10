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

/** Local `yyyy-mm-dd` key for a concrete Date. */
export function dateKeyFromDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Parse a `yyyy-mm-dd` key back to a local Date (`null` when malformed). */
export function dateFromKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Human label for a `yyyy-mm-dd` key, e.g. `7 July 2026`. */
export function formatDateKey(key: string): string {
  const d = dateFromKey(key);
  if (!d) return "Unknown date";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export interface MonthCursor {
  year: number;
  /** 0-based month index (JS Date convention). */
  month: number;
}

/** `October 2026` label for a month cursor. */
export function monthLabel(cursor: MonthCursor): string {
  return `${MONTHS[cursor.month]} ${cursor.year}`;
}

/** Move a month cursor by `delta` months, rolling the year over as needed. */
export function shiftMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const d = new Date(cursor.year, cursor.month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * Sunday-first week grid for the given month. Each cell is a local Date, with
 * leading/trailing `null`s padding the partial first/last weeks.
 */
export function buildMonthMatrix(cursor: MonthCursor): (Date | null)[][] {
  const first = new Date(cursor.year, cursor.month, 1);
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const lead = first.getDay();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(cursor.year, cursor.month, day));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Set of `yyyy-mm-dd` keys that have at least one session (for calendar markers). */
export function sessionDayKeys(sessions: SessionInfo[]): Set<string> {
  const keys = new Set<string>();
  for (const s of sessions) keys.add(sessionDateKey(preferredTimestamp(s)));
  return keys;
}

/** Sessions whose local day matches `dateKey`. */
export function sessionsOnDate(sessions: SessionInfo[], dateKey: string): SessionInfo[] {
  return sessions.filter((s) => sessionDateKey(preferredTimestamp(s)) === dateKey);
}

export interface ChannelCount {
  channel: string;
  label: string;
  sessions: SessionInfo[];
}

/** Group sessions by channel (alphabetical), each carrying its full list. */
export function groupByChannel(sessions: SessionInfo[]): ChannelCount[] {
  const byChannel = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const channel = sessionChannel(s);
    const list = byChannel.get(channel);
    if (list) list.push(s);
    else byChannel.set(channel, [s]);
  }
  return [...byChannel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, list]) => ({
      channel,
      label: channelLabel(channel),
      sessions: [...list].sort((a, b) =>
        (preferredTimestamp(b) ?? "").localeCompare(preferredTimestamp(a) ?? ""),
      ),
    }));
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

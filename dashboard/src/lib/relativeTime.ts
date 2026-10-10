/**
 * Human-friendly relative timestamps for the notification sidebar.
 *
 * The WS `notification` frame carries an ISO-8601 `timestamp`; showing the raw
 * string in a dense list is unreadable, so we render "5m ago" style labels.
 * Exported for testing — the boundary behaviour (invalid input, future stamps)
 * is the part most likely to regress.
 */
export function relativeTime(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  if (value === null || value === undefined || value === "") return "";
  const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(then)) return "";

  const diffMs = now - then;
  // Clock skew (or a client clock behind the server) must not render "in -3s".
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
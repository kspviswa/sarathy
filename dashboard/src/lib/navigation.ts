/**
 * Where a navigation request lands.
 *
 * Both shells answer the same question — "a notification (or an old link)
 * says go to `sessions` / `files` / `config` / `status`; where does that go
 * now?" — and the answer changed when Config and Status merged into
 * Settings and the mobile tab bar shrank to four tabs.
 *
 * The mapping lives here so the desktop and the mobile cannot drift.
 */

/** The segments of the Settings surface. */
export type SettingsSegment = "form" | "json" | "devices" | "status" | "usage";

/** A destination of the shell. */
export type NavSection =
  | "chat"
  | "ask"
  | "sessions"
  | "files"
  | "jobs"
  | "settings";

export interface NavTarget {
  /** The section (desktop tab / mobile tab) that becomes active. */
  section: NavSection;
  /** Which Settings segment to open, when the target is Settings. */
  settingsSegment?: SettingsSegment;
}

/**
 * Map a tab id onto a destination.
 *
 * `sessions` and `files` are still valid ids: the desktop has them as tabs,
 * and on mobile they open the drawer and the sheet. `config` and `status`
 * are the OLD ids of the two surfaces that merged into Settings — they are
 * mapped onto the segment they used to be.
 *
 * An unknown id returns `null`: the caller ignores it rather than blanking
 * the main area.
 */
export function toSection(tab: string | undefined | null): NavTarget | null {
  if (!tab) return null;

  switch (tab) {
    case "chat":
      return { section: "chat" };
    case "ask":
      return { section: "ask" };
    case "jobs":
      return { section: "jobs" };
    case "sessions":
      return { section: "sessions" };
    case "files":
      return { section: "files" };
    case "config":
      return { section: "settings", settingsSegment: "form" };
    case "status":
      return { section: "settings", settingsSegment: "status" };
    case "settings":
      return { section: "settings" };
    default:
      return null;
  }
}

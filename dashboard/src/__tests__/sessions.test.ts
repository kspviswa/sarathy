import { describe, it, expect } from "vitest";
import {
  channelLabel,
  filterSessionsByDate,
  formatSessionDate,
  groupSessions,
  sessionChannel,
  sessionDateKey,
  sessionDateOptions,
  sessionTitle,
} from "@/lib/sessions";
import type { SessionInfo } from "@/lib/types";

const SESSIONS: SessionInfo[] = [
  {
    key: "telegram:1",
    channel: "telegram",
    topic: "pi durable research",
    topic_user_set: false,
    created_at: "2026-07-07T10:00:00Z",
    updated_at: "2026-07-07T12:00:00Z",
  },
  {
    key: "telegram:2",
    channel: "telegram",
    topic: null,
    created_at: "2026-07-08T10:00:00Z",
    updated_at: "2026-07-08T10:00:00Z",
  },
  {
    key: "dashboard:console",
    channel: "dashboard",
    topic: "locked topic",
    topic_user_set: true,
    created_at: "2026-07-07T09:00:00Z",
    updated_at: "2026-07-07T11:00:00Z",
  },
  {
    key: "cron:nightly",
    created_at: "2026-07-07T08:00:00Z",
    updated_at: "2026-07-07T08:30:00Z",
  },
];

describe("formatSessionDate", () => {
  it("uses short form without leading zero", () => {
    expect(formatSessionDate("2026-07-07T12:00:00Z")).toBe("7 July 2026");
    expect(formatSessionDate("2026-01-05T00:00:00Z")).toBe("5 January 2026");
  });

  it("handles missing/invalid input", () => {
    expect(formatSessionDate(undefined)).toBe("Unknown date");
    expect(formatSessionDate("not-a-date")).toBe("Unknown date");
  });
});

describe("sessionChannel", () => {
  it("prefers the explicit channel field", () => {
    expect(sessionChannel(SESSIONS[0])).toBe("telegram");
  });

  it("falls back to the key prefix, then cli", () => {
    expect(sessionChannel(SESSIONS[3])).toBe("cron");
    expect(sessionChannel({ key: "no-colon" })).toBe("cli");
  });

  it("capitalizes channel labels", () => {
    expect(channelLabel("telegram")).toBe("Telegram");
  });
});

describe("sessionTitle", () => {
  it("shows the topic when set, else the key", () => {
    expect(sessionTitle(SESSIONS[0])).toBe("pi durable research");
    expect(sessionTitle(SESSIONS[1])).toBe("telegram:2");
  });
});

describe("groupSessions", () => {
  it("groups by channel, then date", () => {
    const groups = groupSessions(SESSIONS);
    expect(groups.map((g) => g.channel)).toEqual(["cron", "dashboard", "telegram"]);

    const telegram = groups.find((g) => g.channel === "telegram")!;
    expect(telegram.label).toBe("Telegram");
    expect(telegram.dates).toHaveLength(2);
    // dates newest first
    expect(telegram.dates[0].sessions[0].key).toBe("telegram:2");
    expect(telegram.dates[1].sessions[0].key).toBe("telegram:1");
    expect(telegram.dates[1].label).toBe(formatSessionDate("2026-07-07T12:00:00Z"));
  });
});

describe("date filter", () => {
  it("lists distinct dates newest first", () => {
    const options = sessionDateOptions(SESSIONS);
    expect(options.map((o) => o.dateKey)).toEqual(["2026-07-08", "2026-07-07"]);
  });

  it("narrows the list to the chosen date", () => {
    const key = sessionDateKey("2026-07-07T12:00:00Z");
    const filtered = filterSessionsByDate(SESSIONS, key);
    expect(filtered.map((s) => s.key).sort()).toEqual(
      ["cron:nightly", "dashboard:console", "telegram:1"].sort(),
    );
    expect(filterSessionsByDate(SESSIONS, "all")).toHaveLength(SESSIONS.length);
  });
});

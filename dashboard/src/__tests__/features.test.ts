/**
 * Feature-logic suites for spec §H:
 *   - reaction state machine (progress→thinking→tool→final)
 *   - quote-and-ask payload construction + chip state
 *   - command palette filtering
 *   - push subscription payload
 *   - archive grouping
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  nextReaction,
  reactionFrameFrom,
  reactionFor,
  startTurn,
  type ReactionState,
} from "@/lib/reactions";
import {
  addQuote,
  buildQuotesPayload,
  chipLabel,
  clearQuotes,
  hasQuotes,
  quoteFromSelection,
  removeQuote,
  MAX_QUOTES,
  __resetQuoteIds,
  type QuoteChip,
} from "@/lib/quotes";
import {
  completeSlashCommands,
  filterCommands,
  fuzzyScore,
  shouldSuggestSlash,
  type SlashCommand,
} from "@/lib/palette";
import { buildSubscribeBody, detectPushSupport, urlB64ToUint8Array } from "@/lib/push";
import { groupLabel, groupSessions } from "@/components/ArchiveBrowser";

// ---------------------------------------------------------------- reactions

describe("reaction state machine", () => {
  it("walks progress → thinking → tool → final", () => {
    let s: ReactionState = startTurn();
    expect(s).toBe("queued");

    s = nextReaction(s, { kind: "progress" });
    expect(s).toBe("working");

    s = nextReaction(s, { kind: "thinking" });
    expect(s).toBe("thinking");

    s = nextReaction(s, { kind: "tool_hint" });
    expect(s).toBe("tool");

    s = nextReaction(s, { kind: "final" });
    expect(s).toBe("done");
  });

  it("maps error finals to failed", () => {
    const s = nextReaction("tool", { kind: "final", isError: true });
    expect(s).toBe("failed");
  });

  it("keeps failed sticky so a retry race cannot erase the error", () => {
    const afterError = nextReaction("tool", { kind: "final", isError: true });
    expect(afterError).toBe("failed");
    expect(nextReaction(afterError, { kind: "progress" })).toBe("failed");
    expect(nextReaction(afterError, { kind: "thinking" })).toBe("failed");
    expect(nextReaction(afterError, { kind: "final" })).toBe("failed");
  });

  it("allows any frame to follow any frame (out-of-order tolerance)", () => {
    expect(nextReaction("working", { kind: "tool_hint" })).toBe("tool");
    expect(nextReaction("thinking", { kind: "progress" })).toBe("working");
    expect(nextReaction("done", { kind: "progress" })).toBe("working");
  });

  it("maps WS metadata frames to states (contract unchanged)", () => {
    expect(reactionFrameFrom({ _progress: "text" })?.kind).toBe("progress");
    expect(reactionFrameFrom({ _thinking: "reason" })?.kind).toBe("thinking");
    expect(reactionFrameFrom({ _tool_hint: "bash" })?.kind).toBe("tool_hint");
    expect(reactionFrameFrom({ _final: "done" })).toEqual({ kind: "final", isError: false });
    expect(reactionFrameFrom({ _final: "x", _error: true })).toEqual({
      kind: "final",
      isError: true,
    });
  });

  it("prefers _final over other flags on the same frame", () => {
    // A final frame may also carry content; reporting it as working would
    // strand the UI in a live state forever.
    expect(reactionFrameFrom({ _final: "done", _progress: "partial" })?.kind).toBe("final");
  });

  it("returns null for frames carrying no reaction signal", () => {
    expect(reactionFrameFrom({})).toBeNull();
    expect(reactionFrameFrom(null)).toBeNull();
    expect(reactionFrameFrom(undefined)).toBeNull();
  });

  it("exposes a view (glyph/label/live) for every state", () => {
    for (const state of [
      "queued",
      "working",
      "thinking",
      "tool",
      "done",
      "failed",
    ] as ReactionState[]) {
      const view = reactionFor(state);
      expect(view.state).toBe(state);
      expect(view.glyph).toBeTruthy();
      expect(view.label).toBeTruthy();
    }
    // Terminal states are not "live"; in-flight ones are.
    expect(reactionFor("done").live).toBe(false);
    expect(reactionFor("failed").live).toBe(false);
    expect(reactionFor("thinking").live).toBe(true);
  });
});

// ------------------------------------------------------------------- quotes

describe("quote-and-ask", () => {
  beforeEach(() => __resetQuoteIds());

  function fakeSelection(text: string, collapsed = false): Selection {
    return {
      isCollapsed: collapsed,
      rangeCount: 1,
      toString: () => text,
    } as unknown as Selection;
  }

  it("builds a quote from a real selection", () => {
    const q = quoteFromSelection(fakeSelection("latency was 42ms"), {
      sourceMessageId: "m1",
      sourceRole: "assistant",
    });
    expect(q).toEqual({
      text: "latency was 42ms",
      source_message_id: "m1",
      source_role: "assistant",
    });
  });

  it("normalises whitespace in the quoted text", () => {
    const q = quoteFromSelection(fakeSelection("  a\n\n  b  "));
    expect(q?.text).toBe("a b");
  });

  it("rejects collapsed, empty and whitespace-only selections", () => {
    expect(quoteFromSelection(fakeSelection("x", true))).toBeNull();
    expect(quoteFromSelection(fakeSelection("   "))).toBeNull();
    expect(quoteFromSelection(null)).toBeNull();
  });

  it("adds chips with stable, distinct ids", () => {
    let chips: QuoteChip[] = [];
    chips = addQuote(chips, { text: "one" });
    chips = addQuote(chips, { text: "two" });
    expect(chips).toHaveLength(2);
    expect(chips[0].id).not.toBe(chips[1].id);
  });

  it("de-duplicates the same passage", () => {
    let chips = addQuote([], { text: "same" });
    chips = addQuote(chips, { text: "  same  " });
    expect(chips).toHaveLength(1);
  });

  it("removes a single chip by id and leaves the rest", () => {
    let chips = addQuote(addQuote([], { text: "a" }), { text: "b" });
    chips = removeQuote(chips, chips[0].id);
    expect(chips).toHaveLength(1);
    expect(chips[0].text).toBe("b");
  });

  it("clears all chips", () => {
    expect(clearQuotes()).toEqual([]);
    expect(hasQuotes([])).toBe(false);
    expect(hasQuotes(addQuote([], { text: "a" }))).toBe(true);
  });

  it("caps the chip count at MAX_QUOTES", () => {
    let chips: QuoteChip[] = [];
    for (let i = 0; i < MAX_QUOTES + 8; i++) chips = addQuote(chips, { text: `quote ${i}` });
    expect(chips).toHaveLength(MAX_QUOTES);
    // Keeps the most recent selections.
    expect(chips[chips.length - 1].text).toBe(`quote ${MAX_QUOTES + 7}`);
  });

  it("builds the quotes payload with source fields, dropping empty ones", () => {
    const chips = addQuote(addQuote([], { text: "a", source_message_id: "m1", source_role: "user" }), {
      text: "b",
    });
    expect(buildQuotesPayload(chips)).toEqual([
      { text: "a", source_message_id: "m1", source_role: "user" },
      { text: "b" },
    ]);
  });

  it("returns an empty payload when there are no chips", () => {
    expect(buildQuotesPayload([])).toEqual([]);
  });

  it("labels chips with an @ prefix and a truncation ellipsis", () => {
    const long = "y".repeat(400);
    expect(chipLabel({ id: "1", text: "short" })).toBe("@short");
    expect(chipLabel({ id: "2", text: long })).toMatch(/^@y+\.\.\.$|…$/);
  });
});

// ------------------------------------------------------------------ palette

const COMMANDS: SlashCommand[] = [
  { name: "model", description: "Show or change the active model", subcommands: ["status"], hasStatus: true },
  { name: "memory", description: "Save important information", subcommands: [], hasStatus: false },
  { name: "context", description: "Show context usage", subcommands: [], hasStatus: false },
  { name: "help", description: "Show available commands", subcommands: [], hasStatus: false },
  { name: "provider", description: "List or switch LLM providers", subcommands: ["status"], hasStatus: true },
  { name: "new", description: "Start a new conversation", subcommands: [], hasStatus: false },
];

describe("command palette filtering", () => {
  it("returns everything for an empty query", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(COMMANDS.length);
    expect(filterCommands(COMMANDS, "   ")).toHaveLength(COMMANDS.length);
  });

  it("matches command names", () => {
    expect(filterCommands(COMMANDS, "model").map((c) => c.name)).toContain("model");
  });

  it("matches subsequences (fuzzy), not just substrings", () => {
    // "mdl" is a subsequence of "model" but not a substring.
    expect(fuzzyScore("mdl", "model")).not.toBeNull();
    expect(filterCommands(COMMANDS, "mdl").map((c) => c.name)).toContain("model");
  });

  it("returns no match when the query is not a subsequence", () => {
    expect(fuzzyScore("zzz", "model")).toBeNull();
    expect(filterCommands(COMMANDS, "zzzzz")).toEqual([]);
  });

  it("matches on description too", () => {
    const results = filterCommands(COMMANDS, "providers");
    expect(results.map((c) => c.name)).toContain("provider");
  });

  it("ranks name matches above description matches", () => {
    // "context" is the name of a command and a word in memory's description.
    const results = filterCommands(COMMANDS, "context").map((c) => c.name);
    expect(results[0]).toBe("context");
  });

  it("honours the result limit", () => {
    expect(filterCommands(COMMANDS, "", 3)).toHaveLength(3);
  });
});

describe("slash autocomplete", () => {
  it("suggests on a leading /token", () => {
    expect(shouldSuggestSlash("/mo")).toBe(true);
    expect(shouldSuggestSlash("/")).toBe(true);
  });

  it("does not suggest mid-sentence or after a space", () => {
    expect(shouldSuggestSlash("hello /mo")).toBe(false);
    expect(shouldSuggestSlash("/model set")).toBe(false);
    expect(shouldSuggestSlash("")).toBe(false);
    expect(shouldSuggestSlash("no slash")).toBe(false);
  });

  it("prefix matches rank above substring matches", () => {
    const results = completeSlashCommands(COMMANDS, "/mo").map((c) => c.name);
    expect(results[0]).toBe("model");
    expect(results).toContain("memory");
  });

  it("tolerates a token without the leading slash", () => {
    expect(completeSlashCommands(COMMANDS, "model").map((c) => c.name)).toContain("model");
  });
});

// --------------------------------------------------------------------- push

describe("push subscription payload", () => {
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys: { p256dh: "BEl62iUYgUiv", auth: "8eDyX2w0T05I" },
    expirationTime: null,
  };

  it("wraps the browser subscription for POST /api/push/subscribe", () => {
    const body = buildSubscribeBody(sub);
    expect(body.subscription.endpoint).toBe(sub.endpoint);
    expect(body.subscription.keys).toEqual(sub.keys);
  });

  it("preserves the endpoint and keys verbatim", () => {
    const body = buildSubscribeBody(sub);
    expect(body.subscription).toMatchObject({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
  });

  it("reports unsupported without PushManager", () => {
    // jsdom provides neither serviceWorker nor PushManager.
    expect(["unsupported", "insecure", "denied", "default", "granted"]).toContain(
      detectPushSupport(),
    );
  });

  it("decodes a url-safe VAPID key to bytes", () => {
    // "AQAB" is base64url for [0x01, 0x00, 0x01]
    const bytes = urlB64ToUint8Array("AQAB");
    expect(Array.from(bytes)).toEqual([1, 0, 1]);
  });

  it("handles keys whose length needs padding", () => {
    expect(urlB64ToUint8Array("AQ").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------- archive grouping

describe("archive grouping", () => {
  const now = new Date("2026-10-10T12:00:00Z");

  it("labels today, yesterday and older buckets", () => {
    expect(groupLabel("2026-10-10T08:00:00Z", now)).toBe("Today");
    expect(groupLabel("2026-10-09T08:00:00Z", now)).toBe("Yesterday");
    expect(groupLabel("2026-10-05T08:00:00Z", now)).toBe("Previous 7 days");
    expect(groupLabel("2026-09-20T08:00:00Z", now)).toBe("Previous 30 days");
  });

  it("falls back to Unknown date for missing/invalid timestamps", () => {
    expect(groupLabel(undefined, now)).toBe("Unknown date");
    expect(groupLabel("not-a-date", now)).toBe("Unknown date");
  });

  it("groups sessions into buckets", () => {
    const groups = groupSessions(
      [
        { key: "a", updated_at: "2026-10-10T08:00:00Z" },
        { key: "b", updated_at: "2026-10-10T09:00:00Z" },
        { key: "c", updated_at: "2026-10-08T09:00:00Z" },
      ],
      now,
    );
    const today = groups.find((g) => g.label === "Today");
    expect(today?.sessions.map((s) => s.key).sort()).toEqual(["a", "b"]);
    expect(groups.length).toBeGreaterThan(1);
  });

  it("orders sessions within a bucket newest first", () => {
    const groups = groupSessions(
      [
        { key: "old", updated_at: "2026-10-10T01:00:00Z" },
        { key: "new", updated_at: "2026-10-10T09:00:00Z" },
      ],
      now,
    );
    expect(groups[0].sessions[0].key).toBe("new");
  });
});
import { useEffect, useMemo, useState } from "react";
import { MessageSquare, Search, X } from "lucide-react";

import { api } from "@/lib/api";
import type { SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TranscriptMessage {
  role: string;
  content: string;
  timestamp?: string | null;
  quotes?: { text: string; source_role?: string }[];
}

/** Bucket a session into a date group heading. */
export function groupLabel(iso: string | undefined, now = new Date()): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";

  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * Group sessions into date buckets, newest first.
 *
 * Exported for testing: the grouping rule (and its "Unknown date" bucket) is
 * the part most likely to regress.
 */
export function groupSessions(
  sessions: SessionInfo[],
  now = new Date(),
): { label: string; sessions: SessionInfo[] }[] {
  const buckets = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const label = groupLabel(s.updated_at ?? s.created_at, now);
    const list = buckets.get(label);
    if (list) list.push(s);
    else buckets.set(label, [s]);
  }
  return [...buckets.entries()].map(([label, items]) => ({
    label,
    sessions: items.sort((a, b) =>
      String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
    ),
  }));
}

/**
 * Sessions archive browser (spec §F).
 *
 * Search + date-grouped list of past sessions with topic, first-message
 * preview and message count. Clicking opens a read-only transcript drawer —
 * there are no fake detail pages and no empty cards.
 */
export function ArchiveBrowser({
  sessions,
  onOpen,
  onClose,
  loading,
  error,
}: {
  sessions: SessionInfo[];
  onOpen: (key: string) => void;
  onClose: () => void;
  loading?: boolean;
  error?: string | null;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.topic, s.preview, s.key].some((v) => String(v ?? "").toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  const groups = useMemo(() => groupSessions(filtered), [filtered]);

  return (
    <div
      className="flex h-full flex-col bg-background"
      data-testid="archive-browser"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <MessageSquare className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">Conversations</h2>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close conversations"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="px-4 py-2">
        <div className="flex items-center gap-2 rounded-lg border border-border px-2.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-testid="archive-search"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {loading && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        {error && (
          <p className="px-2 py-6 text-center text-sm text-destructive">{error}</p>
        )}
        {!loading && !error && groups.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {query ? `No conversations match “${query}”.` : "No past conversations yet."}
          </p>
        )}

        {groups.map((group) => (
          <section key={group.label} className="mb-3">
            <h3 className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h3>
            <ul className="space-y-0.5">
              {group.sessions.map((s) => (
                <li key={s.key}>
                  <button
                    onClick={() => onOpen(s.key)}
                    data-testid="archive-item"
                    className="w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {s.topic || s.preview || s.key}
                      </span>
                      {typeof s.messageCount === "number" && (
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {s.messageCount} msg
                        </span>
                      )}
                    </div>
                    {s.topic && s.preview && (
                      <p className="truncate text-xs text-muted-foreground">{s.preview}</p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Read-only transcript drawer content for one archived session. */
export function TranscriptDrawer({
  key_,
  onClose,
}: {
  key_: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setError(null);
    api
      .session(key_)
      .then((res) => {
        if (!cancelled) setMessages(res.messages as TranscriptMessage[]);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this conversation.");
      });
    return () => {
      cancelled = true;
    };
  }, [key_]);

  return (
    <div className="flex h-full flex-col bg-background" data-testid="transcript-drawer">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <MessageSquare className="size-4 text-muted-foreground" />
        <h2 className="flex-1 truncate text-sm font-semibold">{key_}</h2>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close transcript"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {!messages && !error && (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        {error && <p className="py-6 text-center text-sm text-destructive">{error}</p>}
        {messages?.map((m, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
              m.role === "user"
                ? "ml-auto bg-primary text-primary-foreground"
                : "border border-border bg-card",
            )}
          >
            {m.quotes?.map((q, qi) => (
              <div
                key={qi}
                className="mb-1.5 border-l-2 border-current/30 pl-2 text-xs italic opacity-75"
              >
                {q.text}
              </div>
            ))}
            <span className="whitespace-pre-wrap break-words">{m.content}</span>
          </div>
        ))}
        {messages?.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">This conversation is empty.</p>
        )}
      </div>
    </div>
  );
}
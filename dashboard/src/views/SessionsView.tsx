import { ArrowLeft, Clock, Copy, Loader2, Lock, MessageSquareText, SquarePen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { MarkdownBubble } from "@/components/MarkdownBubble";
import { SessionCalendar } from "@/components/SessionCalendar";
import { SessionsPanel } from "@/components/SessionsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { channelIcon } from "@/lib/channelIcons";
import { cleanRenderedContent } from "@/lib/messageText";
import {
  formatDateKey,
  groupByChannel,
  sessionDayKeys,
  sessionIdentity,
  sessionTitle,
  sessionsOnDate,
  type MonthCursor,
} from "@/lib/sessions";
import { visibleTranscriptMessages } from "@/lib/transcript";
import type { SessionArchiveDetail, SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

function sessionTime(s: SessionInfo): string {
  const ts = s.updated_at ?? s.created_at;
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function thisMonth(): MonthCursor {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

/** Plain-text rendering of a transcript, for the clipboard. */
function transcriptText(detail: SessionArchiveDetail): string {
  return detail.messages
    .map((m) => {
      const who = m.role === "user" ? "You" : "Sarathy";
      const body = cleanRenderedContent(m.content);
      return body ? `${who}: ${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Sessions tab = the ARCHIVE browser (job 132 §C).
 *
 * It browses PAST conversations: `/new` archives the live session into
 * `<workspace>/archived_sessions/session-*.jsonl`, and that directory — not the
 * handful of currently active sessions — is the history worth browsing. So the
 * list comes from `/api/sessions/archive` and a transcript opens by archive id.
 *
 * The drill-down is unchanged: month → day → channel → session, with the
 * transcript in the right-hand column once one is open.
 *
 * The Asks (research threads) live next to it, behind the `Chats / Asks`
 * switch (spec §C) — the Ask canvas has no history rail of its own.
 */
export function SessionsView({
  initialKey = null,
  onOpenThread,
  onOpenAskThread,
}: {
  /** Transcript to open as soon as the view mounts (archive id, else a key). */
  initialKey?: string | null;
  /**
   * "Open as new thread" — hand the last user message back to the shell, which
   * jumps to Chat with it seeded in the composer. Optional: the copy-to-
   * clipboard half of the affordance works without it.
   */
  onOpenThread?: (text: string) => void;
  /** Open an Ask thread in the Ask canvas. */
  onOpenAskThread?: (threadId: string) => void;
} = {}) {
  return (
    <SessionsPanel
      testId="sessions-view"
      chats={<ChatsBrowser initialKey={initialKey} onOpenThread={onOpenThread} />}
      onOpenAsk={(threadId) => onOpenAskThread?.(threadId)}
    />
  );
}

function ChatsBrowser({
  initialKey = null,
  onOpenThread,
}: {
  initialKey?: string | null;
  onOpenThread?: (text: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionArchiveDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [cursor, setCursor] = useState<MonthCursor>(thisMonth);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);

  useEffect(() => {
    api
      .sessionsArchive()
      .then((res) => setSessions(res.sessions ?? []))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load sessions"))
      .finally(() => setLoadingList(false));
  }, []);

  const markedDays = useMemo(() => sessionDayKeys(sessions), [sessions]);
  const todayKey = useMemo(() => {
    const now = new Date();
    const m = `${now.getMonth() + 1}`.padStart(2, "0");
    const day = `${now.getDate()}`.padStart(2, "0");
    return `${now.getFullYear()}-${m}-${day}`;
  }, []);

  const daySessions = useMemo(
    () => (selectedDay ? sessionsOnDate(sessions, selectedDay) : []),
    [sessions, selectedDay],
  );
  const dayChannels = useMemo(() => groupByChannel(daySessions), [daySessions]);
  const channelSessions = useMemo(
    () => (selectedChannel ? dayChannels.find((c) => c.channel === selectedChannel)?.sessions ?? [] : []),
    [dayChannels, selectedChannel],
  );

  async function open(id: string) {
    setActive(id);
    setLoadingDetail(true);
    setDetail(null);
    try {
      setDetail(await api.sessionArchive(id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load session");
    } finally {
      setLoadingDetail(false);
    }
  }

  // Transcript requested by the shell (deep link) opens on mount.
  useEffect(() => {
    if (!initialKey) return;
    void open(initialKey);
  }, [initialKey]);

  function resetToList() {
    setSelectedDay(null);
    setSelectedChannel(null);
  }

  const visible = useMemo(
    () => visibleTranscriptMessages(detail?.messages ?? []),
    [detail],
  );

  /** Last thing the user said — the prompt a new thread should continue from. */
  const lastUserMessage = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const m = visible[i];
      if (m.role !== "user") continue;
      const body = cleanRenderedContent(m.content);
      if (body) return body;
    }
    return "";
  }, [visible]);

  async function copyTranscript() {
    if (!detail) return;
    const text = transcriptText(detail);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Transcript copied");
    } catch {
      toast.error("Could not copy transcript");
    }
  }

  return (
    <div className="grid h-full gap-3 lg:grid-cols-[minmax(0,340px)_1fr]">
      <Card className="min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-3">
            {loadingList ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : sessions.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground" data-testid="sessions-empty">
                No archived sessions yet
              </p>
            ) : !selectedDay ? (
              <SessionCalendar
                cursor={cursor}
                markedDays={markedDays}
                todayKey={todayKey}
                selectedDay={selectedDay}
                onSelectDay={(k) => {
                  setSelectedDay(k);
                  setSelectedChannel(null);
                }}
                onMonthChange={setCursor}
              />
            ) : !selectedChannel ? (
              <div data-testid="sessions-day-view">
                <button
                  onClick={resetToList}
                  className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="sessions-back-calendar"
                >
                  <ArrowLeft className="size-3.5" />
                  Calendar
                </button>
                <p className="px-1 pb-2 text-sm font-semibold">{formatDateKey(selectedDay)}</p>
                <ul className="space-y-1">
                  {dayChannels.map((g) => {
                    const Icon = channelIcon(g.channel);
                    return (
                      <li key={g.channel}>
                        <button
                          onClick={() => setSelectedChannel(g.channel)}
                          data-testid="day-channel"
                          data-channel={g.channel}
                          className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent"
                        >
                          <span className="flex size-8 items-center justify-center rounded-md bg-muted">
                            <Icon className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {g.label}
                          </span>
                          <Badge variant="secondary" data-testid="channel-count">
                            {g.sessions.length}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <div data-testid="sessions-channel-view">
                <button
                  onClick={() => setSelectedChannel(null)}
                  className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="sessions-back-day"
                >
                  <ArrowLeft className="size-3.5" />
                  {formatDateKey(selectedDay)}
                </button>
                <ul className="space-y-0.5">
                  {channelSessions.map((s) => {
                    const id = sessionIdentity(s);
                    return (
                      <li key={id}>
                        <button
                          onClick={() => void open(id)}
                          data-testid="archive-row"
                          data-archive-id={id}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                            active === id
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-accent hover:text-accent-foreground",
                          )}
                        >
                          <MessageSquareText className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1">
                              <span className="truncate">{sessionTitle(s)}</span>
                              {s.topic_user_set && (
                                <Lock
                                  className="size-3 shrink-0 opacity-70"
                                  aria-label="Topic locked"
                                  data-testid="topic-lock"
                                />
                              )}
                            </span>
                            <span className="block truncate font-mono text-[11px] opacity-60">
                              {s.topic?.trim() ? s.key : sessionTime(s)}
                              {s.topic?.trim() && sessionTime(s) ? ` · ${sessionTime(s)}` : null}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </ScrollArea>
      </Card>

      <Card className="min-h-0 overflow-hidden" data-testid="session-transcript">
        <ScrollArea className="h-full">
          <div className="flex flex-col items-start gap-4 p-4">
            {loadingDetail ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : !detail ? (
              <p className="p-3 text-sm text-muted-foreground">
                Select an archived session to view the transcript
              </p>
            ) : (
              <>
                <div className="flex w-full flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="size-4" />
                  <span className="font-mono">{detail.key}</span>
                  {detail.createdAt ? (
                    <span>· {new Date(detail.createdAt).toLocaleString()}</span>
                  ) : null}
                  <span className="flex-1" />
                  {/* Viswa wants to pick a past conversation back up: either
                      take the text away, or carry the last prompt into a fresh
                      thread. Nothing is sent on their behalf. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyTranscript()}
                    data-testid="session-copy"
                  >
                    <Copy className="size-3.5" />
                    Copy
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenThread?.(lastUserMessage)}
                    disabled={!lastUserMessage}
                    title={
                      lastUserMessage
                        ? "Continue this conversation in a new chat"
                        : "No user message to carry over"
                    }
                    data-testid="session-open-thread"
                  >
                    <SquarePen className="size-3.5" />
                    Open as new thread
                  </Button>
                </div>
                {visible.length > 0 ? (
                  /* Keyed on the archive so opening a different past
                     conversation re-runs the fade instead of swapping content
                     in place (job 132 §E). */
                  <div
                    key={detail.id}
                    className="section-in flex w-full flex-col items-start gap-4"
                    data-testid="transcript-body"
                  >
                    {visible.map((m, i) => (
                      <div
                        key={i}
                        data-testid={m.role === "user" ? "transcript-user" : "transcript-assistant"}
                        className={cn(
                          "rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                          m.role === "user"
                            ? "self-end bg-primary text-primary-foreground max-w-[85%]"
                            : "self-start max-w-[85%] border border-border bg-card",
                        )}
                      >
                        {/* Both sides are markdown (job 132 §D) and cleaned the
                            same way the chat bubble cleans them (spec 126 §B).
                            The server already dropped tool rows and empty
                            assistant records, so whatever arrives is
                            conversation. */}
                        <MarkdownBubble
                          content={cleanRenderedContent(m.content)}
                          onPrimary={m.role === "user"}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">This archive has no messages.</p>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </Card>
    </div>
  );
}
import { ArrowLeft, Clock, Loader2, Lock, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { SessionCalendar } from "@/components/SessionCalendar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { channelIcon } from "@/lib/channelIcons";
import { cleanRenderedContent } from "@/lib/messageText";
import { SAFE_REHYPE_PLUGINS } from "@/lib/markdown";
import {
  formatDateKey,
  groupByChannel,
  sessionDayKeys,
  sessionTitle,
  sessionsOnDate,
  type MonthCursor,
} from "@/lib/sessions";
import type { SessionDetail, SessionInfo } from "@/lib/types";
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

/**
 * Sessions drill-down (spec §C): month calendar → (day) per-channel counts →
 * (channel) session list → (session) transcript. The left column walks the
 * first three levels; the transcript renders on the right when a session opens.
 */
export function SessionsView({
  sessions: providedSessions,
  initialKey = null,
}: {
  /** Preloaded list from the shell (already fetched) — skips the refetch. */
  sessions?: SessionInfo[];
  /** Transcript to open as soon as the view mounts. */
  initialKey?: string | null;
} = {}) {
  const [sessions, setSessions] = useState<SessionInfo[]>(providedSessions ?? []);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadingList, setLoadingList] = useState(providedSessions === undefined);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [cursor, setCursor] = useState<MonthCursor>(thisMonth);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);

  useEffect(() => {
    if (providedSessions !== undefined) {
      setSessions(providedSessions);
      setLoadingList(false);
      return;
    }
    api
      .sessions()
      .then((res) => setSessions(res.sessions))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load sessions"))
      .finally(() => setLoadingList(false));
  }, [providedSessions]);

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

  async function open(key: string) {
    setActive(key);
    setLoadingDetail(true);
    setDetail(null);
    try {
      setDetail(await api.session(key));
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

  return (
    <div
      className="grid h-full gap-3 p-4 lg:grid-cols-[minmax(0,340px)_1fr]"
      data-testid="sessions-view"
    >
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
                No sessions yet
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
                  {channelSessions.map((s) => (
                    <li key={s.key}>
                      <button
                        onClick={() => void open(s.key)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                          active === s.key
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
                  ))}
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
              <p className="p-3 text-sm text-muted-foreground">Select a session to view the transcript</p>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="size-4" />
                  <span className="font-mono">{detail.key}</span>
                  {detail.createdAt ? <span>· {new Date(detail.createdAt).toLocaleString()}</span> : null}
                </div>
                {detail.messages.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      "rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                      m.role === "user"
                        ? "self-end bg-primary text-primary-foreground max-w-[85%]"
                        : "self-start max-w-[85%] border border-border bg-card",
                    )}
                  >
                    {m.role === "assistant" ? (
                      <div className="md">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={SAFE_REHYPE_PLUGINS}>
                          {cleanRenderedContent(m.content)}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      /* Same render-layer cleanup the chat bubble uses
                         (spec 126 §B) — the session viewer used to print the
                         raw stored turn, leaking the [Runtime Context …]
                         preamble and [image: /path] machine lines. */
                      <div className="whitespace-pre-wrap break-words">
                        {cleanRenderedContent(m.content)}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      </Card>
    </div>
  );
}

import { ArrowLeft, Clock, Copy, Loader2, Lock, MessageSquareText, SquarePen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { MarkdownBubble } from "@/components/MarkdownBubble";
import { SessionCalendar } from "@/components/SessionCalendar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      const body = cleanRenderedContent(m.content);
      return body ? `${m.role === "user" ? "You" : "Sarathy"}: ${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Mobile Sessions drill-down (job 132 §C): one screen at a time —
 * calendar → day channels → channel list → transcript — with a back affordance
 * at every level, mirroring the desktop flow.
 *
 * Like the desktop tab, it browses ARCHIVED conversations
 * (`/api/sessions/archive`), which is what `/new` leaves behind.
 */
export function SessionsView({
  onOpenThread,
}: {
  /** Hand the last user message back to the shell (see desktop SessionsView). */
  onOpenThread?: (text: string) => void;
} = {}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [detail, setDetail] = useState<SessionArchiveDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
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

  async function open(id: string) {
    setDetail(null);
    try {
      setDetail(await api.sessionArchive(id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load session");
    }
  }

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

  const visible = useMemo(
    () => visibleTranscriptMessages(detail?.messages ?? []),
    [detail],
  );

  const lastUserMessage = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      if (visible[i].role !== "user") continue;
      const body = cleanRenderedContent(visible[i].content);
      if (body) return body;
    }
    return "";
  }, [visible]);

  if (detail) {
    return (
      <div className="flex h-full flex-col" data-testid="mobile-sessions">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <button
            className="flex items-center gap-1 text-primary"
            onClick={() => setDetail(null)}
          >
            <ArrowLeft className="size-4" />
            {selectedChannel ? "Channel" : "Sessions"}
          </button>
          <span className="text-xs text-muted-foreground">Transcript</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4" />
            <span className="truncate font-mono text-xs">{detail.key}</span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(transcriptText(detail))
                  .then(() => toast.success("Transcript copied"))
                  .catch(() => toast.error("Could not copy transcript"));
              }}
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
              data-testid="session-open-thread"
            >
              <SquarePen className="size-3.5" />
              New thread
            </Button>
          </div>
          {/* Keyed so opening another archive re-runs the fade (job 132 §E). */}
          <div key={detail.id} className="section-in flex flex-col gap-3">
            {visible.map((m, i) => (
              <div
                key={i}
                data-testid={m.role === "user" ? "transcript-user" : "transcript-assistant"}
                className={cn(
                  "rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                  m.role === "user"
                    ? "self-end bg-primary text-primary-foreground max-w-[88%]"
                    : "self-start max-w-[88%] border border-border bg-card",
                )}
              >
                {/* Markdown on BOTH sides (job 132 §D), cleaned like the chat
                    bubble (spec 126 §B). */}
                <MarkdownBubble
                  content={cleanRenderedContent(m.content)}
                  onPrimary={m.role === "user"}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="mobile-sessions">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {selectedDay && (
          <button
            className="flex items-center gap-1 text-primary"
            data-testid="mobile-sessions-back"
            onClick={() => {
              if (selectedChannel) setSelectedChannel(null);
              else setSelectedDay(null);
            }}
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h1 className="flex-1 text-base font-semibold" data-testid="mobile-sessions-title">
          {!selectedDay
            ? "Sessions"
            : selectedChannel
              ? (dayChannels.find((c) => c.channel === selectedChannel)?.label ?? selectedChannel)
              : formatDateKey(selectedDay)}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loadingList ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
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
          <ul className="space-y-1" data-testid="mobile-sessions-day">
            {dayChannels.map((g) => {
              const Icon = channelIcon(g.channel);
              return (
                <li key={g.channel}>
                  <button
                    onClick={() => setSelectedChannel(g.channel)}
                    data-testid="day-channel"
                    data-channel={g.channel}
                    className="flex min-h-12 w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left text-base transition-colors hover:bg-accent"
                  >
                    <span className="flex size-8 items-center justify-center rounded-md bg-muted">
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{g.label}</span>
                    <Badge variant="secondary" data-testid="channel-count">
                      {g.sessions.length}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="space-y-0.5" data-testid="mobile-sessions-channel">
            {channelSessions.map((s) => {
              const id = sessionIdentity(s);
              return (
                <li key={id}>
                  <button
                    onClick={() => void open(id)}
                    data-testid="archive-row"
                    data-archive-id={id}
                    className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-base transition-colors hover:bg-accent"
                  >
                    <MessageSquareText className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{sessionTitle(s)}</span>
                        {s.topic_user_set && (
                          <Lock
                            className="size-3.5 shrink-0 opacity-70"
                            aria-label="Topic locked"
                            data-testid="topic-lock"
                          />
                        )}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {sessionTime(s)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
import { ArrowLeft, Clock, Loader2, Lock, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { SessionCalendar } from "@/components/SessionCalendar";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { channelIcon } from "@/lib/channelIcons";
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
 * Mobile Sessions drill-down (spec §C): one screen at a time —
 * calendar → day channels → channel list → transcript — with a back affordance
 * at every level, mirroring the desktop flow.
 */
export function SessionsView() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [cursor, setCursor] = useState<MonthCursor>(thisMonth);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);

  useEffect(() => {
    api
      .sessions()
      .then((res) => setSessions(res.sessions))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load sessions"))
      .finally(() => setLoadingList(false));
  }, []);

  async function open(key: string) {
    setDetail(null);
    try {
      setDetail(await api.session(key));
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
          <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4" />
            <span className="truncate font-mono text-xs">{detail.key}</span>
          </div>
          <div className="flex flex-col gap-3">
            {detail.messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                  m.role === "user"
                    ? "self-end bg-primary text-primary-foreground max-w-[88%]"
                    : "self-start max-w-[88%] border border-border bg-card",
                )}
              >
                {m.role === "assistant" ? (
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                )}
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
          <p className="p-3 text-sm text-muted-foreground">No sessions yet</p>
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
            {channelSessions.map((s) => (
              <li key={s.key}>
                <button
                  onClick={() => void open(s.key)}
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
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

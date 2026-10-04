import { Clock, Loader2, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import {
  filterSessionsByDate,
  groupSessions,
  sessionDateOptions,
  sessionTitle,
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

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [dateFilter, setDateFilter] = useState<string | "all">("all");

  useEffect(() => {
    api
      .sessions()
      .then((res) => setSessions(res.sessions))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load sessions"))
      .finally(() => setLoadingList(false));
  }, []);

  const dateOptions = useMemo(() => sessionDateOptions(sessions), [sessions]);
  const groups = useMemo(
    () => groupSessions(filterSessionsByDate(sessions, dateFilter)),
    [sessions, dateFilter],
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

  return (
    <div className="grid h-full gap-3 p-4 lg:grid-cols-[minmax(0,300px)_1fr]">
      <Card className="min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-2">
            {loadingList ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : sessions.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No sessions yet</p>
            ) : (
              <>
                <div className="px-1 pb-2">
                  <label
                    htmlFor="session-date-filter"
                    className="pb-1 text-xs text-muted-foreground"
                  >
                    Filter by date
                  </label>
                  <select
                    id="session-date-filter"
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="all">All dates</option>
                    {dateOptions.map((o) => (
                      <option key={o.dateKey} value={o.dateKey}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                {groups.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    No sessions for this date
                  </p>
                ) : (
                  groups.map((g) => (
                    <div key={g.channel} className="pb-2">
                      <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {g.label}
                      </p>
                      {g.dates.map((d) => (
                        <div key={d.dateKey} className="pb-1">
                          <p className="px-2 pb-0.5 text-xs text-muted-foreground">
                            {d.label}
                          </p>
                          <ul className="space-y-0.5">
                            {d.sessions.map((s) => (
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
                                    <span className="block truncate">
                                      {sessionTitle(s)}
                                      {s.topic_user_set ? " 🔒" : null}
                                    </span>
                                    <span className="block truncate font-mono text-[11px] opacity-60">
                                      {s.topic?.trim() ? s.key : sessionTime(s)}
                                      {s.topic?.trim() && sessionTime(s)
                                        ? ` · ${sessionTime(s)}`
                                        : null}
                                    </span>
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </Card>

      <Card className="min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 p-4">
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
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap break-words">{m.content}</div>
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

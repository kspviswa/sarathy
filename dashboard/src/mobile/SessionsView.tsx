import { Clock, Loader2, MessageSquareText } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { SessionDetail, SessionInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  useEffect(() => {
    api
      .sessions()
      .then((res) => setSessions(res.sessions))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load sessions"))
      .finally(() => setLoadingList(false));
  }, []);

  async function open(key: string) {
    setActive(key);
    setDetail(null);
    try {
      setDetail(await api.session(key));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load session");
    }
  }

  if (detail) {
    return (
      <div className="flex h-full flex-col" data-testid="mobile-sessions">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <button className="text-primary" onClick={() => setDetail(null)}>
            ← Sessions
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
      <div className="border-b px-4 py-3">
        <h1 className="text-base font-semibold">Sessions</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loadingList ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : sessions.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No sessions yet</p>
        ) : (
          <ul className="flex flex-col">
            {sessions.map((s) => (
              <li key={s.key}>
                <button
                  onClick={() => void open(s.key)}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-base transition-colors",
                    active === s.key ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  <MessageSquareText className="size-5 shrink-0" />
                  <span className="truncate font-mono text-xs">{s.key}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

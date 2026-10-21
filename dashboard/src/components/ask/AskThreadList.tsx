import { MessageSquareText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  deleteAskThread,
  loadAskThreads,
  saveAskThreads,
  type AskThread,
} from "@/lib/ask";
import { relativeTime } from "@/lib/relativeTime";

/**
 * The Ask threads — the "Asks" list of the Sessions surface (spec §C).
 *
 * The Ask canvas has no history rail any more: a research thread is a
 * conversation, and conversations live with the other conversations. This
 * lists them: the first question, how many turns it took, when it was last
 * touched, and a way to forget one.
 */
export function AskThreadList({
  onOpenThread,
}: {
  /** Open the thread in the Ask canvas. */
  onOpenThread: (threadId: string) => void;
}) {
  const [threads, setThreads] = useState<AskThread[]>([]);

  // Read on mount: the Ask canvas may have added a thread since this list
  // was last rendered.
  const reload = useCallback(() => {
    setThreads(loadAskThreads());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const forget = (id: string) => {
    setThreads((prev) => saveAskThreads(deleteAskThread(prev, id)));
  };

  if (threads.length === 0) {
    return (
      <p className="p-3 text-sm text-muted-foreground" data-testid="ask-threads-empty">
        No research threads yet — ask something in the Ask tab.
      </p>
    );
  }

  return (
    <ul className="space-y-1 p-2" data-testid="ask-threads">
      {threads.map((thread) => (
        <li key={thread.id} className="group flex items-start gap-1">
          <button
            type="button"
            onClick={() => onOpenThread(thread.id)}
            data-testid="ask-thread-item"
            data-thread-id={thread.id}
            title={thread.title}
            className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
          >
            <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{thread.title}</span>
              <span className="block text-xs text-muted-foreground">
                {thread.turns.length}{" "}
                {thread.turns.length === 1 ? "turn" : "turns"} ·{" "}
                {relativeTime(thread.updatedAt)}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => forget(thread.id)}
            aria-label="Forget this research thread"
            data-testid="ask-thread-forget"
            className="rounded px-1.5 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export default AskThreadList;

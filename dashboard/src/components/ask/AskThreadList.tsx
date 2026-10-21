import { MessageSquareText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  deleteAskThread,
  ensureAskThreadsLoaded,
  getActiveAskThreadId,
  getAskThreads,
  setActiveAskThreadId,
  subscribeAskThreadList,
  type AskThread,
} from "@/lib/ask";
import { relativeTime } from "@/lib/relativeTime";

/**
 * The Ask threads — the "Asks" list of the Sessions surface (spec §C).
 *
 * The Ask canvas has no history rail of its own: a research thread is a
 * conversation, and conversations live with the other conversations. This
 * lists them: the first question, how many turns it took, when it was last
 * touched, and a way to forget one.
 *
 * The list comes from the SERVER (job 150 §B) — the threads used to live in
 * the browser's `localStorage`, which meant they were lost with the data and
 * invisible from any other device.
 */
export function AskThreadList({
  onOpenThread,
}: {
  /** Open the thread in the Ask canvas. */
  onOpenThread: (threadId: string) => void;
}) {
  const [threads, setThreads] = useState<AskThread[]>(() => getAskThreads());

  // The store is the one copy of the thread data: this list reads it
  // instead of keeping a private copy.
  useEffect(() => subscribeAskThreadList(() => setThreads(getAskThreads())), []);

  // The first load: the browser's old history is carried over to the
  // server, and the list is read from there.
  useEffect(() => {
    void ensureAskThreadsLoaded();
  }, []);
  const forget = useCallback(async (id: string) => {
    // The dashboard's own destructive-confirm pattern (the same one the
    // device revoke uses).
    if (!window.confirm("Delete this research thread? It cannot be undone.")) return;
    try {
      await deleteAskThread(id);
      // The thread that was open in the Ask canvas is gone: the canvas
      // empties, so it is not left pointing at a thread that no longer
      // exists.
      if (getActiveAskThreadId() === id) setActiveAskThreadId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the thread");
    }
  }, []);

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
                {thread.turnCount}{" "}
                {thread.turnCount === 1 ? "turn" : "turns"} ·{" "}
                {relativeTime(thread.updatedAt)}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => void forget(thread.id)}
            aria-label="Delete this research thread"
            title="Delete this research thread"
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

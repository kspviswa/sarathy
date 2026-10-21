import { useEffect, useState } from "react";

import { AskThreadList } from "@/components/ask/AskThreadList";
import {
  getAskListMode,
  setAskListMode,
  subscribeAskListMode,
  type AskListMode,
} from "@/lib/ask";
import { cn } from "@/lib/utils";

/**
 * The Sessions surface — a `Chats / Asks` switch.
 *
 * Complaint #6 was "clubbing history on the same ask tab is ugly and
 * idiotic": the Ask canvas used to carry its own history rail. The history
 * moved here instead, next to the chat history it belongs with.
 *
 * ONE component, so the desktop Sessions tab and the mobile Sessions drawer
 * offer exactly the same two lists.
 *
 * Which list is showing lives in the shared Ask module: the Ask canvas's
 * history button selects the Asks list from there, so the history is one
 * icon away from a cold Ask tab (job 150 §C).
 */
export function SessionsPanel({
  chats,
  onOpenAsk,
  className,
  testId,
}: {
  /** The chat archive browser — the existing SessionsView content. */
  chats: React.ReactNode;
  /** Open an Ask thread in the Ask canvas. */
  onOpenAsk: (threadId: string) => void;
  className?: string;
  testId?: string;
}) {
  const [mode, setMode] = useState<AskListMode>(() => getAskListMode());

  useEffect(() => subscribeAskListMode(() => setMode(getAskListMode())), []);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid={testId}>
      <div
        className="flex shrink-0 gap-1 border-b p-2"
        role="tablist"
        aria-label="Session list"
        data-testid="sessions-mode-toggle"
      >
        {(
          [
            { id: "chats", label: "Chats" },
            { id: "asks", label: "Asks" },
          ] as const
        ).map((option) => {
          const active = mode === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setAskListMode(option.id);
                setMode(option.id);
              }}
              data-testid={`sessions-mode-${option.id}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden" data-testid="sessions-mode-content">
        {mode === "chats" ? chats : <AskThreadList onOpenThread={onOpenAsk} />}
      </div>
    </div>
  );
}

export default SessionsPanel;

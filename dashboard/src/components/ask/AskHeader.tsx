import { History, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The Ask canvas header — the two icon buttons that make the canvas usable.
 *
 * `Plus` starts a NEW ask: it only appears when a thread is open, because
 * with no thread the composer is live and the next question opens one by
 * itself. `History` reaches the Ask history from anywhere, including a cold
 * Ask tab with nothing loaded.
 *
 * Icon buttons only, each with an accessible name and a hover tooltip (job
 * 150 §C). ONE component, so the desktop and the mobile shell can never
 * drift apart (HARD LESSON 22).
 */
export function AskHeader({
  title,
  hasThread,
  onNewAsk,
  onOpenHistory,
}: {
  /** The open thread's title — shown beside the buttons. */
  title?: string;
  /** True when a thread is open — that is when "New ask" makes sense. */
  hasThread: boolean;
  /** Start a new ask: the canvas empties and the next query is a new thread. */
  onNewAsk: () => void;
  /** Open the Ask history. */
  onOpenHistory: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b px-2 py-1"
      data-testid="ask-header"
    >
      <span
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        data-testid="ask-header-title"
        title={title}
      >
        {hasThread ? title : ""}
      </span>

      {hasThread ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onNewAsk}
          aria-label="New ask"
          title="New ask"
          data-testid="ask-new-thread"
        >
          <Plus className="size-4" />
        </Button>
      ) : null}

      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onOpenHistory}
        aria-label="Ask history"
        title="Ask history"
        data-testid="ask-history"
      >
        <History className="size-4" />
      </Button>
    </div>
  );
}

export default AskHeader;

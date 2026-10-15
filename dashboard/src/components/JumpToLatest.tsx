import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { jumpLabel } from "@/lib/useChatScroll";

/**
 * The "jump to latest" pill (spec 141 §A) — shared by both SPAs so the two
 * cannot drift.
 *
 * It is CONTEXTUAL, and the context is what makes it honest: it is drawn only
 * while the reader is away from the newest content, so its presence means
 * "there is something below you right now". It is absolutely positioned by its
 * parent, which must be a `relative` wrapper around the scroll container — the
 * pill floats over the transcript's bottom edge, just above the composer.
 *
 * The label carries the count of what was missed while the reader was away
 * (`newCount`), because "there is more below" and "there are 3 more below" are
 * different amounts of useful. With nothing missed it is a plain prompt — the
 * reader is simply scrolled up in a settled conversation.
 */
export function JumpToLatest({
  show,
  newCount,
  onClick,
  className,
}: {
  show: boolean;
  newCount: number;
  onClick: () => void;
  className?: string;
}) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="jump-to-latest"
      data-new-count={newCount}
      aria-label={jumpLabel(newCount)}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5",
        "rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium",
        "text-muted-foreground shadow-lg backdrop-blur transition-colors",
        "hover:border-primary/40 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "animate-in fade-in slide-in-from-bottom-1 duration-150",
        // Unread content earns the accent — the eye should find it without
        // hunting for it.
        newCount > 0 && "border-primary/40 text-foreground",
        className,
      )}
    >
      <ArrowDown className="size-3.5 shrink-0" />
      <span>{jumpLabel(newCount)}</span>
    </button>
  );
}

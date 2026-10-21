import { CornerUpLeft, Search, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { QuoteChips } from "@/components/QuoteAsk";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ASK_MODES, ASK_SOURCE_KINDS, type AskMode, type AskSourceKind } from "@/lib/ask";
import type { QuoteChip } from "@/lib/quotes";
import { cn } from "@/lib/utils";

/**
 * The Ask composer — the pinned bottom of the canvas.
 *
 * The mode switch, the source pills, the quote chips and the reply banner
 * all live here, so the desktop and the mobile shell cannot drift.
 */
export function AskComposer({
  query,
  onQueryChange,
  mode,
  onModeChange,
  sources,
  onSourcesChange,
  streaming,
  onSubmit,
  onStop,
  quoteChips,
  onRemoveQuote,
  replyContext,
  onClearReply,
  variant = "desktop",
}: {
  query: string;
  onQueryChange: (value: string) => void;
  mode: AskMode;
  onModeChange: (mode: AskMode) => void;
  sources: AskSourceKind[];
  onSourcesChange: (sources: AskSourceKind[]) => void;
  streaming: boolean;
  onSubmit: () => void;
  onStop: () => void;
  quoteChips: QuoteChip[];
  onRemoveQuote: (id: string) => void;
  /** The turn a "Reply" points at — the banner above the box. */
  replyContext?: { query: string } | null;
  onClearReply?: () => void;
  variant?: "desktop" | "mobile";
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A reply seeds the box, so the box takes the focus.
  useEffect(() => {
    if (replyContext) textareaRef.current?.focus();
  }, [replyContext]);

  const toggleSource = (kind: AskSourceKind) => {
    onSourcesChange(
      sources.includes(kind) ? sources.filter((s) => s !== kind) : [...sources, kind],
    );
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        variant === "mobile" ? "border-t bg-background p-3" : "border-t bg-background/80 p-4 backdrop-blur",
      )}
      data-testid="ask-composer"
    >
      {replyContext && (
        <div
          className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-xs"
          data-testid="ask-reply-context"
        >
          <CornerUpLeft className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-primary">Replying to:</span>{" "}
            <span className="text-muted-foreground">{replyContext.query}</span>
          </span>
          <button
            type="button"
            onClick={onClearReply}
            aria-label="Dismiss reply context"
            data-testid="ask-reply-dismiss"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <QuoteChips chips={quoteChips} onRemove={onRemoveQuote} />

      <Textarea
        ref={textareaRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Ask anything…"
        className={cn(
          "resize-y",
          variant === "mobile" ? "min-h-[64px]" : "min-h-[72px]",
        )}
        data-testid="ask-query"
        aria-label="Ask query"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSubmit} disabled={streaming} data-testid="ask-submit">
          <Search className="size-4" />
          Ask
        </Button>

        <div
          className="flex items-center gap-1 rounded-lg border p-0.5"
          role="group"
          aria-label="Mode"
          data-testid="ask-modes"
        >
          {ASK_MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              title={option.hint}
              onClick={() => onModeChange(option.id)}
              aria-pressed={mode === option.id}
              data-testid={`ask-mode-${option.id}`}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition-colors",
                variant === "mobile" ? "text-[11px]" : "text-xs",
                mode === option.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Sources"
          data-testid="ask-source-toggles"
        >
          {ASK_SOURCE_KINDS.map((option) => {
            const active = sources.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => toggleSource(option.id)}
                aria-pressed={active}
                data-testid={`ask-source-${option.id}`}
                className={cn(
                  "rounded-full border font-medium transition-colors",
                  variant === "mobile" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {streaming && (
          <Button
            variant="outline"
            size="sm"
            onClick={onStop}
            data-testid="ask-stop"
          >
            <Square className="size-3.5" />
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

export default AskComposer;

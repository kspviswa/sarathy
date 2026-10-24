import { ArrowUp, ChevronDown, CornerUpLeft, Globe, Search, Square, StopCircle, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { QuoteChips } from "@/components/QuoteAsk";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ASK_MODES, ASK_SOURCE_KINDS, type AskMode, type AskSourceKind } from "@/lib/ask";
import type { QuoteChip } from "@/lib/quotes";
import { cn } from "@/lib/utils";

/**
 * The Ask composer — the pinned bottom of the canvas.
 *
 * The mode switch, the source pills, the quote chips and the reply banner
 * all live here, so the desktop and the mobile shell cannot drift.
 *
 * The desktop variant is ONE inline row (spec 159): the auto-growing textarea
 * on the left, the sources and mode triggers, and the circular submit at the
 * right end of the SAME row — the stop takes that slot while streaming.
 * The mobile variant keeps the compact stacked arrangement.
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

  // The textarea auto-grows with the answer: reset, then measure.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [query, variant]);

  const currentMode = ASK_MODES.find((option) => option.id === mode);
  const CurrentModeIcon = currentMode?.icon;

  const toggleSource = (kind: AskSourceKind) => {
    onSourcesChange(
      sources.includes(kind) ? sources.filter((s) => s !== kind) : [...sources, kind],
    );
  };

  const submitControl = (
    <Button
      type="button"
      variant="default"
      size="icon"
      onClick={onSubmit}
      disabled={!query.trim() || streaming}
      data-testid="ask-submit"
      aria-label="Ask"
      title="Ask"
      className="h-9 w-9 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
    >
      <ArrowUp className="size-4" />
    </Button>
  );

  const stopControl = (
    <Button
      type="button"
      variant="destructive"
      size="icon"
      onClick={onStop}
      data-testid="ask-stop"
      aria-label="Stop"
      title="Stop generating"
      className="h-9 w-9 shrink-0 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
    >
      <StopCircle className="size-4" />
    </Button>
  );

  const desktopRow = (
    <div
      data-testid="ask-input-row"
      className="flex items-end gap-2 rounded-2xl border border-border bg-transparent p-2 backdrop-blur focus-within:border-primary focus-within:ring-1"
    >
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
        className="min-h-[72px] max-h-48 w-full resize-none border-0 bg-transparent px-0 py-2 text-left focus-visible:ring-0"
        data-testid="ask-query"
        aria-label="Ask query"
      />

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Sources"
            data-testid="ask-sources-trigger"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Globe className="size-4" />
            <ChevronDown className="size-3" />
            {sources.length > 0 && (
              <span
                data-testid="ask-sources-count"
                className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground"
              >
                {sources.length}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-2">
          <div className="flex flex-col gap-1">
            {ASK_SOURCE_KINDS.map((option) => {
              const active = sources.includes(option.id);
              const Icon = option.icon;
              return (
                <div
                  key={option.id}
                  role="switch"
                  aria-checked={active}
                  aria-pressed={active}
                  data-testid={`ask-source-${option.id}`}
                  onClick={() => toggleSource(option.id)}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">{option.label}</span>
                  </span>
                  <Switch
                    checked={active}
                    onCheckedChange={() => toggleSource(option.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </div>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Mode"
            data-testid="ask-modes-trigger"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {CurrentModeIcon ? <CurrentModeIcon className="size-4" /> : null}
            <span>{currentMode?.label}</span>
            <ChevronDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-2">
          <div className="flex flex-col gap-1">
            {ASK_MODES.map((option) => {
              const Icon = option.icon;
              const selected = mode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  title={option.hint}
                  onClick={() => onModeChange(option.id)}
                  aria-pressed={selected}
                  data-testid={`ask-mode-${option.id}`}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors",
                    selected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn("mt-0.5 size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-xs font-medium">{option.label}</span>
                    <span className="text-[11px] text-muted-foreground">{option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {streaming ? stopControl : submitControl}
    </div>
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        variant === "mobile" ? "border-t bg-background p-3" : "border-t bg-background/80 backdrop-blur",
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

      {variant === "desktop" ? (
        desktopRow
      ) : (
        <>
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
              variant === "mobile" ? "min-h-[64px] max-h-36" : "min-h-[72px] max-h-48",
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
        </>
      )}
    </div>
  );
}

export default AskComposer;

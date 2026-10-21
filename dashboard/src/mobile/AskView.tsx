import { ChevronDown, ChevronRight, Loader2, Search, Sparkles, Square } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ASK_MODES,
  ASK_SOURCE_KINDS,
  describeAskStep,
  formatAskUsage,
  phaseLabel,
  sourceForCitation,
  splitAnswerCitations,
  useAskStream,
  type AskMode,
  type AskSourceKind,
} from "@/lib/ask";
import { cn } from "@/lib/utils";

/**
 * Ask mode — the mobile surface.
 *
 * The same `@/lib/ask` state as the desktop view, laid out for one column:
 * the history rail folds into a collapsible section under the answer instead
 * of a right-hand column.
 */
export function AskView() {
  const { state, history, run, stop, reopen, forget } = useAskStream();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<AskMode>("speed");
  const [sources, setSources] = useState<AskSourceKind[]>(["web"]);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const toggleSource = (kind: AskSourceKind) => {
    setSources((prev) =>
      prev.includes(kind) ? prev.filter((s) => s !== kind) : [...prev, kind],
    );
  };

  const submit = () => {
    const trimmed = query.trim();
    if (!trimmed || state.streaming) return;
    void run({ query: trimmed, mode, sources: sources.length ? sources : ["web"] });
  };

  const citationParts = useMemo(
    () => splitAnswerCitations(state.answer),
    [state.answer],
  );

  const hasAnswer = state.answer.trim().length > 0;
  const hasMedia = state.media.length > 0;

  return (
    <div className="flex flex-col gap-4 p-3" data-testid="ask-mobile">
      <div className="flex flex-col gap-2">
        <Textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Ask anything…"
          className="min-h-[64px] resize-y"
          data-testid="ask-query"
          aria-label="Ask query"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={submit} disabled={state.streaming} data-testid="ask-submit">
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
                onClick={() => setMode(option.id)}
                aria-pressed={mode === option.id}
                data-testid={`ask-mode-${option.id}`}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  mode === option.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground",
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
                    "rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {state.streaming && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void stop()}
              data-testid="ask-stop"
            >
              <Square className="size-3.5" />
              Stop
            </Button>
          )}
        </div>
      </div>

      <div
        className="flex items-center gap-2 text-xs text-muted-foreground"
        data-testid="ask-phase"
      >
        {state.streaming && <Loader2 className="size-3.5 animate-spin" />}
        <span>
          {state.streaming
            ? phaseLabel(state.phase) || "Working…"
            : state.phase === "done"
              ? ""
              : phaseLabel(state.phase)}
        </span>
      </div>

      {state.error && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          data-testid="ask-error"
        >
          {state.error.message}
        </div>
      )}

      {state.steps.length > 0 && (
        <div className="rounded-lg border" data-testid="ask-steps">
          <button
            type="button"
            onClick={() => setStepsOpen((v) => !v)}
            aria-expanded={stepsOpen}
            data-testid="ask-steps-toggle"
            className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium"
          >
            {stepsOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            research steps ({state.steps.length})
          </button>
          {stepsOpen && (
            <ul
              className="space-y-1 border-t px-3 py-2 text-[11px] text-muted-foreground"
              data-testid="ask-step-list"
            >
              {state.steps.map((step, index) => (
                <li key={`${step.kind}-${index}`} data-testid="ask-step">
                  {describeAskStep(step)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(hasAnswer || state.streaming) && (
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Answer
          </h2>
          <div
            className="whitespace-pre-wrap text-sm leading-relaxed"
            data-testid="ask-answer"
          >
            {citationParts.map((part, index) => {
              if (part.type === "text") {
                return <span key={`t-${index}`}>{part.value}</span>;
              }
              const source = sourceForCitation(state.sources, part.index);
              if (!source) {
                return <span key={`c-${index}`}>{part.value}</span>;
              }
              return (
                <a
                  key={`c-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid={`ask-citation-${source.idx}`}
                  className="mx-0.5 rounded bg-primary/10 px-1 text-[0.8em] font-semibold text-primary"
                >
                  {part.value}
                </a>
              );
            })}
          </div>
        </div>
      )}

      {state.sources.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="ask-sources">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sources
          </h3>
          <ol className="space-y-1 text-xs">
            {state.sources.map((source) => (
              <li key={source.idx} data-testid={`ask-source-${source.idx}`}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-baseline gap-2"
                >
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {source.idx}.
                  </span>
                  <span className="min-w-0 flex-1 truncate">{source.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}

      {hasMedia && (
        <div className="rounded-lg border" data-testid="ask-media">
          <button
            type="button"
            onClick={() => setMediaOpen((v) => !v)}
            aria-expanded={mediaOpen}
            data-testid="ask-media-toggle"
            className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium"
          >
            {mediaOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            media ({state.media.length})
          </button>
          {mediaOpen && (
            <div
              className="grid grid-cols-2 gap-2 border-t p-3"
              data-testid="ask-media-strip"
            >
              {state.media.map((item, index) => (
                <a
                  key={`${item.url}-${index}`}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="truncate text-[11px] text-muted-foreground"
                >
                  {item.title || item.url}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {state.usage && (
        <div
          className="border-t pt-2 text-[11px] text-muted-foreground"
          data-testid="ask-usage"
        >
          {formatAskUsage(state.usage)}
        </div>
      )}

      <div className="rounded-lg border" data-testid="ask-history">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
          data-testid="ask-history-toggle"
          className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium"
        >
          {historyOpen ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <Sparkles className="size-3.5" />
          History ({history.length})
        </button>
        {historyOpen && (
          <ul className="space-y-1 border-t px-3 py-2" data-testid="ask-history-list">
            {history.length === 0 ? (
              <li className="text-[11px] text-muted-foreground">No questions yet.</li>
            ) : (
              history.map((entry) => (
                <li key={entry.id} className="group flex items-start gap-1">
                  <button
                    type="button"
                    onClick={() => reopen(entry)}
                    data-testid="ask-history-item"
                    className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent"
                  >
                    {entry.query}
                  </button>
                  <button
                    type="button"
                    onClick={() => forget(entry.id)}
                    aria-label="Forget this question"
                    data-testid="ask-history-forget"
                    className="rounded px-1 text-[11px] text-muted-foreground"
                  >
                    ×
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

export default AskView;

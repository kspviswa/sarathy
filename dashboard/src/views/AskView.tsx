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
 * Ask mode — the desktop surface.
 *
 * Every piece of frame → state logic lives in `@/lib/ask`; this file is
 * presentation only, and the mobile view (`@/mobile/AskView`) renders the same
 * state with different chrome.
 */
export function AskView() {
  const { state, history, run, stop, reopen, forget } = useAskStream();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<AskMode>("speed");
  const [sources, setSources] = useState<AskSourceKind[]>(["web"]);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);

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
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          {/* ---------------------------------------------------------- query */}
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
              className="min-h-[72px] resize-y"
              data-testid="ask-query"
              aria-label="Ask query"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={submit} disabled={state.streaming} data-testid="ask-submit">
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
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
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
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
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

          {/* ---------------------------------------------------------- phase */}
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
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
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="ask-error"
            >
              {state.error.message}
            </div>
          )}

          {/* -------------------------------------------------- research steps */}
          {state.steps.length > 0 && (
            <div className="rounded-lg border" data-testid="ask-steps">
              <button
                type="button"
                onClick={() => setStepsOpen((v) => !v)}
                aria-expanded={stepsOpen}
                data-testid="ask-steps-toggle"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium"
              >
                {stepsOpen ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
                research steps ({state.steps.length})
              </button>
              {stepsOpen && (
                <ul
                  className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground"
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

          {/* --------------------------------------------------------- answer */}
          {(hasAnswer || state.streaming) && (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
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
                      className="mx-0.5 rounded bg-primary/10 px-1 text-[0.8em] font-semibold text-primary hover:bg-primary/20"
                    >
                      {part.value}
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {/* -------------------------------------------------------- sources */}
          {state.sources.length > 0 && (
            <div className="flex flex-col gap-2" data-testid="ask-sources">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Sources
              </h3>
              <ol className="space-y-1 text-sm">
                {state.sources.map((source) => (
                  <li key={source.idx} data-testid={`ask-source-${source.idx}`}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-baseline gap-2 hover:text-primary"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {source.idx}.
                      </span>
                      <span className="min-w-0 flex-1 truncate">{source.title}</span>
                      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                        {source.domain}
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* ---------------------------------------------------------- media */}
          {hasMedia && (
            <div className="rounded-lg border" data-testid="ask-media">
              <button
                type="button"
                onClick={() => setMediaOpen((v) => !v)}
                aria-expanded={mediaOpen}
                data-testid="ask-media-toggle"
                className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium"
              >
                {mediaOpen ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
                media ({state.media.length})
              </button>
              {mediaOpen && (
                <div className="grid grid-cols-3 gap-2 border-t p-3" data-testid="ask-media-strip">
                  {state.media.map((item, index) => (
                    <a
                      key={`${item.url}-${index}`}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="truncate text-xs text-muted-foreground hover:text-primary"
                    >
                      {item.title || item.url}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------- usage */}
          {state.usage && (
            <div
              className="border-t pt-2 text-xs text-muted-foreground"
              data-testid="ask-usage"
            >
              {formatAskUsage(state.usage)}
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------ history */}
      <aside
        className="hidden w-72 shrink-0 border-l p-3 lg:block"
        data-testid="ask-history"
      >
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4" />
          History
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">No questions yet.</p>
        ) : (
          <ul className="space-y-1">
            {history.map((entry) => (
              <li key={entry.id} className="group flex items-start gap-1">
                <button
                  type="button"
                  onClick={() => reopen(entry)}
                  data-testid="ask-history-item"
                  className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                  title={entry.query}
                >
                  {entry.query}
                </button>
                <button
                  type="button"
                  onClick={() => forget(entry.id)}
                  aria-label="Forget this question"
                  data-testid="ask-history-forget"
                  className="rounded px-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

export default AskView;

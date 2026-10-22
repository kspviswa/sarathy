import {
  AlertTriangle,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  RefreshCw,
  Search,
  Timer,
} from "lucide-react";
import { useState } from "react";

import type { AskStep } from "@/lib/ask";
import { cn } from "@/lib/utils";

/**
 * The Research Progress panel — Uttaram's `AssistantSteps.tsx`, mapped onto
 * the dashboard's theme tokens.
 *
 * Uttaram draws a vertical timeline: a rounded icon chip on a connector
 * line, a bold title and a detail line, with the last step pulsing while the
 * answer is still being written. The panel is open while the turn streams
 * and folds itself away when the turn is done.
 *
 * The structure is copied; the palette is translated (`bg-card`,
 * `text-muted-foreground`, `border`, `bg-primary/10`, `text-primary`).
 */

/** The icon of one step. */
function stepIcon(step: AskStep) {
  switch (step.kind) {
    case "reasoning":
      return <Brain className="size-4" />;
    case "searching":
      return <Search className="size-4" />;
    case "found":
      return <FileText className="size-4" />;
    case "reading":
      return <BookOpen className="size-4" />;
    case "timeout":
      return <Timer className="size-4 text-amber-500" />;
    case "retrying":
      return <RefreshCw className="size-4 text-amber-500" />;
    case "gave_up":
      return <AlertTriangle className="size-4 text-destructive" />;
    default:
      return null;
  }
}

/** The title of one step. */
function stepTitle(step: AskStep, streaming: boolean): string {
  switch (step.kind) {
    case "reasoning":
      // "Thinking…" while the plan is still empty — it reads as a live
      // stage, not as a finished one.
      return streaming && !step.reasoning ? "Thinking…" : "Thinking";
    case "searching": {
      const count = step.queries.length;
      return `Searching ${count} ${count === 1 ? "query" : "queries"}`;
    }
    case "found":
      return `Found ${step.count} ${step.count === 1 ? "result" : "results"}`;
    case "reading": {
      const host = step.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return `Reading ${host}`;
    }
    case "timeout":
      return `Timed out (attempt ${step.attempt}/${step.max})`;
    case "retrying":
      return `Retrying (attempt ${step.attempt}/${step.max})`;
    case "gave_up":
      return "Gave up";
    default:
      return "Processing";
  }
}

/** The three-dot pulse of an empty reasoning step. */
function ThinkingPulse() {
  return (
    <div className="mt-1 flex items-center gap-1.5" data-testid="ask-step-pulse">
      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
      <span
        className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
        style={{ animationDelay: "300ms" }}
      />
    </div>
  );
}

/** The detail line of one step. */
function StepDetail({ step, streaming }: { step: AskStep; streaming: boolean }) {
  if (step.kind === "reasoning") {
    if (step.reasoning) {
      return (
        <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
          {step.reasoning}
        </p>
      );
    }
    return streaming ? <ThinkingPulse /> : null;
  }

  if (step.kind === "searching" && step.queries.length > 0) {
    return (
      <div className="mt-1 flex flex-col gap-0.5">
        {step.queries.map((query, index) => (
          <span
            key={`${query}-${index}`}
            className="truncate text-xs text-muted-foreground"
          >
            {query}
          </span>
        ))}
      </div>
    );
  }

  if (step.kind === "reading") {
    return (
      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={step.title}>
        {step.title}
      </p>
    );
  }

  if (step.kind === "gave_up" && step.message) {
    return <p className="mt-0.5 text-xs text-destructive">{step.message}</p>;
  }

  return null;
}

export function AskResearchProgress({
  steps,
  streaming,
}: {
  steps: AskStep[];
  /** Is the turn still being written? Only affects the live step's wording. */
  streaming: boolean;
}) {
  // Collapsed by default, and the reader decides when to open it.
  //
  // This used to auto-expand while the newest turn streamed, which pushed the
  // answer itself down the page — on a phone the progress list filled the
  // screen and every answer began with a long scroll. The step count in the
  // header is enough of a live signal; the detail is there on request.
  //
  // Deliberately no effect on `streaming`: once the reader opens or closes the
  // panel, it stays where they put it. Auto-collapsing a panel someone just
  // opened is its own small betrayal.
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 0) return null;

  const label = `Research Progress (${steps.length} ${steps.length === 1 ? "step" : "steps"})`;

  return (
    <div
      className="overflow-hidden rounded-lg border bg-card"
      data-testid="ask-steps"
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={label}
        data-testid="ask-steps-toggle"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Brain className="size-4 shrink-0" />
          <span className="truncate text-sm font-medium" data-testid="ask-steps-label">
            {label}
          </span>
        </span>
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t p-3" data-testid="ask-step-list">
          {steps.map((step, index) => {
            const isLastStep = index === steps.length - 1;
            const active = streaming && isLastStep;

            return (
              <div key={`${step.kind}-${index}`} className="flex gap-2" data-testid="ask-step">
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      "rounded-full bg-muted p-1.5 text-muted-foreground",
                      active && "animate-pulse",
                    )}
                  >
                    {stepIcon(step)}
                  </div>
                  {!isLastStep && <div className="mt-1.5 min-h-[20px] w-0.5 flex-1 bg-border" />}
                </div>

                <div className="min-w-0 flex-1 pb-1">
                  <span className="text-sm font-medium" data-testid="ask-step-title">
                    {stepTitle(step, active)}
                  </span>
                  <StepDetail step={step} streaming={active} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default AskResearchProgress;

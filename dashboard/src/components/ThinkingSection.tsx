import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { formatTurnDuration, type TurnSegment } from "@/lib/transcript";
import { MD_COMPONENTS, SAFE_REHYPE_PLUGINS } from "@/lib/markdown";

import { cn } from "@/lib/utils";
import { ToolChipList } from "./AssistantTurn";
import { CodeBlock } from "./CodeBlock";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface ThinkingSectionProps {
  toolHints: string[];
  thinkingContent: string;
  /**
   * The turn's monologue, once the turn has settled (spec 139 §A). A finished
   * turn shows only its answer in the bubble, so the narration that produced it
   * lives here: nothing is lost, but nothing competes with the reply either.
   * Empty while the turn is live — the prose is inline then, where you watch it.
   */
  notes?: TurnSegment[];
  done?: boolean;
  /**
   * How long the turn took, stamped by the reducer when it ended (spec 140 §A).
   * Absent while the turn runs; absent on a turn rebuilt from the session file,
   * which has no clock — the header then reads a bare "Thought".
   */
  durationMs?: number;
  /**
   * Render the header even with nothing to expand (spec 135 §A). A live turn
   * whose bubble has no prose yet shows exactly this one slim row — the "ugly
   * empty bubble" (header + big placeholder + working chip) it replaces.
   */
  alwaysShow?: boolean;
  isOpen?: boolean;
  onOpenFile?: (path: string) => void;
}

/** The collapse body's markdown: same pipeline as the bubble, smaller scale. */
function CollapseMarkdown({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={SAFE_REHYPE_PLUGINS}
      components={{
        ...MD_COMPONENTS,
        code: ({ children, className, ...props }) => {
          const isBlock = className?.startsWith("language-");
          if (isBlock) {
            return <CodeBlock className={className} onOpenFile={onOpenFile}>{String(children)}</CodeBlock>;
          }
          return (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/**
 * The turn's ONE collapse header (spec 135 §A, spec 140 §A).
 *
 * `chevron · <label> · steps`, with the live 3-dot pulse sitting IN that row
 * while the turn runs. There is deliberately nothing else: the separate big
 * `ThinkingIndicator` placeholder and the separate `working` ReactionChip that
 * used to stack under this header are gone, so a live turn with no prose yet is
 * one slim row rather than three stacked indicators.
 *
 * The label is the turn's own report of itself: "Thinking" while it works, then
 * "Thought for 2m 14s" once it is done. It used to read "Thinking" with a green
 * check forever, which said nothing about the turn and left the duration in a
 * grey meta row at the far right — Viswa: "why do I see 'thinking' with a
 * checkmark? It should be 'thought for x seconds/mins/hrs' right?"
 *
 * The settled duration comes from `durationMs`, stamped by the reducer when the
 * turn ended, NOT from a clock local to this component: a remount would restart
 * a local timer at zero and report "Thought for 0s", and a turn rebuilt from the
 * session file has no clock at all (so it reads a bare "Thought").
 */
export function ThinkingSection({
  toolHints,
  thinkingContent,
  notes = [],
  done = false,
  alwaysShow = false,
  durationMs,
  isOpen: controlledOpen,
  onOpenFile,
}: ThinkingSectionProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const startTimeRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (done) {
      setElapsed(Date.now() - startTimeRef.current);
      return;
    }
    const id = setInterval(() => {
      setElapsed(Date.now() - startTimeRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, [done]);

  const steps = toolHints.filter((h) => h && h.trim().length > 0).length;
  const hasContent =
    toolHints.length > 0 || thinkingContent.length > 0 || notes.length > 0;
  if (!hasContent && !alwaysShow) return null;

  // How long the turn took. Known once the reducer has stamped it; `null` when
  // it never will be (a turn rebuilt from the session file, or one that ended
  // without a `_final`). While the turn runs we only have a ticking clock.
  const settledMs = done ? (typeof durationMs === "number" ? durationMs : null) : null;
  const label = !done
    ? "Thinking"
    : settledMs === null
      ? "Thought"
      : `Thought for ${formatTurnDuration(settledMs)}`;

  // The meta row carries what the label does not: the step count. While the
  // turn runs it also carries the ticking elapsed time — that is the only clock
  // available then, and it moves into the label the moment the turn ends.
  const meta = [
    steps ? `${steps} step${steps === 1 ? "" : "s"}` : "",
    !done ? formatTurnDuration(elapsed) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // A collapse holding nothing but the tucked monologue — a turn rebuilt from
  // the session file (spec 139 §B) — has no step count and no reasoning, so
  // there is nothing to report. An empty row is omitted rather than rendered
  // blank.
  const showMeta = steps > 0 || (!done && thinkingContent.length > 0);

  return (
    <div className="think-header" data-testid="thinking-section">
      {hasContent ? (
        <button
          type="button"
          onClick={() => setInternalOpen(!internalOpen)}
          aria-expanded={isOpen}
          aria-label={label}
          className="flex w-full items-center gap-1.5 rounded-md py-1.5 text-left text-xs text-muted-foreground/80 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="thinking-toggle"
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform duration-200", isOpen && "rotate-90")}
          />
          {!done && (
            /* The live pulse lives IN this row: animated dots replace the old
               static spinner, the word shimmers. Both stand still under
               prefers-reduced-motion. There is no equivalent once the turn is
               done — "Thought for 2m 14s" is already the completion signal, so
               the green Check that used to sit here was pure redundancy. */
            <ThinkingIndicator showLabel={false} className="shrink-0" />
          )}
          <span className={cn("font-medium", !done && "thinking-shimmer")} data-testid="thinking-label">
            {label}
          </span>
          {showMeta && (
            <span
              className="ml-auto shrink-0 tabular-nums text-muted-foreground/50"
              data-testid="thinking-meta"
            >
              {meta}
            </span>
          )}
        </button>
      ) : (
        /* Nothing to reveal: the row is a STATUS LINE, not a control. A live
           turn's bubble with no prose yet still needs the slim row (spec 135
           §A) — but a chevron that expands onto nothing is a dead control, and
           a page reloaded mid-turn has no chips to show until the next frame. */
        <div
          className="flex w-full items-center gap-1.5 py-1.5 text-xs text-muted-foreground/80"
          data-testid="thinking-status"
        >
          <span className="size-3 shrink-0" aria-hidden="true" />
          <ThinkingIndicator showLabel={false} className="shrink-0" />
          <span className="font-medium thinking-shimmer">Thinking</span>
        </div>
      )}
      {isOpen && hasContent && (
        <div className="space-y-2 pb-2.5 pl-5" data-testid="thinking-body">
          {thinkingContent && (
            <div className="text-xs leading-relaxed text-muted-foreground/80">
              <CollapseMarkdown text={thinkingContent} onOpenFile={onOpenFile} />
            </div>
          )}
          {toolHints.length > 0 && <ToolChipList hints={toolHints} />}
          {notes.length > 0 && (
            /* The monologue, tucked (spec 139 §A): a settled turn's narration
               leaves the bubble and lives here, in the same muted ruled style
               it had while it was streaming. */
            <div className="trail-notes" data-testid="thinking-notes">
              {notes.map((note, i) => (
                <div key={i} className="trail-note" data-testid="trail-note">
                  <CollapseMarkdown text={note.text} onOpenFile={onOpenFile} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
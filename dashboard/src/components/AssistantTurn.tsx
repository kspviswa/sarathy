import { Wrench } from "lucide-react";
import type { ReactNode } from "react";

import { summarizeToolHint, type TurnSegment } from "@/lib/transcript";
import { cn } from "@/lib/utils";

/**
 * The ONE assistant bubble of a turn (spec 135 §A).
 *
 * A turn used to fragment: `_seal` closed the live bubble and the next
 * narration iteration opened a fresh one beside it, so a turn with three tool
 * calls rendered as three bubbles. Viswa's ask was explicit — "I don't want a
 * second bubble" — so the turn is now one bubble whose prose is an ordered
 * `segments[]`, and this module renders it identically on both SPAs.
 *
 * Everything visual that distinguishes the segments lives here rather than in
 * either ChatView, because the two drifting apart is exactly the class of bug
 * the shared `lib/transcript` reducer exists to prevent. The only thing a
 * surface supplies is the markdown body renderer (`renderSegment`), which
 * differs (openUI adapter vs. plain markdown) — the frame around it does not.
 */

/**
 * The hairline between two prose segments of the same turn.
 *
 * A 1px rule that fades out at BOTH ends with a faint glyph centred on it, so
 * the trail reads as a pause in one continuous response rather than as the seam
 * between two of them.
 */
function TrailDivider() {
  return (
    <div className="trail-divider" data-testid="trail-divider" aria-hidden="true">
      <span className="trail-rule" />
      <span className="trail-glyph">⁂</span>
      <span className="trail-rule" />
    </div>
  );
}

export interface TurnSegmentsProps {
  segments: TurnSegment[];
  /**
   * Whether this bubble is the one the turn in flight is writing
   * (`liveBubbleIndex`). Required, not defaulted: a caller that forgets it would
   * silently either keep the old "caret on a finished answer" bug (default true)
   * or drop the caret from a live answer (default false). Only a live bubble may
   * show a streaming caret — an unsealed trailing segment on a finished turn just
   * means the turn ended without a `_final` frame (voice replies, `/stop`).
   */
  live: boolean;
  /**
   * Renders one segment's prose. `streaming` is true for the trailing unsealed
   * segment of a LIVE bubble, which is where the caret belongs. Implementations
   * own their own caret (the desktop `MessageBody` / mobile `AssistantBody` both
   * append one).
   */
  renderSegment: (text: string, streaming: boolean) => ReactNode;
  className?: string;
}

/** One rendered unit of the turn's prose: a run of notes, or one answer. */
interface TurnRun {
  kind: "notes" | "answer";
  items: { text: string; streaming: boolean }[];
}

/**
 * Partition the turn's prose into the shapes the bubble renders (spec 138 §A).
 *
 * Consecutive notes collapse into ONE muted block — they are a list of steps,
 * not a sequence of paragraphs — while every answer stands alone at the bubble's
 * full prose weight. The divider between runs is what shows the turn's shape:
 * process above, reply below.
 *
 * The streaming edge always renders as an answer, never as a note: until the
 * loop commits it nobody knows whether it is the reply, and muting it would mute
 * the reply of every plain Q&A turn until `_final` landed.
 */
function turnRuns(segments: TurnSegment[], live: boolean): TurnRun[] {
  const runs: TurnRun[] = [];
  segments.forEach((seg, i) => {
    const streaming = live && !seg.sealed && i === segments.length - 1;
    const kind: TurnRun["kind"] = seg.kind === "note" && seg.sealed ? "notes" : "answer";
    const last = runs[runs.length - 1];
    if (kind === "notes" && last?.kind === "notes") {
      last.items.push({ text: seg.text, streaming });
      return;
    }
    runs.push({ kind, items: [{ text: seg.text, streaming }] });
  });
  return runs;
}

/**
 * The turn's prose, packed by kind (spec 135 §A, spec 138 §A).
 *
 * The monologue the loop narrates between tool calls is packed as a muted,
 * ruled list; the turn's answer keeps the bubble's full prose weight. Before
 * this, both rendered identically, so a finished turn read as a wall of
 * equal-weight prose in which the reply was indistinguishable from the process
 * (Viswa: "all this … is your monologue … but still your final partials").
 */
export function TurnSegments({ segments, live, renderSegment, className }: TurnSegmentsProps) {
  if (!segments.length) return null;
  const runs = turnRuns(segments, live);
  return (
    <div className={cn("flex flex-col", className)} data-testid="assistant-turn-segments">
      {runs.map((run, i) => (
        <div key={i} className="trail-segment">
          {i > 0 && <TrailDivider />}
          {run.kind === "notes" ? (
            <div className="trail-notes" data-testid="trail-notes">
              {run.items.map((item, j) => (
                <div key={j} className="trail-note" data-testid="trail-note">
                  {renderSegment(item.text, item.streaming)}
                </div>
              ))}
            </div>
          ) : (
            <div className="trail-answer" data-testid="trail-answer">
              {renderSegment(run.items[0].text, run.items[0].streaming)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Tool calls as chips rather than raw mono lines (spec 135 §A).
 *
 * `_tool_hint` frames arrive as `'read_file("a.py"), memory_log("tea")'` — one
 * string for the whole batch. Printed verbatim that is a wall of monospace; the
 * loop's own intent is a step list, so it is parsed into one chip per call
 * (`summarizeToolHint`, in `lib/transcript` — the parse is shared).
 *
 * A hint with no call shape (the image→VLM narration phases from job 134) has
 * no name to show and is rendered as the phase itself, still one chip.
 */
export function ToolChipList({ hints, className }: { hints: string[]; className?: string }) {
  const chips = hints.flatMap((hint) => summarizeToolHint(hint));
  if (!chips.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} data-testid="tool-chips">
      {chips.map((chip, i) => (
        <span
          key={`${chip.hint}-${i}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground"
          data-testid="tool-chip"
          title={chip.hint}
        >
          <Wrench className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          {chip.name && <span className="font-medium text-foreground/80">{chip.name}</span>}
          {chip.summary && <span className="truncate opacity-70">{chip.summary}</span>}
        </span>
      ))}
    </div>
  );
}
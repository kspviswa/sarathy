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
   * Renders one segment's prose. `streaming` is true for the trailing unsealed
   * segment, which is where the caret belongs. Implementations own their own
   * caret (the desktop `MessageBody` / mobile `AssistantBody` both append one).
   */
  renderSegment: (text: string, streaming: boolean) => ReactNode;
  className?: string;
}

/**
 * The turn's prose: every segment, in order, separated by the trail divider.
 *
 * The first segment sits flush with the bubble's own left edge; continuation
 * segments take a faint accent bar so the eye reads "more of the same answer"
 * instead of "a new message".
 */
export function TurnSegments({ segments, renderSegment, className }: TurnSegmentsProps) {
  if (!segments.length) return null;
  return (
    <div className={cn("flex flex-col", className)} data-testid="assistant-turn-segments">
      {segments.map((seg, i) => (
        <div key={i} className={cn("trail-segment", i > 0 && "trail-continue")}>
          {i > 0 && <TrailDivider />}
          <div className={cn("md", i > 0 && "border-l-2 border-primary/20 pl-3")}>
            {renderSegment(seg.text, !seg.sealed)}
          </div>
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
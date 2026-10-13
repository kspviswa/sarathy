import { ReactionChip } from "@/components/Presence";
import { EmojiText } from "@/lib/emojiIcons";
import type { LiveTurnStatus } from "@/lib/transcript";
import { cn } from "@/lib/utils";

/**
 * The live "working" strip (spec 134 §B).
 *
 * Shown while a turn is running. It carries the newest pipeline phase the loop
 * narrated — "🖼️ Preparing image…", "🔍 Sending image to VLM…", "✅ Image
 * description received", or a tool call — which is what Telegram prints in its
 * streaming draft. The label and the chip decision both come from
 * `deriveLiveTurnStatus` (`lib/transcript.ts`), so desktop and mobile cannot
 * disagree about what the turn is doing.
 *
 * The label runs through `EmojiText`, so the leading emoji renders as a lucide
 * icon exactly as it does in assistant prose — no raw OS glyph on the
 * dashboard (standing rule, 2026-10-13). Telegram keeps the plain emoji.
 *
 * The phase fades in on change (one remount per label, see `key` below) and the
 * animation is dropped entirely under `prefers-reduced-motion` — the label then
 * simply swaps.
 */
export function LiveStatus({
  label,
  showChip = false,
  elapsedMs,
  className,
}: LiveTurnStatus & {
  /** Desktop shows the turn timer on the chip; mobile does not. */
  elapsedMs?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
      data-testid="live-status"
    >
      {showChip && <ReactionChip state="working" elapsedMs={elapsedMs} />}
      <span
        key={label}
        className="live-hint min-w-0 truncate"
        data-testid="live-status-label"
        aria-live="polite"
      >
        <EmojiText text={label} />
      </span>
    </div>
  );
}
import { cn } from "@/lib/utils";
import { reactionFor, type ReactionState } from "@/lib/reactions";

/**
 * Presence indicator + per-message reaction chip.
 *
 * `presence` drives the top-bar avatar (idle / thinking / speaking) and
 * `state` drives the chip that sits under an in-flight assistant message. Both
 * read from the same reaction vocabulary so the two can never disagree.
 */
export function PresenceIndicator({
  state,
  className,
}: {
  state: ReactionState;
  className?: string;
}) {
  const live = reactionFor(state).live;

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      data-testid="presence-indicator"
      data-presence={state}
      title={reactionFor(state).label}
      aria-label={`Sarathy is ${reactionFor(state).label}`}
      role="status"
    >
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded-full bg-muted text-sm transition-colors",
          state === "failed" && "bg-destructive/15",
        )}
      >
        🪆
      </span>
      {live && (
        <span
          data-testid="presence-dot"
          className="absolute -bottom-0.5 -right-0.5 size-2.5 animate-pulse rounded-full border-2 border-background bg-primary"
        />
      )}
    </span>
  );
}

/** The small reaction chip rendered under the streaming message. */
export function ReactionChip({
  state,
  elapsedMs,
  tokens,
  className,
}: {
  state: ReactionState;
  elapsedMs?: number;
  tokens?: number;
  className?: string;
}) {
  const view = reactionFor(state);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground",
        view.live && "animate-pulse",
        className,
      )}
      data-testid="reaction-chip"
      data-state={state}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">{view.glyph}</span>
      <span>{view.label}</span>
      {elapsedMs !== undefined && elapsedMs > 0 && (
        <span className="tabular-nums opacity-70" data-testid="reaction-elapsed">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      )}
      {tokens !== undefined && tokens > 0 && (
        <span className="tabular-nums opacity-70" data-testid="reaction-tokens">
          {tokens} tkn
        </span>
      )}
    </span>
  );
}
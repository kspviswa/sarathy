import { cn } from "@/lib/utils";

/** Stagger so the dots travel instead of pulsing in unison. */
const DOT_DELAYS = ["0ms", "150ms", "300ms"];

export interface ThinkingIndicatorProps {
  label?: string;
  /** Dots-only mode: the label is already rendered next to this. */
  showLabel?: boolean;
  className?: string;
}

/**
 * The live "thinking" indicator (spec 131 §E).
 *
 * Replaces the old static `Loader2` spinner + pulse dot with a shimmering
 * label and travelling dots. Both animations live in `index.css` and are
 * switched off under `prefers-reduced-motion`, where the label falls back to a
 * solid muted colour and the dots sit still — still readable, just quiet.
 *
 * Shared by the collapse header and both SPAs' live bubbles so desktop and
 * mobile can never drift apart.
 */
export function ThinkingIndicator({
  label = "Thinking",
  showLabel = true,
  className,
}: ThinkingIndicatorProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid="thinking-indicator"
      className={cn("inline-flex items-center gap-1.5 text-muted-foreground", className)}
    >
      {showLabel && <span className="thinking-shimmer font-medium">{label}</span>}
      <span className="flex items-end gap-[3px]" aria-hidden="true" data-testid="thinking-dots">
        {DOT_DELAYS.map((delay) => (
          <span
            key={delay}
            className="thinking-dot inline-block size-1 rounded-full bg-current"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
    </span>
  );
}
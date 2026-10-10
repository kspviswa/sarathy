import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

export interface Suggestion {
  label: string;
  prompt: string;
}

/**
 * Empty/greeting state (spec §A).
 *
 * The mascot is the presence indicator here — a large avatar plus suggestion
 * chips, not a tiny nav dot. Chips are seeded from defaults and can be replaced
 * by the caller with recent topics so the state feels alive rather than static.
 */
export function GreetingState({
  suggestions,
  onPick,
  loading,
  className,
}: {
  suggestions: Suggestion[];
  onPick: (prompt: string) => void;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-6 py-16 text-center", className)}
      data-testid="greeting-state"
    >
      <div className="relative" data-testid="greeting-mascot">
        <div className="absolute inset-0 -z-10 blur-2xl" aria-hidden="true">
          <Logo size={88} />
        </div>
        <Logo size={72} />
      </div>

      <div className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {loading ? "Loading your conversation…" : "Hey Viswa — what are we working on?"}
        </h1>
        {!loading && (
          <p className="text-sm text-muted-foreground">
            Ask anything, or start from a suggestion below.
          </p>
        )}
      </div>

      {!loading && suggestions.length > 0 && (
        <div
          className="flex max-w-xl flex-wrap items-center justify-center gap-2"
          data-testid="suggestion-chips"
        >
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s.prompt)}
              data-testid="suggestion-chip"
              className="rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Default chips. Recent topics get merged in by the shell. */
export const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { label: "Say hello", prompt: "Say hello to me." },
  { label: "What can you do?", prompt: "What can you do? List your main capabilities." },
  { label: "Check my jobs", prompt: "Show me the status of my recent jobs." },
  { label: "Recall context", prompt: "What do you remember about my current projects?" },
];
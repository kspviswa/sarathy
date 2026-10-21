import type { AskMedia } from "@/lib/ask";
import { cn } from "@/lib/utils";

/**
 * The answer's media.
 *
 * The frozen backend contract has no media frame today, so this renders
 * nothing — but the RAIL/STRIP decision lives here, in ONE place, so the
 * desktop rail and the mobile strip can never drift (decision 7).
 */
export function AskMediaView({
  media,
  variant,
}: {
  media: AskMedia[];
  /** `rail` on desktop (a right column), `strip` on mobile (under the answer). */
  variant: "rail" | "strip";
}) {
  if (!media || media.length === 0) return null;

  if (variant === "rail") {
    return (
      <aside
        className="hidden w-64 shrink-0 lg:block"
        data-testid="ask-media-rail"
        aria-label="Media"
      >
        <div className="sticky top-4 flex flex-col gap-2">
          {media.map((item, index) => (
            <a
              key={`${item.url}-${index}`}
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate rounded-lg border bg-card p-2 text-xs text-muted-foreground hover:text-primary"
            >
              {item.title || item.url}
            </a>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <div
      className={cn("flex gap-2 overflow-x-auto pb-1")}
      data-testid="ask-media-strip"
      aria-label="Media"
    >
      {media.map((item, index) => (
        <a
          key={`${item.url}-${index}`}
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 truncate rounded-lg border bg-card p-2 text-xs text-muted-foreground"
        >
          {item.title || item.url}
        </a>
      ))}
    </div>
  );
}

export default AskMediaView;

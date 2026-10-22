import { Globe } from "lucide-react";
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AskSource } from "@/lib/ask";
import { proxiedImage } from "@/lib/mediaProxy";
import { cn } from "@/lib/utils";

/**
 * The source cards — Uttaram's `MessageSources.tsx`, mapped onto the
 * dashboard's theme tokens.
 *
 * Three cards by default; a "View N more" tile opens every source in a
 * modal. Each card carries the favicon, the domain (without `www.`), the
 * title and the citation index the answer points at.
 */

/**
 * The favicon of a source.
 *
 * The favicon service is a THIRD-PARTY host, and the browser asking it
 * directly is exactly what broke: the installed PWA and filtered networks
 * cannot reach it, so every card showed a blank square. The image is
 * fetched by the GATEWAY instead and served from this origin (spec 152 §A),
 * so the browser only ever talks to us.
 */
function faviconUrl(url: string): string {
  return `https://s2.googleusercontent.com/s2/favicons?domain_url=${encodeURIComponent(url)}`;
}

/**
 * One favicon.
 *
 * A favicon that cannot be fetched falls back to the globe — at the same
 * size, so a card never shows an empty square. The tile ("View N more")
 * uses the same component, so it gets the same fallback.
 */
function Favicon({ url, className }: { url: string; className?: string }) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <Globe
        data-testid="ask-favicon-fallback"
        className={cn("size-4 shrink-0 rounded text-muted-foreground", className)}
      />
    );
  }

  return (
    <img
      src={proxiedImage(faviconUrl(url))}
      width={16}
      height={16}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn("size-4 shrink-0 rounded", className)}
    />
  );
}

/** The host of a URL, without the `www.` prefix. */
export function sourceDomain(source: AskSource): string {
  if (source.domain) return source.domain.replace(/^www\./i, "");
  try {
    return new URL(source.url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** One card. A broken favicon falls back to a globe — it must not break the card. */
function SourceCard({
  source,
  className,
}: {
  source: AskSource;
  className?: string;
}) {
  const domain = sourceDomain(source);

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="ask-source-card"
      className={`flex flex-col gap-2 rounded-lg border bg-card p-3 font-medium transition-colors hover:bg-accent/50 ${className ?? ""}`}
      title={source.title}
    >
      <span className="truncate text-xs text-foreground">{source.title}</span>
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1">
          <Favicon url={source.url} />
          <span className="truncate text-xs text-muted-foreground">{domain}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="size-1 rounded-full bg-muted-foreground/60" />
          <span>{source.idx}</span>
        </span>
      </span>
    </a>
  );
}

export function AskSources({ sources }: { sources: AskSource[] }) {
  const [moreOpen, setMoreOpen] = useState(false);

  if (sources.length === 0) return null;

  const visible = sources.slice(0, 3);
  const hidden = sources.length - visible.length;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="ask-sources"
      >
        {visible.map((source) => (
          <div key={source.idx} data-testid={`ask-source-${source.idx}`}>
            <SourceCard source={source} className="h-full" />
          </div>
        ))}

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            data-testid="ask-sources-more"
            className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-left font-medium transition-colors hover:bg-accent/50"
          >
            <span className="flex flex-row items-center gap-1">
              {sources.slice(3, 6).map((source) => (
                <Favicon key={source.idx} url={source.url} />
              ))}
            </span>
            <span className="text-xs text-muted-foreground">View {hidden} more</span>
          </button>
        )}
      </div>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sources</DialogTitle>
            <DialogDescription>
              {sources.length} {sources.length === 1 ? "source" : "sources"} cited by this answer.
            </DialogDescription>
          </DialogHeader>
          <div
            className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-auto sm:grid-cols-2"
            data-testid="ask-sources-modal"
          >
            {sources.map((source) => (
              <div key={source.idx} data-testid={`ask-source-modal-${source.idx}`}>
                <SourceCard source={source} className="h-full" />
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AskSources;

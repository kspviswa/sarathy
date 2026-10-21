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

/**
 * The source cards — Uttaram's `MessageSources.tsx`, mapped onto the
 * dashboard's theme tokens.
 *
 * Three cards by default; a "View N more" tile opens every source in a
 * modal. Each card carries the favicon, the domain (without `www.`), the
 * title and the citation index the answer points at.
 */

/** The favicon of a source. Google's favicon service, like Uttaram's. */
function faviconUrl(url: string): string {
  return `https://s2.googleusercontent.com/s2/favicons?domain_url=${encodeURIComponent(url)}`;
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
  const [broken, setBroken] = useState(false);
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
          {broken ? (
            <Globe className="size-4 shrink-0 rounded text-muted-foreground" />
          ) : (
            <img
              src={faviconUrl(source.url)}
              width={16}
              height={16}
              alt=""
              loading="lazy"
              onError={() => setBroken(true)}
              className="size-4 shrink-0 rounded"
            />
          )}
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
                <img
                  key={source.idx}
                  src={faviconUrl(source.url)}
                  width={16}
                  height={16}
                  alt=""
                  loading="lazy"
                  className="size-4 rounded"
                />
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

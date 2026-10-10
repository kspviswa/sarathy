import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge, Tag } from "lucide-react";

import { api } from "@/lib/api";
import type { SessionFooter } from "@/lib/types";
import { cn } from "@/lib/utils";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Status strip under the composer — footer parity with Telegram (spec §D).
 *
 * Renders tokens, tokens/sec, cost, session topic, context usage and the active
 * model. Values come from `GET /api/session/footer`, which reads the same
 * usage rows and config that `format_usage_footer` uses, so the dashboard and
 * Telegram report the same numbers for the same turn.
 *
 * Refreshes while a turn is streaming so the numbers move live, when
 * `revision` changes (the chat passes the message count), and once more after
 * a turn settles — the usage row for a turn is written *after* its `_final`
 * frame lands, so a single read at that instant is stale by one turn.
 */
export function UsageFooter({
  sessionKey,
  streaming,
  revision,
  compact,
  className,
}: {
  sessionKey?: string;
  streaming?: boolean;
  /** Any value that changes when the session's usage may have changed. */
  revision?: number | string;
  /** Tighter text/spacing for narrow (mobile) footers so the strip stays one
   *  line instead of wrapping to two and inflating the composer block. */
  compact?: boolean;
  className?: string;
}) {
  const [data, setData] = useState<SessionFooter | null>(null);

  const load = useCallback(() => {
    // Defensive: the footer is decorative telemetry. If the endpoint is
    // missing or fails, keep rendering the chat rather than crashing it.
    if (typeof api.sessionFooter !== "function") return;
    api
      .sessionFooter(sessionKey)
      .then((d) => setData(d))
      .catch(() => {
        /* telemetry is best-effort; keep the last good value */
      });
  }, [sessionKey]);

  useEffect(() => {
    load();
    if (!streaming) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [load, streaming, revision]);

  // Trailing refresh: usage for the just-finished turn lands shortly after the
  // final frame, so re-read once it has had a chance to be written.
  const wasStreaming = useRef(false);
  useEffect(() => {
    const live = Boolean(streaming);
    if (wasStreaming.current && !live) {
      wasStreaming.current = false;
      const soon = setTimeout(load, 1200);
      const later = setTimeout(load, 4500);
      return () => {
        clearTimeout(soon);
        clearTimeout(later);
      };
    }
    wasStreaming.current = live;
  }, [streaming, load]);

  if (!data) return null;

  // Fresh session: the usage bucket and context estimate are meaningless until
  // the first real turn lands (the context line otherwise reports only the
  // system-prompt baseline). Show nothing but the model/provider line.
  if (data.messageCount === 0) {
    if (!data.model) return null;
    return (
      <div
        className={cn(
          "flex flex-wrap items-center px-1 text-muted-foreground",
          compact ? "gap-x-2 gap-y-0 text-[10px]" : "gap-x-3 gap-y-1 text-[11px]",
          className,
        )}
        data-testid="usage-footer"
      >
        <span className="ml-auto truncate font-medium text-foreground/80" data-testid="footer-model">
          {data.model}
          {data.provider ? ` · ${data.provider}` : ""}
        </span>
      </div>
    );
  }

  const contextPct = data.contextPct;
  // Warn before the window is genuinely tight, not at some arbitrary midpoint.
  const contextTone =
    contextPct === null || contextPct === undefined
      ? ""
      : contextPct >= 90
        ? "text-destructive"
        : contextPct >= 70
          ? "text-amber-600 dark:text-amber-400"
          : "";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center px-1 text-muted-foreground",
        compact ? "gap-x-2 gap-y-0 text-[10px]" : "gap-x-3 gap-y-1 text-[11px]",
        className,
      )}
      data-testid="usage-footer"
    >
      <span className="tabular-nums" data-testid="footer-tokens">
        ⚡ {fmtTokens(data.tokens)} tkn
      </span>
      {data.tokensPerSec > 0 && (
        <span className="tabular-nums" data-testid="footer-tps">
          @ {data.tokensPerSec.toFixed(1)} tps
        </span>
      )}
      <span className="tabular-nums" data-testid="footer-cost">
        💵 {data.cost === null ? "—" : `$${data.cost.toFixed(4)}`} session
      </span>
      {data.topic && (
        <span className="inline-flex items-center gap-1" data-testid="footer-topic">
          <Tag className="size-3" />
          {data.topic}
        </span>
      )}
      {contextPct !== null && contextPct !== undefined && (
        <span
          className={cn("inline-flex items-center gap-1 tabular-nums", contextTone)}
          data-testid="footer-context"
        >
          <Gauge className="size-3" />
          ctx {contextPct}% ({fmtTokens(data.contextUsedTokens ?? 0)}/
          {fmtTokens(data.contextLength ?? 0)})
        </span>
      )}
      {data.model && (
        <span className="ml-auto truncate font-medium text-foreground/80" data-testid="footer-model">
          {data.model}
          {data.provider ? ` · ${data.provider}` : ""}
        </span>
      )}
    </div>
  );
}
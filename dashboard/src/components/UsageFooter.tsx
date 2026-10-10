import { useEffect, useState } from "react";
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
 * Refreshes while a turn is streaming so the numbers move live.
 */
export function UsageFooter({
  sessionKey,
  streaming,
  className,
}: {
  sessionKey?: string;
  streaming?: boolean;
  className?: string;
}) {
  const [data, setData] = useState<SessionFooter | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // Defensive: the footer is decorative telemetry. If the endpoint is
      // missing or fails, keep rendering the chat rather than crashing it.
      if (typeof api.sessionFooter !== "function") return;
      api
        .sessionFooter(sessionKey)
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {
          /* telemetry is best-effort; keep the last good value */
        });
    };
    load();
    if (!streaming) return () => { cancelled = true; };
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionKey, streaming]);

  if (!data) return null;

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
        "flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground",
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
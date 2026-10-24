import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDollarSign,
  Copy,
  CornerUpLeft,
  Link2,
  Quote,
  RefreshCw,
  Repeat2,
  Sigma,
  Timer,
  Wand2,
} from "lucide-react";
import { useState } from "react";

import { AskAnswer } from "@/components/ask/AskAnswer";
import { AskResearchProgress } from "@/components/ask/AskResearchProgress";
import { AskSources } from "@/components/ask/AskSources";
import { AskMediaButtons } from "@/components/ask/AskMediaButtons";
import { AskMediaView } from "@/components/ask/AskMediaView";
import { Collapsible } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { copyText } from "@/components/ask/copy";
import {
  formatAskUsageCost,
  formatAskTokenCount,
  normaliseCitationMarkers,
  phaseLabel,
  type AskPhase,
  type AskTurn,
} from "@/lib/ask";

/**
 * One turn of an Ask thread.
 *
 * The order is Uttaram's: the query as a heading, the live state line, the
 * research timeline, the sources, the answer and the action row.
 */

/** Past this length the heading is clamped and a "show more" appears. */
const QUERY_CLAMP = 200;

export function AskTurnCard({
  turn,
  streaming,
  phase,
  onReply,
  onQuote,
  onRewrite,
  onSummarize,
  turns,
  threadId,
  onMediaUpdate,
  /** Start the next Ask turn from a widget button inside the answer. */
  onSend,
  /** Touch devices have no hover, so the actions are always visible there. */
  alwaysShowActions = false,
  /** The mobile shell renders the collapsible; the desktop shell the rail. */
  isMobile = false,
}: {
  turn: AskTurn;
  /** Is this turn still streaming? */
  streaming: boolean;
  /** The live phase of the turn — drives the state line. */
  phase?: AskPhase;
  /** Seed the composer with this turn as the reply context. */
  onReply: (turn: AskTurn) => void;
  /** Quote this whole answer into the composer. */
  onQuote: (turn: AskTurn) => void;
  /** Research the same query again. */
  onRewrite: (turn: AskTurn) => void;
  /** Research a summary of this answer. */
  onSummarize: (turn: AskTurn) => void;
  turns?: AskTurn[];
  threadId?: string | null;
  onMediaUpdate?: (turnId: string, media: any[]) => void;
  onSend?: (message: string) => void;
  alwaysShowActions?: boolean;
  isMobile?: boolean;
}) {
  const [queryExpanded, setQueryExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);

  const isLongQuery = turn.query.length > QUERY_CLAMP;
  const displayQuery =
    isLongQuery && !queryExpanded
      ? `${turn.query.slice(0, QUERY_CLAMP)}…`
      : turn.query;

  const copyQuery = async () => {
    const ok = await copyText(turn.query);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const copyAnswer = async () => {
    await copyText(normaliseCitationMarkers(turn.answer));
  };

  const hasAnswer = turn.answer.trim().length > 0;

  const media = turn.media ?? [];
  const hasMedia = media.length > 0;
  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");
  const mediaParts: string[] = [];
  if (images.length > 0) {
    mediaParts.push(`${images.length} image${images.length === 1 ? "" : "s"}`);
  }
  if (videos.length > 0) {
    mediaParts.push(`${videos.length} video${videos.length === 1 ? "" : "s"}`);
  }
  const mediaTitle = mediaParts.length > 0 ? `Media · ${mediaParts.join(" · ")}` : null;

  const onMediaLoaded = (turnId: string, loaded: any[]) => {
    if (onMediaUpdate) onMediaUpdate(turnId, loaded);
  };

  const mediaButtons = (
    <AskMediaButtons
      turn={turn}
      turns={turns || [turn]}
      threadId={threadId ?? null}
      onMediaLoaded={onMediaLoaded}
    />
  );

  return (
    <article className="flex flex-col gap-4 lg:flex-row lg:gap-6 lg:justify-center" data-testid="ask-turn">
      <div className="flex min-w-0 w-full flex-col gap-4 lg:max-w-3xl">
        {/* --------------------------------------------------------- heading */}
        <div className="flex items-start gap-2">
          <h2
            className="min-w-0 flex-1 break-words text-xl font-medium sm:text-2xl"
            data-testid="ask-turn-query"
          >
            {displayQuery}
          </h2>
          <button
            type="button"
            onClick={() => void copyQuery()}
            aria-label="Copy prompt"
            title="Copy prompt"
            data-testid="ask-copy-query"
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Copy className="size-4" />
          </button>
        </div>

        {isLongQuery && (
          <button
            type="button"
            onClick={() => setQueryExpanded((value) => !value)}
            data-testid="ask-query-expand"
            className="-mt-2 self-start text-xs text-primary hover:underline"
          >
            {queryExpanded ? "Show less" : "Show more"}
          </button>
        )}

        {/* ------------------------------------------------------ state line */}
        {streaming && (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="ask-phase"
          >
            <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            <span>{phaseLabel(phase ?? "researching")}</span>
          </div>
        )}

        {/* --------------------------------------------------------- error */}
        {turn.error && (
          <div
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="ask-error"
          >
            {turn.error.message}
          </div>
        )}

        {/* ------------------------------------------------- research progress */}
        <AskResearchProgress steps={turn.steps} streaming={streaming} />

        {/* --------------------------------------------------------- sources */}
        {turn.sourcesList.length > 0 && (
          <Collapsible
            title={`Sources (${turn.sourcesList.length})`}
            testId="ask-sources-collapsible-trigger"
          >
            <AskSources sources={turn.sourcesList} />
          </Collapsible>
        )}

        {/* ---------------------------------------------------------- answer */}
        {(hasAnswer || streaming) && (
          <div className="flex flex-col gap-2" data-testid="ask-answer">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Answer
            </h3>
            <AskAnswer
              answer={turn.answer}
              sources={turn.sourcesList}
              isStreaming={streaming}
              onSend={onSend}
            />
          </div>
        )}

        {/*
          The media belongs to THIS turn, so it is drawn HERE. It used to be a
          single rail fed by the LAST turn only: clicking "Search images" on any
          earlier answer filled the store and drew nothing.

          The parent decides which shell shows it (spec 153 §C): the desktop
          aside is wrapped in `hidden lg:block`, the mobile collapsible in
          `lg:hidden` — never the other way round.
        */}
        {hasAnswer && isMobile && (
          <div className="lg:hidden">
            {mediaButtons}
            {hasMedia && (
              <Collapsible
                open={mediaOpen}
                onOpenChange={setMediaOpen}
                title={mediaTitle}
                testId="ask-media-collapsible-trigger"
              >
                <AskMediaView media={media} variant="strip" />
              </Collapsible>
            )}
          </div>
        )}

        {hasAnswer && (
          <div
            className={cn(
              "flex items-center gap-1 border-t pt-2",
              alwaysShowActions ? "opacity-100" : "opacity-0 transition-opacity group-hover:opacity-100",
            )}
            data-testid="ask-actions"
          >
            <button
              type="button"
              onClick={() => onRewrite(turn)}
              aria-label="Rewrite this answer"
              title="Research this query again"
              data-testid="ask-action-rewrite"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => onSummarize(turn)}
              aria-label="Summarize this answer"
              title="Summarize this answer"
              data-testid="ask-action-summarize"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Wand2 className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => void copyAnswer()}
              aria-label="Copy answer"
              title="Copy answer"
              data-testid="ask-action-copy"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Copy className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => onReply(turn)}
              aria-label="Reply to this answer"
              title="Reply — re-research in this thread"
              data-testid="ask-action-reply"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CornerUpLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => onQuote(turn)}
              aria-label="Quote this answer"
              title="Quote this answer"
              data-testid="ask-action-quote"
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Quote className="size-4" />
            </button>
            {copied && (
              <span className="text-xs text-muted-foreground" data-testid="ask-copied">
                Copied
              </span>
            )}
          </div>
        )}

        {turn.usage && (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
            data-testid="ask-usage"
          >
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              data-testid="ask-usage-latency"
            >
              <Timer className="size-3" aria-hidden="true" />
              {(turn.usage.latencyMs / 1000).toFixed(1)} s
            </span>
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              data-testid="ask-usage-iterations"
            >
              <Repeat2 className="size-3" aria-hidden="true" />
              {turn.usage.iterations}{" "}
              {turn.usage.iterations === 1 ? "iteration" : "iterations"}
            </span>
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              data-testid="ask-usage-sources"
            >
              <Link2 className="size-3" aria-hidden="true" />
              {turn.usage.sources} {turn.usage.sources === 1 ? "source" : "sources"}
            </span>
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              data-testid="ask-usage-tokens"
            >
              <ArrowDownToLine className="size-3" aria-hidden="true" />
              {formatAskTokenCount(turn.usage.tokensIn)} in ·{" "}
              <ArrowUpFromLine className="size-3" aria-hidden="true" />
              {formatAskTokenCount(turn.usage.tokensOut)} out ·{" "}
              <Sigma className="size-3" aria-hidden="true" />
              {formatAskTokenCount(
                turn.usage.tokensIn + turn.usage.tokensOut,
              )}{" "}
              total tokens
            </span>
            {formatAskUsageCost(turn.usage) && (
              <span
                className="inline-flex items-center gap-1 tabular-nums"
                data-testid="ask-usage-cost"
              >
                <CircleDollarSign className="size-3" aria-hidden="true" />
                {formatAskUsageCost(turn.usage)}
              </span>
            )}
          </div>
        )}
      </div>

      {hasAnswer && !isMobile && (
        <div className="hidden lg:block">
          <AskMediaView media={media} variant="rail" toolbar={mediaButtons} />
        </div>
      )}
    </article>
  );
}

export default AskTurnCard;

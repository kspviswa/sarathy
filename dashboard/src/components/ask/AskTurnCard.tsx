import {
  Copy,
  CornerUpLeft,
  Quote,
  RefreshCw,
  Wand2,
} from "lucide-react";
import { useState } from "react";

import { AskAnswer } from "@/components/ask/AskAnswer";
import { AskResearchProgress } from "@/components/ask/AskResearchProgress";
import { AskSources } from "@/components/ask/AskSources";
import { AskMediaButtons } from "@/components/ask/AskMediaButtons";
import { AskMediaView } from "@/components/ask/AskMediaView";
import { copyText } from "@/components/ask/copy";
import {
  formatAskUsage,
  normaliseCitationMarkers,
  phaseLabel,
  type AskPhase,
  type AskTurn,
} from "@/lib/ask";
import { cn } from "@/lib/utils";

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
  isLast,
  streaming,
  phase,
  onReply,
  onQuote,
  onRewrite,
  onSummarize,
  turns,
  threadId,
  onMediaUpdate,
  /** Touch devices have no hover, so the actions are always visible there. */
  alwaysShowActions = false,
}: {
  turn: AskTurn;
  /** Is this the newest turn? */
  isLast: boolean;
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
  alwaysShowActions?: boolean;
}) {
  const [queryExpanded, setQueryExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

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

  return (
    <article className="flex flex-col gap-4" data-testid="ask-turn">
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

      {/* ----------------------------------------------------------- error */}
      {turn.error && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="ask-error"
        >
          {turn.error.message}
        </div>
      )}

      {/* ------------------------------------------------- research progress */}
      <AskResearchProgress
        steps={turn.steps}
        isLast={isLast}
        streaming={streaming}
      />

      {/* --------------------------------------------------------- sources */}
      {turn.sourcesList.length > 0 && <AskSources sources={turn.sourcesList} />}

      {/* ---------------------------------------------------------- answer */}
      {(hasAnswer || streaming) && (
        <div className="flex flex-col gap-2" data-testid="ask-answer">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Answer
          </h3>
          <AskAnswer answer={turn.answer} sources={turn.sourcesList} />
        </div>
      )}

      {/* ------------------------------------------------------------- media */}
      {/*
        The media belongs to THIS turn, so it is drawn HERE. It used to be a
        single rail fed by the LAST turn only: clicking "Search images" on any
        earlier answer filled the store and drew nothing.
      */}
      {hasAnswer && (
        <AskMediaButtons
          turn={turn}
          turns={turns || [turn]}
          threadId={threadId ?? null}
          onMediaLoaded={(turnId, media) => {
            if (onMediaUpdate) onMediaUpdate(turnId, media);
          }}
        />
      )}

      {hasAnswer && turn.media && turn.media.length > 0 && (
        <AskMediaView media={turn.media} variant="strip" />
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
        <div className="text-xs text-muted-foreground" data-testid="ask-usage">
          {formatAskUsage(turn.usage)}
        </div>
      )}
    </article>
  );
}

export default AskTurnCard;

import { Sparkles } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { AskComposer } from "@/components/ask/AskComposer";
import { AskHeader } from "@/components/ask/AskHeader";
import { AskTurnCard } from "@/components/ask/AskTurnCard";
import { JumpToLatest } from "@/components/JumpToLatest";
import { QuoteActionBar, useTextSelection } from "@/components/QuoteAsk";
import {
  useAskStream,
  requestAskHistory,
  type AskHistoryTurn,
  type AskMode,
  type AskSourceKind,
  type AskTurn,
  buildAskHistory,
} from "@/lib/ask";
import {
  addQuote,
  buildQuotesPayload,
  clearQuotes,
  quoteFromSelection,
  quoteFromText,
  removeQuote,
  MAX_QUOTE_CHARS,
  type QuoteChip,
} from "@/lib/quotes";
import { useChatScroll } from "@/lib/useChatScroll";

/**
 * The Ask canvas — the shared surface behind BOTH shells.
 *
 * The desktop view (`views/AskView.tsx`) and the mobile view
 * (`mobile/AskView.tsx`) render this and nothing else, so the two can never
 * drift (HARD LESSON 20/22). The frame → state logic lives in `lib/ask.ts`;
 * this file is presentation plus the composer interactions.
 */
export function AskSurface({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const { state, turns, run, stop, reset, threadId, threads, updateMedia } = useAskStream();

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<AskMode>("speed");
  const [sources, setSources] = useState<AskSourceKind[]>(["web"]);
  const [quoteChips, setQuoteChips] = useState<QuoteChip[]>([]);
  /** The turn a "Reply" points at. */
  const [replyTurn, setReplyTurn] = useState<AskTurn | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const scroll = useChatScroll(scrollRef, {
    messages: turns,
    streaming: state.streaming,
  });

  // The quote selection lives inside the answers — the same rule Chat
  // follows (only the assistant's words are quotable).
  const selection = useTextSelection(listRef, !state.streaming);

  const selectionInAnswer = useMemo(() => {
    if (!selection.visible) return false;
    if (typeof window === "undefined") return false;
    const node = window.getSelection()?.anchorNode;
    if (!node) return false;
    const element =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    return Boolean(element?.closest?.('[data-testid="ask-answer"]'));
  }, [selection.visible, selection.text]);

  const addSelectionAsQuote = useCallback(() => {
    const quote = selection.text
      ? quoteFromText(selection.text, { sourceRole: "assistant" })
      : quoteFromSelection(window.getSelection(), { sourceRole: "assistant" });
    if (!quote) return;
    setQuoteChips((chips) => addQuote(chips, quote));
    window.getSelection()?.removeAllRanges();
  }, [selection.text]);

  /** Quote the whole answer of a turn. */
  const quoteTurn = useCallback((turn: AskTurn) => {
    const quote = quoteFromText(turn.answer.slice(0, MAX_QUOTE_CHARS), {
      sourceRole: "assistant",
    });
    if (!quote) return;
    setQuoteChips((chips) => addQuote(chips, quote));
  }, []);

  /** Seed the composer with the replied-to turn (decision 5: same thread). */
  const replyToTurn = useCallback((turn: AskTurn) => {
    setReplyTurn(turn);
  }, []);

  /** Research the same query again, in the same thread. */
  const rewriteTurn = useCallback(
    (turn: AskTurn) => {
      void run({
        query: turn.query,
        mode: turn.mode,
        sources: turn.sources,
      });
    },
    [run],
  );

  /** Summarize an answer — the answer travels as the engine's history. */
  const summarizeTurn = useCallback(
    (turn: AskTurn) => {
      const history: AskHistoryTurn[] = [
        ["human", turn.query],
        ["assistant", turn.answer],
      ];
      void run({
        query: "Summarize the answer above in a short, factual paragraph.",
        mode: turn.mode,
        sources: turn.sources,
        history,
      });
    },
    [run],
  );

  const submit = useCallback((explicit?: string) => {
    // The composer calls this with no argument (or, via React's onClick, a
    // MouseEvent — hence the `typeof` guard). A widget button passes the
    // question it raised, which starts the next turn directly.
    const raw = typeof explicit === "string" ? explicit : query;
    const trimmed = raw.trim();
    if (!trimmed || state.streaming) return;

    const quotes = buildQuotesPayload(quoteChips);

    // EVERY follow-up carries the thread, not just the ones started from
    // "Reply". Deriving it from the open thread is what makes a typed follow-up
    // ("and the second one?") resolvable at all — an explicit Reply only
    // pins which turn the composer refers to.
    const history = buildAskHistory(turns);

    setQuery("");
    setQuoteChips(clearQuotes());
    setReplyTurn(null);

    void run({
      query: trimmed,
      mode,
      sources: sources.length ? sources : ["web"],
      quotes: quotes.length ? quotes : undefined,
      history,
    });
  }, [query, state.streaming, quoteChips, turns, mode, sources, run]);

  const isMobile = variant === "mobile";

  /** The open thread's title — shown in the header beside the buttons. */
  const threadTitle = useMemo(
    () => threads.find((thread) => thread.id === threadId)?.title ?? "",
    [threads, threadId],
  );

  /**
   * Start a new ask.
   *
   * The canvas empties and the active thread is dropped, so the next
   * question opens a FRESH thread (job 150 §C). The old thread stays in
   * the history.
   */
  const startNewAsk = useCallback(() => {
    reset();
  }, [reset]);

  return (
    <div className="flex h-full min-h-0" data-testid={isMobile ? "ask-mobile" : "ask-surface"}>
      <div className="flex min-w-0 flex-1 flex-col">
        <AskHeader
          title={threadTitle}
          hasThread={Boolean(threadId)}
          onNewAsk={startNewAsk}
          onOpenHistory={requestAskHistory}
        />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={scroll.onScroll}
            className="min-h-0 flex-1 overflow-y-auto"
            data-testid="ask-scroll"
          >
            <div
              ref={listRef}
              className={`mx-auto flex w-full flex-col gap-8 ${
                isMobile ? "p-3" : "max-w-6xl p-4"
              }`}
              data-testid="ask-turns"
            >
              {turns.length === 0 ? (
                <div
                  className="flex flex-col items-center gap-2 py-16 text-center"
                  data-testid="ask-empty"
                >
                  <Sparkles className="size-6 text-muted-foreground" />
                  <p className="text-sm font-medium">Ask anything</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Sarathy researches the question, shows its sources and writes the answer —
                    in one continuous thread.
                  </p>
                </div>
              ) : (
                turns.map((turn, index) => (
                  <AskTurnCard
                    key={turn.id}
                    turn={turn}
                    streaming={state.streaming && index === turns.length - 1}
                    phase={state.phase}
                    onReply={replyToTurn}
                    onQuote={quoteTurn}
                    onRewrite={rewriteTurn}
                    onSummarize={summarizeTurn}
                    turns={turns}
                    threadId={threadId}
                    onMediaUpdate={(turnId: string, media: any[]) => {
                      if (updateMedia) updateMedia(turnId, media);
                    }}
                    onSend={submit}
                    alwaysShowActions={isMobile}
                    isMobile={isMobile}
                  />
                ))
              )}

            </div>
          </div>

          <JumpToLatest
            show={scroll.showJump}
            newCount={scroll.newCount}
            onClick={scroll.jumpToLatest}
          />
        </div>

        <AskComposer
          query={query}
          onQueryChange={setQuery}
          mode={mode}
          onModeChange={setMode}
          sources={sources}
          onSourcesChange={setSources}
          streaming={state.streaming}
          onSubmit={submit}
          onStop={() => void stop()}
          quoteChips={quoteChips}
          onRemoveQuote={(id) => setQuoteChips((chips) => removeQuote(chips, id))}
          replyContext={replyTurn ? { query: replyTurn.query } : null}
          onClearReply={() => setReplyTurn(null)}
          variant={variant}
        />
      </div>


      <QuoteActionBar
        visible={selection.visible && selectionInAnswer}
        rect={selection.rect}
        onAdd={addSelectionAsQuote}
      />
    </div>
  );
}

export default AskSurface;

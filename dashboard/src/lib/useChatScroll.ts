import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * The chat's scroll anchor, shared by BOTH SPAs (spec 141 §A).
 *
 * Two behaviours live here, and they are two halves of one idea:
 *
 *  1. **Auto-follow.** While the reader is at the bottom the transcript keeps
 *     itself pinned there, so a streaming reply grows under a stationary eye.
 *     The moment the reader scrolls away, following STOPS — yanking the viewport
 *     back down while someone is reading history is the rudest thing a chat can
 *     do.
 *  2. **A way back.** Being scrolled up is now a state the UI must show, because
 *     the reader is missing content that is arriving below. This hook exposes
 *     that state (`showJump`) plus what was missed (`newCount`), and the views
 *     render it as the "jump to latest" pill.
 *
 * Viswa: *"can you add scroll up bottom contextual button? It should appear when
 * I'm at the top or middle of the screen and chat is growing down."*
 *
 * Both SPAs previously tracked this privately with a `isNearBottomRef` and a
 * duplicated `checkNearBottom` — a ref, so nothing could react to it and there
 * was no way to surface the state. Duplication is how the two drift, so the rule
 * is the same as `lib/transcript.ts`: one module, both views.
 */

/** How close to the bottom still counts as "at the bottom". */
const NEAR_BOTTOM_PX = 100;

/** Fraction of the remaining distance covered per animation frame. */
const GLIDE_EASE = 0.25;

/**
 * Floor on the per-frame step, so a very long hop still finishes in reasonable
 * time instead of crawling the last few hundred pixels at 25% of an ever-smaller
 * remainder.
 */
const GLIDE_MIN_STEP = 24;

export interface ChatScroll {
  /** True when the reader is away from the newest content. */
  showJump: boolean;
  /** Messages that landed while the reader was away — 0 when none. */
  newCount: number;
  /** Scroll to the newest content and resume auto-follow. */
  jumpToLatest: () => void;
  /** True while the viewport is pinned to the bottom. */
  isNearBottom: () => boolean;
}

export interface UseChatScrollOptions {
  /** The transcript, used to count what arrives while the reader is away. */
  messages: unknown[];
  /** A turn in flight can grow the transcript without adding a message. */
  streaming?: boolean;
  /** Distance from the bottom that still counts as pinned. */
  threshold?: number;
}

/**
 * Attach the returned `onScroll` to the scrollable container and pass the same
 * element as `scrollRef`. The ref may be owned by the caller (desktop's
 * `messagesRef` prop) — this hook never creates one, so both SPAs share it.
 */
export function useChatScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  { messages, streaming = false, threshold = NEAR_BOTTOM_PX }: UseChatScrollOptions,
): ChatScroll & { onScroll: () => void } {
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const nearBottomRef = useRef(true);
  /** Message count at the last moment we were pinned — the baseline for the badge. */
  const seenCountRef = useRef(messages.length);
  /**
   * True while our own glide to the bottom is running. Its frames pass through
   * "not at the bottom" on the way down, so they must not be read as a
   * scroll-away and must not flash the pill.
   *
   * While it is set, auto-follow stays ON: our own frames are not the reader's
   * doing, and if the transcript grows under us the follow pins to the new
   * bottom rather than leaving the reader stranded with the pill showing.
   */
  const jumpingRef = useRef(false);
  /** The glide's animation frame handle, so it can be cancelled. */
  const glideRef = useRef<number | null>(null);
  /** Last observed scroll offset — the sign of the delta tells us who scrolled. */
  const lastTopRef = useRef(0);

  const stopGlide = useCallback(() => {
    if (glideRef.current !== null) {
      cancelAnimationFrame(glideRef.current);
      glideRef.current = null;
    }
  }, []);

  // A glide outlives the render that started it, so cancel it on unmount.
  useEffect(() => stopGlide, [stopGlide]);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, [scrollRef, threshold]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom();
    const top = el.scrollTop;

    if (jumpingRef.current) {
      // A DECREASING offset is never ours — a glide to the bottom only descends
      // — so it means the reader took over and the glide must yield.
      if (top < lastTopRef.current) {
        jumpingRef.current = false;
        stopGlide();
        nearBottomRef.current = false;
        lastTopRef.current = top;
        setShowJump(true);
        return;
      }
      lastTopRef.current = top;
      if (near) {
        jumpingRef.current = false;
        stopGlide();
        nearBottomRef.current = true;
        seenCountRef.current = messages.length;
        setNewCount(0);
        setShowJump(false);
      }
      return;
    }

    nearBottomRef.current = near;
    if (near) {
      seenCountRef.current = messages.length;
      setNewCount(0);
    }
    lastTopRef.current = top;
    setShowJump(!near);
  }, [isNearBottom, scrollRef, stopGlide, messages.length]);

  /**
   * Glide to the bottom, aiming at a LIVE target.
   *
   * This used to be `scrollTo({ top: scrollHeight, behavior: "smooth" })`, which
   * aims at the height measured when it is called. The transcript can grow while
   * it animates — a late transcript fetch resolving, a streaming turn writing —
   * and then the hop lands short of the bottom it was aimed at and stays there:
   * measured 141px short on a real transcript, which left the reader just above
   * the bottom with the pill showing again. Re-reading `scrollHeight` every
   * frame cannot go stale.
   */
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stopGlide();
    jumpingRef.current = true;
    lastTopRef.current = el.scrollTop;
    nearBottomRef.current = true;
    seenCountRef.current = messages.length;
    setShowJump(false);
    setNewCount(0);

    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const step = () => {
      const node = scrollRef.current;
      if (!node) {
        glideRef.current = null;
        return;
      }
      const max = node.scrollHeight - node.clientHeight;
      const delta = max - node.scrollTop;
      if (delta <= 1) {
        glideRef.current = null;
        jumpingRef.current = false;
        lastTopRef.current = node.scrollTop;
        return;
      }
      node.scrollTop = node.scrollTop + Math.max(delta * GLIDE_EASE, GLIDE_MIN_STEP);
      glideRef.current = requestAnimationFrame(step);
    };

    if (reduceMotion) {
      el.scrollTop = el.scrollHeight;
      jumpingRef.current = false;
      lastTopRef.current = el.scrollTop;
      return;
    }
    glideRef.current = requestAnimationFrame(step);
  }, [scrollRef, stopGlide, messages.length]);

  // What landed while the reader was away. Counted in MESSAGES, not frames: a
  // streaming turn is one message growing, and the pill is already visible for
  // that — a badge counting frames would tick up meaninglessly.
  useEffect(() => {
    if (nearBottomRef.current) {
      seenCountRef.current = messages.length;
      return;
    }
    const missed = messages.length - seenCountRef.current;
    if (missed > 0) setNewCount((c) => Math.max(c, missed));
  }, [messages.length]);

  // Auto-follow: keep the newest content in view only while the reader is
  // pinned. Runs on `streaming` too, since a turn grows without adding messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
    seenCountRef.current = messages.length;
  }, [messages, streaming, scrollRef]);

  return { showJump, newCount, jumpToLatest, isNearBottom, onScroll };
}

/** The pill's label — the count when there is one, otherwise a plain prompt. */
export function jumpLabel(newCount: number): string {
  if (newCount <= 0) return "Jump to latest";
  return newCount === 1 ? "1 new message" : `${newCount} new messages`;
}

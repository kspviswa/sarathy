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
   * True while a programmatic scroll to the bottom is in flight. A long hop can
   * take hundreds of milliseconds and passes through "not at the bottom" on the
   * way down; those frames are ours and must not flash the pill.
   *
   * Cleared by ARRIVAL or by the reader taking over — never by a timer. A timer
   * is wrong in both directions: too short and a long scroll re-shows the pill
   * it just dismissed (measured on mobile: an 8k-pixel hop outlived a 600ms
   * window), too long and a reader who grabs the scrollbar mid-flight gets no
   * pill while they are reading history.
   */
  const jumpingRef = useRef(false);
  /** Last observed scroll offset — the sign of the delta tells us who scrolled. */
  const lastTopRef = useRef(0);

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

    if (near) {
      nearBottomRef.current = true;
      seenCountRef.current = messages.length;
      setNewCount(0);
    } else {
      nearBottomRef.current = false;
    }

    if (jumpingRef.current) {
      // Arrived, or the reader pulled the viewport back up mid-flight (a
      // decreasing offset is never ours — a scroll to the bottom only descends).
      if (near || top < lastTopRef.current) jumpingRef.current = false;
      else {
        lastTopRef.current = top;
        return;
      }
    }

    lastTopRef.current = top;
    setShowJump(!near);
  }, [isNearBottom, scrollRef, messages.length]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    jumpingRef.current = true;
    lastTopRef.current = el.scrollTop;
    nearBottomRef.current = true;
    seenCountRef.current = messages.length;
    setShowJump(false);
    setNewCount(0);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollRef, messages.length]);

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
    seenCountRef.current = messages.length;
  }, [messages, streaming, scrollRef]);

  return { showJump, newCount, jumpToLatest, isNearBottom, onScroll };
}

/** The pill's label — the count when there is one, otherwise a plain prompt. */
export function jumpLabel(newCount: number): string {
  if (newCount <= 0) return "Jump to latest";
  return newCount === 1 ? "1 new message" : `${newCount} new messages`;
}

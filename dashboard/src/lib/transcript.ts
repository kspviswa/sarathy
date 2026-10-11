/**
 * The single outbound-frame reducer shared by the desktop and mobile SPAs.
 *
 * Both surfaces must fold the gateway's WebSocket frames into the transcript
 * identically — that is the whole point of this module. The logic used to be
 * duplicated inline in `App.tsx` and `mobile/App.tsx`, which is exactly how the
 * two drift apart.
 *
 * Root cause this fixes (parity with Telegram on slash commands): the acks for
 * `/stop`, `/steer` and `/btw` are published out-of-band (not as part of the
 * turn) and previously landed in the fallback path, where they were merged into
 * — and then overwritten by — the in-flight assistant bubble's next `_progress`
 * frame. On Telegram each ack is its own message, so it is always visible.
 * Frames carrying `metadata._notice` are now appended as their own, sealed
 * bubble that streaming frames never touch.
 */
import type { OutboundMessage } from "@/lib/types";
import type { ChatMessage } from "@/views/ChatView";

/** True when a streaming frame may be folded into `last`. */
function isMergeable(last: ChatMessage | undefined): last is ChatMessage {
  return (
    last?.role === "assistant" &&
    // A notice is a completed, standalone message: streaming frames start a
    // fresh bubble rather than overwriting it.
    !last.notice
  );
}

/** Replace `last` (already known to exist) with an updated copy. */
function replaceLast(prev: ChatMessage[], patch: Partial<ChatMessage>): ChatMessage[] {
  return [...prev.slice(0, -1), { ...prev[prev.length - 1], ...patch }];
}

/** Replace the bubble at `idx` with an updated copy. */
function replaceAt(prev: ChatMessage[], idx: number, patch: Partial<ChatMessage>): ChatMessage[] {
  return prev.map((m, i) => (i === idx ? { ...m, ...patch } : m));
}

/** Index of the last assistant bubble tagged with `turnId`, or -1. */
function findTurnIndex(prev: ChatMessage[], turnId: string): number {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (prev[i].turnId === turnId && prev[i].role === "assistant" && !prev[i].notice) {
      return i;
    }
  }
  return -1;
}

/**
 * Fold one outbound frame into the transcript. Pure — returns a new array.
 *
 * Mirrors the pre-existing per-frame behaviour exactly, with one addition: a
 * notice frame appends a sealed bubble, and the merge branches skip notices.
 */
export function applyOutbound(prev: ChatMessage[], m: OutboundMessage): ChatMessage[] {
  const md = (m.metadata || {}) as Record<string, unknown>;

  // ---- out-of-band command notice: its own bubble, never merged ------------
  if (md._notice) {
    return [
      ...prev,
      {
        role: "assistant",
        content: m.content,
        notice: true,
        media: m.media?.length ? m.media : undefined,
        replyTo: m.replyTo ?? null,
      },
    ];
  }

  // The server mints a turn_id and stamps it on every frame of a turn. When it
  // is present we key bubbles by it (spec 127 §C.4): all frames of one turn fold
  // into the SAME bubble no matter how many reconnects happened in between, and
  // a turn never merges into a neighbouring turn's bubble.
  const turnId = typeof md.turn_id === "string" ? md.turn_id : undefined;
  const matchIdx = turnId ? findTurnIndex(prev, turnId) : -1;

  const last = prev[prev.length - 1];
  const mergeable = isMergeable(last);

  // ---- attachment folds into its turn's bubble ----------------------------
  // A media outbound (assistant voice reply) is a plain frame: attach it to the
  // already-streaming bubble for the same turn, or start one if this is the
  // turn's first frame.
  if (m.media?.length && !md._final && !md._progress && !md._thinking && !md._tool_hint) {
    if (matchIdx >= 0) {
      return replaceAt(prev, matchIdx, { media: m.media, progress: false });
    }
    return [
      ...prev,
      { role: "assistant", content: m.content, media: m.media, replyTo: m.replyTo, turnId },
    ];
  }

  // ---- final reply of a turn ----------------------------------------------
  if (md._final) {
    if (matchIdx >= 0) {
      const target = prev[matchIdx];
      return replaceAt(prev, matchIdx, {
        content: m.content,
        progress: false,
        media: m.media?.length ? m.media : target.media,
        replyTo: m.replyTo ?? target.replyTo,
      });
    }
    if (!turnId && mergeable && last.progress) {
      return replaceLast(prev, {
        content: m.content,
        progress: false,
        media: m.media?.length ? m.media : last.media,
        replyTo: m.replyTo ?? last.replyTo,
      });
    }
    if (!turnId && mergeable && !last.progress) {
      return replaceLast(prev, {
        content: last.content + m.content,
        progress: false,
        media: m.media?.length ? m.media : last.media,
        replyTo: m.replyTo ?? last.replyTo,
      });
    }
    return [
      ...prev,
      { role: "assistant", content: m.content, media: m.media, replyTo: m.replyTo, turnId },
    ];
  }

  // ---- streamed progress replaces the live bubble's text ------------------
  if (md._progress) {
    if (matchIdx >= 0) return replaceAt(prev, matchIdx, { content: m.content, progress: true });
    if (!turnId && mergeable) return replaceLast(prev, { content: m.content, progress: true });
    return [...prev, { role: "assistant", content: m.content, progress: true, turnId }];
  }

  // ---- reasoning / tool-hint fold into the live bubble --------------------
  if (md._thinking) {
    if (matchIdx >= 0) return replaceAt(prev, matchIdx, { thinkingContent: m.content });
    if (!turnId && mergeable) {
      return replaceLast(prev, { thinkingContent: m.content });
    }
    return [
      ...prev,
      { role: "assistant", content: "", thinkingContent: m.content, turnId },
    ];
  }

  if (md._tool_hint) {
    const hint = String(md._tool_hint);
    if (matchIdx >= 0) {
      return replaceAt(prev, matchIdx, {
        toolHint: hint,
        toolHints: [...(prev[matchIdx].toolHints || []), hint],
      });
    }
    if (!turnId && mergeable) {
      return replaceLast(prev, {
        toolHint: hint,
        toolHints: [...(last.toolHints || []), hint],
      });
    }
    return [
      ...prev,
      { role: "assistant", content: "", toolHint: hint, toolHints: [hint], turnId },
    ];
  }

  // ---- plain message with no streaming flags ------------------------------
  if (matchIdx >= 0) {
    const target = prev[matchIdx];
    return replaceAt(prev, matchIdx, {
      content: target.content + m.content,
      media: m.media?.length ? m.media : target.media,
      replyTo: m.replyTo ?? target.replyTo,
    });
  }
  if (!turnId && mergeable && !last.progress) {
    return replaceLast(prev, {
      content: last.content + m.content,
      media: m.media?.length ? m.media : last.media,
      replyTo: m.replyTo ?? last.replyTo,
    });
  }
  return [
    ...prev,
    { role: "assistant", content: m.content, media: m.media, replyTo: m.replyTo, turnId },
  ];
}

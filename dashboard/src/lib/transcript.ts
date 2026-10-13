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
 *
 * It also owns the read side: `deriveLiveTurnStatus` turns the newest bubble's
 * `toolHints` into the one label both SPAs show while a turn is live (spec
 * 134 §B), so the image→VLM pipeline is narrated in the open instead of only
 * inside the collapsed Thinking section.
 */
import { cleanRenderedContent } from "@/lib/messageText";
import type { OutboundMessage, SessionMessage } from "@/lib/types";
import type { ChatMessage } from "@/views/ChatView";

/** True when a streaming frame may be folded into `last`. */
function isMergeable(last: ChatMessage | undefined): last is ChatMessage {
  return (
    last?.role === "assistant" &&
    // A notice is a completed, standalone message: streaming frames start a
    // fresh bubble rather than overwriting it.
    !last.notice &&
    // A sealed bubble is genuine prose the turn has already committed to
    // (spec 131 §C). Streaming frames must never merge into it either.
    !last.sealed
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

/**
 * Index of the turn's live content bubble, or -1.
 *
 * A sealed bubble is skipped on purpose: it is already committed prose, so the
 * next frame of the same turn opens a fresh bubble beside it instead of
 * overwriting it (spec 131 §D).
 */
function findTurnIndex(prev: ChatMessage[], turnId: string): number {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (
      prev[i].turnId === turnId &&
      prev[i].role === "assistant" &&
      !prev[i].notice &&
      !prev[i].sealed
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Index of the turn's last bubble of any kind (sealed included), or -1.
 *
 * Reasoning and tool hints fold into this. They must never mint a bubble of
 * their own: a late `_thinking` after a sealed reply would otherwise be the
 * third bubble of a two-bubble turn.
 */
function findHostIndex(prev: ChatMessage[], turnId: string): number {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (prev[i].turnId === turnId && prev[i].role === "assistant" && !prev[i].notice) {
      return i;
    }
  }
  return -1;
}

/**
 * Stable per-bubble key. One turn can own several bubbles (a sealed reply plus
 * the follow-up final), so `turnId` alone is not a unique React key — the
 * sub-index makes it one.
 */
function nextBubbleId(prev: ChatMessage[], turnId: string | undefined): string {
  const base = turnId ?? "";
  let n = 0;
  for (const m of prev) if ((m.turnId ?? "") === base) n += 1;
  return `${base}#${n}`;
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
  const hostIdx = turnId ? findHostIndex(prev, turnId) : -1;

  const last = prev[prev.length - 1];
  const mergeable = isMergeable(last);

  // ---- sealed prose (spec 131 §C) -------------------------------------------
  // The loop publishes this when a tool-call iteration carried genuine reply
  // text ("Noted — I'll remember that." + memory write). The prose already
  // streamed into the turn's live bubble, so sealing it IN PLACE is what keeps
  // the answer on screen when the turn's `_final` follows; with nothing live
  // (non-streaming turn) it appends its own sealed bubble.
  if (md._seal) {
    if (matchIdx >= 0) {
      return replaceAt(prev, matchIdx, { content: m.content, progress: false, sealed: true });
    }
    return [
      ...prev,
      {
        role: "assistant",
        content: m.content,
        progress: false,
        sealed: true,
        media: m.media?.length ? m.media : undefined,
        replyTo: m.replyTo ?? null,
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
    ];
  }

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
      {
        role: "assistant",
        content: m.content,
        media: m.media,
        replyTo: m.replyTo,
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
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
    // Sealed prose already exists for this turn, so the final answer is a
    // SECOND bubble — exactly two for "answer + memory write", never one per
    // tool call (spec 131 §C).
    return [
      ...prev,
      {
        role: "assistant",
        content: m.content,
        media: m.media,
        replyTo: m.replyTo,
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
    ];
  }

  // ---- reasoning / tool-hint fold into the turn's bubble -------------------
  // Both are checked BEFORE `_progress`: the loop stamps every hint frame with
  // `_progress` too, so testing `_progress` first used to swallow a tool hint
  // into the message text and mint a bubble for it.
  //
  // Neither is EVER a message: they only fill the thinking collapse, and they
  // attach to whatever bubble the turn already has (sealed included) instead of
  // minting one of their own — a late monologue must not inflate a two-bubble
  // turn into three.
  if (md._thinking) {
    const host = hostIdx >= 0 ? hostIdx : turnId ? -1 : mergeable ? prev.length - 1 : -1;
    if (host >= 0) return replaceAt(prev, host, { thinkingContent: m.content });
    return [
      ...prev,
      {
        role: "assistant",
        content: "",
        thinkingContent: m.content,
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
    ];
  }

  if (md._tool_hint) {
    // The loop sends `_tool_hint: true` with the hint TEXT in `content`
    // (`_tool_hint` as a string is tolerated for older senders).
    const hint = typeof md._tool_hint === "string" ? md._tool_hint : m.content;
    const host = hostIdx >= 0 ? hostIdx : turnId ? -1 : mergeable ? prev.length - 1 : -1;
    const patch = { toolHint: hint };
    if (host >= 0) {
      return replaceAt(prev, host, {
        ...patch,
        toolHints: [...(prev[host].toolHints || []), hint],
      });
    }
    return [
      ...prev,
      {
        role: "assistant",
        content: "",
        toolHint: hint,
        toolHints: [hint],
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
    ];
  }

  // ---- streamed progress replaces the live bubble's text ------------------
  if (md._progress) {
    if (matchIdx >= 0) return replaceAt(prev, matchIdx, { content: m.content, progress: true });
    if (!turnId && mergeable) return replaceLast(prev, { content: m.content, progress: true });
    // The turn already committed a sealed reply: this frame opens a fresh
    // bubble next to it rather than rewriting it.
    return [
      ...prev,
      {
        role: "assistant",
        content: m.content,
        progress: true,
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
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
    {
      role: "assistant",
      content: m.content,
      media: m.media,
      replyTo: m.replyTo,
      turnId,
      bubbleId: nextBubbleId(prev, turnId),
    },
  ];
}

/**
 * Conversation only, and nothing empty (job 132 §C).
 *
 * `/api/session/archive` already drops tool results and empty assistant
 * records server-side; re-checking here means an older gateway — or a stale
 * service-worker cache serving a pre-fix response — still cannot put a tool row
 * or an empty bubble in the transcript. Media-only turns survive: they carry an
 * attachment with no text.
 */
export function visibleTranscriptMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.filter((m) => {
    if (m.role !== "user" && m.role !== "assistant") return false;
    return Boolean(cleanRenderedContent(m.content).trim()) || Boolean(m.media?.length);
  });
}

/** Shown while a turn is live but has told us nothing about what it is doing. */
export const LIVE_FALLBACK_LABEL = "Sarathy is responding…";

export interface LiveTurnStatus {
  /** What the live strip reads out: the newest pipeline phase, or the fallback. */
  label: string;
  /**
   * The working chip belongs to the strip only while the transcript has no
   * assistant bubble of its own — that bubble renders its own chip, and two
   * "working" chips on screen at once is noise.
   */
  showChip: boolean;
}

/**
 * What the live "working" strip should say for the turn in flight (spec 134 §B).
 *
 * The image→VLM pipeline narrates itself through ordinary `_tool_hint` frames —
 * "🖼️ Preparing image…", "🔍 Sending image to VLM…", "✅ Image description
 * received" — which `applyOutbound` folds into the turn's bubble `toolHints`.
 * They used to be visible ONLY inside the collapsed Thinking section, i.e. never
 * while the turn is running. Telegram shows the same strings in its streaming
 * draft; this is the dashboard half of that parity.
 *
 * Derived ONCE, here, and consumed by both SPAs — desktop and mobile must not
 * be able to disagree about what the turn is doing (spec 127/131/134 rule:
 * shared frame behaviour lives in this module, never duplicated inline).
 *
 * Returns `null` when the strip has nothing to add, i.e. the live bubble already
 * shows the working chip and any hint it carries is history:
 * - no messages, or the turn has not opened an assistant bubble yet → the
 *   caller's pre-existing fallback strip renders instead (last message is the
 *   user's), which is why that case still returns a status rather than null;
 * - the live bubble already has real prose → the answer is streaming in, so a
 *   stale phase name ("Sending image to VLM…") would be a lie.
 */
export function deriveLiveTurnStatus(messages: ChatMessage[]): LiveTurnStatus | null {
  const last = messages[messages.length - 1];
  if (!last) return null;

  // Turn is running, nothing has come back yet: today's strip, unchanged.
  if (last.role === "user") {
    return { label: LIVE_FALLBACK_LABEL, showChip: true };
  }

  // Walk back over out-of-band notice bubbles (a `/steer` ack lands mid-turn)
  // and the user turn to find the bubble this turn is currently writing.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const bubble = messages[i];
    if (bubble.role === "user") break;
    if (bubble.notice) continue;

    const hint = (bubble.toolHints ?? []).filter(Boolean).pop();
    if (!hint) return null;
    if (cleanRenderedContent(bubble.content).trim()) return null;
    return { label: hint, showChip: false };
  }
  return null;
}

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
 *
 * Spec 135 §A changed the shape of a turn: a turn is ONE assistant bubble
 * holding an ordered `segments[]`. Every frame of a turn folds into that one
 * bubble — `_seal` COMMITS the streaming segment instead of closing the bubble,
 * and the turn's `_final` is the last segment, never a second bubble. Before
 * this, a turn with three tool calls rendered as three bubbles, which is what
 * Viswa called out ("I don't want a second bubble").
 */
import { cleanRenderedContent } from "@/lib/messageText";
import type { OutboundMessage, SessionMessage } from "@/lib/types";
import type { ChatMessage } from "@/views/ChatView";

/**
 * One piece of assistant prose inside a turn's single bubble (spec 135 §A).
 *
 * `sealed` means the loop committed this segment — `_seal` (prose shipped with
 * a tool call) or `_final` (the turn's answer). The one trailing `false` is the
 * streaming segment, and it is where the caret rides.
 */
export interface TurnSegment {
  text: string;
  sealed: boolean;
}

/** True when a streaming frame may be folded into `last`. */
function isMergeable(last: ChatMessage | undefined): last is ChatMessage {
  return (
    last?.role === "assistant" &&
    // A notice is a completed, standalone message: streaming frames start a
    // fresh bubble rather than overwriting it.
    !last.notice &&
    // Legacy frames carry no turn_id, so the sealed flag is all that keeps a
    // committed reply from being overwritten by a turn-less frame (spec 131 §C).
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
 * Index of the turn's ONE bubble, or -1.
 *
 * Spec 135 §A: a turn owns exactly one assistant bubble, so prose, reasoning
 * and tool hints all resolve to the same index. `sealed` is deliberately NOT
 * part of the match — it marks that the turn committed a segment, not that the
 * bubble is closed. (Before this, `_seal` closed the bubble and the next frame
 * minted a new one, so a turn with three tool calls fragmented into three
 * bubbles.)
 */
function findTurnBubbleIndex(prev: ChatMessage[], turnId: string): number {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (prev[i].turnId === turnId && prev[i].role === "assistant" && !prev[i].notice) {
      return i;
    }
  }
  return -1;
}

/**
 * Stable per-bubble key. `turnId` alone is not guaranteed unique across turns
 * that arrive without one (legacy frames), so the sub-index makes it one.
 */
function nextBubbleId(prev: ChatMessage[], turnId: string | undefined): string {
  const base = turnId ?? "";
  let n = 0;
  for (const m of prev) if ((m.turnId ?? "") === base) n += 1;
  return `${base}#${n}`;
}

// ---------------------------------------------------------------------------
// Segments — one turn, one bubble, several prose segments (spec 135 §A)
// ---------------------------------------------------------------------------

/** Segments are paragraphed: the trail divider needs something to sit between. */
const SEGMENT_JOIN = "\n\n";

/**
 * The bubble's segments, tolerating transcripts that predate them.
 *
 * A message loaded from the session archive (or replayed by an older gateway)
 * carries only `content`, which is one finished segment.
 */
function bubbleSegments(m: ChatMessage): TurnSegment[] {
  if (m.segments) return m.segments;
  const text = m.content ?? "";
  return text ? [{ text, sealed: true }] : [];
}

/**
 * `content` stays the mirror of the prose so every existing consumer keeps
 * working (copy action, media extraction, `deriveLiveTurnStatus`, the session
 * viewer). `segments` is the ordered truth the bubble renders.
 */
function segmentsPatch(segments: TurnSegment[]): Pick<ChatMessage, "segments" | "content"> {
  const kept = segments.filter((s) => s.text.length > 0);
  return { segments: kept, content: kept.map((s) => s.text).join(SEGMENT_JOIN) };
}

/** Index of the segment still being written, or -1 when all are committed. */
function openSegmentIndex(segments: TurnSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i -= 1) if (!segments[i].sealed) return i;
  return -1;
}

/**
 * Streamed prose: rewrite the open segment in place (`_progress` frames carry
 * the whole draft of the current iteration, not a delta). Once the segment is
 * sealed the next iteration opens a NEW segment of the SAME bubble.
 */
function withStreamedProse(target: ChatMessage, text: string): Pick<ChatMessage, "segments" | "content"> {
  const segments = [...bubbleSegments(target)];
  const open = openSegmentIndex(segments);
  if (open >= 0) segments[open] = { text, sealed: false };
  else segments.push({ text, sealed: false });
  return segmentsPatch(segments);
}

/**
 * Committed prose (`_seal` / `_final`): seal the open segment, or open-and-seal
 * a new one when every earlier segment is already committed. Either way the
 * turn stays in ONE bubble.
 */
function withCommittedProse(target: ChatMessage, text: string): Pick<ChatMessage, "segments" | "content"> {
  const segments = [...bubbleSegments(target)];
  const open = openSegmentIndex(segments);
  if (open >= 0) segments[open] = { text: text || segments[open].text, sealed: true };
  else segments.push({ text, sealed: true });
  return segmentsPatch(segments);
}

/** A plain follow-up frame extends the trailing segment's text. */
function withAppendedProse(target: ChatMessage, text: string): Pick<ChatMessage, "segments" | "content"> {
  const segments = [...bubbleSegments(target)];
  const last = segments.length - 1;
  if (last < 0) return segmentsPatch([{ text, sealed: false }]);
  segments[last] = { ...segments[last], text: segments[last].text + text };
  return segmentsPatch(segments);
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
  const turnIdx = turnId ? findTurnBubbleIndex(prev, turnId) : -1;

  const last = prev[prev.length - 1];
  const mergeable = isMergeable(last);

  // ---- sealed prose (spec 131 §C, spec 135 §A) ------------------------------
  // The loop publishes this when a tool-call iteration carried genuine reply
  // text ("Noted — I'll remember that." + memory write). It COMMITS the segment
  // that was streaming into the turn's bubble; it never mints a second one.
  // The next iteration's prose opens a new segment beside it, and the trail
  // divider between them is what shows the turn's shape.
  if (md._seal) {
    if (turnIdx >= 0) {
      const target = prev[turnIdx];
      return replaceAt(prev, turnIdx, {
        ...withCommittedProse(target, m.content),
        media: m.media?.length ? m.media : target.media,
        progress: false,
        sealed: true,
      });
    }
    return [
      ...prev,
      {
        role: "assistant",
        ...segmentsPatch([{ text: m.content, sealed: true }]),
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
  // turn's bubble, or start one if this is the turn's first frame.
  if (m.media?.length && !md._final && !md._progress && !md._thinking && !md._tool_hint) {
    if (turnIdx >= 0) {
      return replaceAt(prev, turnIdx, { media: m.media, progress: false });
    }
    return [
      ...prev,
      {
        role: "assistant",
        ...segmentsPatch([{ text: m.content, sealed: false }]),
        media: m.media,
        replyTo: m.replyTo,
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
    ];
  }

  // ---- final reply of a turn ----------------------------------------------
  // The final answer is the LAST SEGMENT of the turn's bubble, never a bubble
  // of its own (spec 135 §A): "Noted — I'll remember that." + "Anything else?"
  // is one assistant response with a divider through it.
  if (md._final) {
    if (turnIdx >= 0) {
      const target = prev[turnIdx];
      return replaceAt(prev, turnIdx, {
        ...withCommittedProse(target, m.content),
        progress: false,
        media: m.media?.length ? m.media : target.media,
        replyTo: m.replyTo ?? target.replyTo,
      });
    }
    if (!turnId && mergeable && last.progress) {
      return replaceLast(prev, {
        ...withStreamedProse(last, m.content),
        progress: false,
        media: m.media?.length ? m.media : last.media,
        replyTo: m.replyTo ?? last.replyTo,
      });
    }
    if (!turnId && mergeable && !last.progress) {
      return replaceLast(prev, {
        ...withCommittedProse(last, m.content),
        progress: false,
        media: m.media?.length ? m.media : last.media,
        replyTo: m.replyTo ?? last.replyTo,
      });
    }
    return [
      ...prev,
      {
        role: "assistant",
        ...segmentsPatch([{ text: m.content, sealed: true }]),
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
  // Neither is EVER a message: they only fill the one collapse header, and they
  // attach to the turn's bubble (which may not exist yet — then they open it
  // with zero segments, so the header renders in its slim empty state).
  if (md._thinking) {
    const host = turnIdx >= 0 ? turnIdx : !turnId && mergeable ? prev.length - 1 : -1;
    if (host >= 0) return replaceAt(prev, host, { thinkingContent: m.content });
    return [
      ...prev,
      {
        role: "assistant",
        ...segmentsPatch([]),
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
    const host = turnIdx >= 0 ? turnIdx : !turnId && mergeable ? prev.length - 1 : -1;
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
        ...segmentsPatch([]),
        toolHint: hint,
        toolHints: [hint],
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
    ];
  }

  // ---- streamed progress rewrites the open segment ------------------------
  if (md._progress) {
    if (turnIdx >= 0) {
      return replaceAt(prev, turnIdx, {
        ...withStreamedProse(prev[turnIdx], m.content),
        progress: true,
      });
    }
    if (!turnId && mergeable) return replaceLast(prev, { ...withStreamedProse(last, m.content), progress: true });
    return [
      ...prev,
      {
        role: "assistant",
        ...segmentsPatch([{ text: m.content, sealed: false }]),
        progress: true,
        turnId,
        bubbleId: nextBubbleId(prev, turnId),
      },
    ];
  }

  // ---- plain message with no streaming flags ------------------------------
  if (turnIdx >= 0) {
    const target = prev[turnIdx];
    return replaceAt(prev, turnIdx, {
      ...withAppendedProse(target, m.content),
      media: m.media?.length ? m.media : target.media,
      replyTo: m.replyTo ?? target.replyTo,
    });
  }
  if (!turnId && mergeable && !last.progress) {
    return replaceLast(prev, {
      ...withAppendedProse(last, m.content),
      media: m.media?.length ? m.media : last.media,
      replyTo: m.replyTo ?? last.replyTo,
    });
  }
  return [
    ...prev,
    {
      role: "assistant",
      ...segmentsPatch([{ text: m.content, sealed: false }]),
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

/**
 * The turn's ordered prose (spec 135 §A).
 *
 * A turn is ONE bubble holding N segments, so this is the only thing a bubble
 * needs to render its body: the divider between entries IS the turn's trail.
 * The streaming caret rides the trailing unsealed segment.
 *
 * Read side, shared by both SPAs for the same reason the write side is: a
 * desktop/mobile disagreement about where a turn's prose ends would show up as
 * one of them dropping or duplicating an answer.
 */
export function turnSegments(m: ChatMessage): TurnSegment[] {
  return bubbleSegments(m).filter((s) => s.text.trim().length > 0);
}

/**
 * Steps shown in the collapse header. A tool call is a step; the reasoning pass
 * that produced it is not (reasoning is what the steps are FOR).
 */
export function turnStepCount(m: ChatMessage): number {
  return (m.toolHints ?? []).filter((h) => h && h.trim().length > 0).length;
}

/** `2m 14s` / `14s` — the duration half of the header's step count. */
export function formatTurnDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** One tool call, split out of a `_tool_hint` frame for the header's chips. */
export interface ToolChip {
  /** `read_file` — empty for a narrated phase that is not a tool call. */
  name: string;
  /** `dashboard/src/App.tsx` — one line, never the raw argument blob. */
  summary: string;
  /** The hint as published, for the chip's tooltip. */
  hint: string;
}

const TOOL_CALL_RE = /([A-Za-z_][\w.-]*)\s*\(([^()]*)\)/g;

/**
 * Split a `_tool_hint` frame into one chip per tool call (spec 135 §A).
 *
 * The loop publishes `'read_file("a.py"), memory_log("tea")'` — one string for
 * the whole batch (`AgentLoop._tool_hint`). Rendering that raw is what made the
 * collapse read as a wall of mono text; as chips it reads as a list of steps.
 *
 * A hint that matches no call shape (a narrated phase such as "🖼️ Preparing
 * image…", or a format added later) degrades to one unnamed chip holding the
 * whole string — never dropped, never rendered as broken markup.
 */
export function summarizeToolHint(hint: string): ToolChip[] {
  const trimmed = (hint ?? "").trim();
  if (!trimmed) return [];
  const chips: ToolChip[] = [];
  for (const match of trimmed.matchAll(TOOL_CALL_RE)) {
    const summary = match[2].trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
    chips.push({
      name: match[1],
      summary: summary.length > 48 ? `${summary.slice(0, 48)}…` : summary,
      hint: trimmed,
    });
  }
  if (chips.length) return chips;
  return [
    {
      name: "",
      summary: trimmed.length > 64 ? `${trimmed.slice(0, 64)}…` : trimmed,
      hint: trimmed,
    },
  ];
}

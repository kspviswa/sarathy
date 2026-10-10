/**
 * Per-message reaction state machine.
 *
 * The WebSocket contract streams `_progress` / `_thinking` / `_tool_hint` /
 * `_final` frames. This module folds those frames into a single visual state so
 * the UI never has to guess what the agent is doing, and so "the user must
 * always see live state for their last message" is a testable invariant rather
 * than a hope.
 *
 * The WS frame names are treated as read-only — this module consumes them and
 * never renames or redefines them.
 */

/**
 * Icon names used by the chrome. These are `lucide-react` icon names, resolved
 * to components by the consumers (`ReactionChip` / `PresenceIndicator`) — this
 * module stays free of JSX so both the desktop and mobile trees can share it.
 *
 * Emoji glyphs used to live here (hourglass / brain / wrench / check / cross);
 * they rendered differently on every platform and broke the "chrome looks like
 * one product" goal (spec §D).
 */
export type ReactionIcon =
  | "loader-circle"
  | "brain"
  | "wrench"
  | "circle-check"
  | "circle-x";

/** Visual states a message can be in. */
export type ReactionState =
  | "queued"
  | "working"
  | "thinking"
  | "tool"
  | "done"
  | "failed";

export interface ReactionView {
  state: ReactionState;
  /** lucide-react icon name rendered in the reaction chip. */
  icon: ReactionIcon;
  /** Short human label, e.g. "thinking". */
  label: string;
  /** True while the turn is still in flight (drives the pulsing dot). */
  live: boolean;
}

const REACTIONS: Record<ReactionState, ReactionView> = {
  queued: { state: "queued", icon: "loader-circle", label: "queued", live: true },
  working: { state: "working", icon: "loader-circle", label: "working", live: true },
  thinking: { state: "thinking", icon: "brain", label: "thinking", live: true },
  tool: { state: "tool", icon: "wrench", label: "using tools", live: true },
  done: { state: "done", icon: "circle-check", label: "done", live: false },
  failed: { state: "failed", icon: "circle-x", label: "failed", live: false },
};

export function reactionFor(state: ReactionState): ReactionView {
  return REACTIONS[state];
}

/**
 * Fold one streaming frame into the current reaction state.
 *
 * Frame → state mapping (per spec):
 *   _progress  → working
 *   _thinking  → thinking
 *   _tool_hint → tool
 *   _final     → done (or failed, when `isError`)
 *
 * `queued` is the optimistic state set the instant the user hits send, before
 * any frame arrives, so there is never a window with no indicator at all.
 *
 * Precedence is "last significant frame wins" except that `failed` is sticky:
 * once a turn has failed, later content frames must not resurrect it to
 * `working`, or a retry race would flicker the error away.
 */
export function nextReaction(
  current: ReactionState,
  frame: { kind: "progress" | "thinking" | "tool_hint" | "final"; isError?: boolean },
): ReactionState {
  if (current === "failed") return "failed";
  switch (frame.kind) {
    case "progress":
      return "working";
    case "thinking":
      return "thinking";
    case "tool_hint":
      return "tool";
    case "final":
      return frame.isError ? "failed" : "done";
  }
}

/**
 * Derive the frame kind from a raw WS metadata object.
 *
 * Returns null for frames that carry no reaction signal (e.g. a plain
 * notification), so callers can ignore them without guessing.
 *
 * Order matters: `_final` is checked first because a final frame may also carry
 * content, and reporting it as "working" would strand the UI in a live state.
 */
export function reactionFrameFrom(
  metadata: Record<string, unknown> | null | undefined,
): { kind: "progress" | "thinking" | "tool_hint" | "final"; isError?: boolean } | null {
  if (!metadata) return null;
  if (metadata._final) {
    const isError = Boolean(metadata._error);
    return { kind: "final", isError };
  }
  if (metadata._progress) return { kind: "progress" };
  if (metadata._thinking) return { kind: "thinking" };
  if (metadata._tool_hint) return { kind: "tool_hint" };
  return null;
}

/** Reset to the optimistic pre-first-frame state when a new turn is sent. */
export function startTurn(): ReactionState {
  return "queued";
}
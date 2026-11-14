/**
 * App-level chat font scale (spec 175 §F).
 *
 * Scales the transcript and composer only — not browser zoom and not the
 * chrome. Persisted so both shells share one preference.
 */

import type { CSSProperties } from "react";

export const CHAT_FONT_SCALE_KEY = "sarathy_chat_font_scale";

/** Allowed steps, in ascending order. */
export const CHAT_FONT_SCALE_STEPS = [0.9, 1.0, 1.125, 1.25, 1.4] as const;

export type ChatFontScale = (typeof CHAT_FONT_SCALE_STEPS)[number];

export const CHAT_FONT_SCALE_DEFAULT: ChatFontScale = 1.0;

const STEP_SET = new Set<number>(CHAT_FONT_SCALE_STEPS);

export function isChatFontScale(value: unknown): value is ChatFontScale {
  return typeof value === "number" && STEP_SET.has(value);
}

export function clampChatFontScale(value: number): ChatFontScale {
  if (isChatFontScale(value)) return value;
  // Snap to the nearest allowed step.
  let best: ChatFontScale = CHAT_FONT_SCALE_DEFAULT;
  let bestDist = Infinity;
  for (const step of CHAT_FONT_SCALE_STEPS) {
    const dist = Math.abs(step - value);
    if (dist < bestDist) {
      best = step;
      bestDist = dist;
    }
  }
  return best;
}

export function readChatFontScale(): ChatFontScale {
  try {
    const raw = localStorage.getItem(CHAT_FONT_SCALE_KEY);
    if (raw == null) return CHAT_FONT_SCALE_DEFAULT;
    return clampChatFontScale(Number(raw));
  } catch {
    return CHAT_FONT_SCALE_DEFAULT;
  }
}

export function writeChatFontScale(scale: ChatFontScale): void {
  try {
    localStorage.setItem(CHAT_FONT_SCALE_KEY, String(scale));
  } catch {
    // private mode / blocked storage — ignore
  }
}

export function nextChatFontScale(current: ChatFontScale, dir: 1 | -1): ChatFontScale {
  const idx = CHAT_FONT_SCALE_STEPS.indexOf(current);
  const next = Math.min(
    CHAT_FONT_SCALE_STEPS.length - 1,
    Math.max(0, idx + dir),
  );
  return CHAT_FONT_SCALE_STEPS[next];
}

/** Inline style that sets `--chat-font-scale` on a wrapper. */
export function chatFontScaleStyle(scale: ChatFontScale): CSSProperties {
  return { ["--chat-font-scale" as string]: String(scale) } as CSSProperties;
}

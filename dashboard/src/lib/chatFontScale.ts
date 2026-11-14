/**
 * Uncapped reading font scale for conversation bubbles (spec 176 §A).
 *
 * Scales user/assistant bubble text only — not app chrome, not the composer.
 * No step ladder and no maximum; A+ multiplies by FONT_SCALE_FACTOR forever.
 * The only guard is FONT_SCALE_FLOOR (~0.5) so A− cannot drive size to zero.
 */

import type { CSSProperties } from "react";

export const CHAT_FONT_SCALE_KEY = "sarathy_chat_font_scale";

/** Multiply/divide factor for each A+ / A− press. */
export const FONT_SCALE_FACTOR = 1.1;

/**
 * Floor applied when stepping down. Keeps the value positive and finite —
 * not a UX "minimum readable size", just a guard against zero/negative.
 */
export const FONT_SCALE_FLOOR = 0.5;

export const CHAT_FONT_SCALE_DEFAULT = 1.0;

/** @deprecated Kept as a number alias; the 175 step-union is gone. */
export type ChatFontScale = number;

/** True when `value` is a finite positive number (any magnitude). */
export function isValidFontScale(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Step the scale up (`dir = 1`) or down (`dir = -1`).
 * Up: no ceiling. Down: clamps to FONT_SCALE_FLOOR.
 */
export function nextChatFontScale(current: number, dir: 1 | -1): number {
  const base = isValidFontScale(current) ? current : CHAT_FONT_SCALE_DEFAULT;
  const raw = dir === 1 ? base * FONT_SCALE_FACTOR : base / FONT_SCALE_FACTOR;
  if (!Number.isFinite(raw) || raw <= 0) return FONT_SCALE_FLOOR;
  return dir === 1 ? raw : Math.max(FONT_SCALE_FLOOR, raw);
}

/**
 * Read the persisted scale. Returns the stored number unchanged when it is a
 * finite positive number — no snapping to a ladder, no maximum.
 */
export function readChatFontScale(): number {
  try {
    const raw = localStorage.getItem(CHAT_FONT_SCALE_KEY);
    if (raw == null) return CHAT_FONT_SCALE_DEFAULT;
    const n = Number(raw);
    if (!isValidFontScale(n)) return CHAT_FONT_SCALE_DEFAULT;
    return n;
  } catch {
    return CHAT_FONT_SCALE_DEFAULT;
  }
}

export function writeChatFontScale(scale: number): void {
  if (!isValidFontScale(scale)) return;
  try {
    localStorage.setItem(CHAT_FONT_SCALE_KEY, String(scale));
  } catch {
    // private mode / blocked storage — ignore
  }
}

/** Inline style that sets `--chat-font-scale` on a wrapper. */
export function chatFontScaleStyle(scale: number): CSSProperties {
  return { ["--chat-font-scale" as string]: String(scale) } as CSSProperties;
}

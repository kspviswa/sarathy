/**
 * Independent composer font scale (spec 176 §B).
 *
 * Affects only the composer textarea and its Markdown preview — not the
 * transcript, not the chrome. Same uncapped maths as the reading scale, own
 * localStorage key.
 */

import type { CSSProperties } from "react";

import {
  CHAT_FONT_SCALE_DEFAULT,
  FONT_SCALE_FACTOR,
  FONT_SCALE_FLOOR,
  isValidFontScale,
  nextChatFontScale,
} from "@/lib/chatFontScale";

export const COMPOSER_FONT_SCALE_KEY = "sarathy_composer_font_scale";

export const COMPOSER_FONT_SCALE_DEFAULT = CHAT_FONT_SCALE_DEFAULT;

export {
  FONT_SCALE_FACTOR,
  FONT_SCALE_FLOOR,
  isValidFontScale,
  nextChatFontScale as nextComposerFontScale,
};

export function readComposerFontScale(): number {
  try {
    const raw = localStorage.getItem(COMPOSER_FONT_SCALE_KEY);
    if (raw == null) return COMPOSER_FONT_SCALE_DEFAULT;
    const n = Number(raw);
    if (!isValidFontScale(n)) return COMPOSER_FONT_SCALE_DEFAULT;
    return n;
  } catch {
    return COMPOSER_FONT_SCALE_DEFAULT;
  }
}

export function writeComposerFontScale(scale: number): void {
  if (!isValidFontScale(scale)) return;
  try {
    localStorage.setItem(COMPOSER_FONT_SCALE_KEY, String(scale));
  } catch {
    // private mode / blocked storage — ignore
  }
}

/** Inline style that sets `--composer-font-scale` on a wrapper. */
export function composerFontScaleStyle(scale: number): CSSProperties {
  return {
    ["--composer-font-scale" as string]: String(scale),
  } as CSSProperties;
}

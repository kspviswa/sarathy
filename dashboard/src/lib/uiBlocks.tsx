/**
 * openUI adapter (LIGHT half) — chat-side plumbing that must NOT pull the
 * openUI runtime into the main bundle.
 *
 * The renderer + parser are heavy (d3, katex, radix, the whole widget catalog).
 * They live in `./openuiRenderer`, which is loaded on demand: {@link UIBlock} is
 * a `React.lazy` boundary, so a message with no UI block never downloads it.
 *
 * This module therefore imports NO `@openuidev/*` package. The modules allowed
 * to touch openUI directly are `./openuiRenderer` and `./openuiTheme` (enforced
 * by `src/__tests__/uiBlocks.test.tsx`).
 *
 * ## Behaviour contract
 *
 * A reply is rendered as a typed UI block ONLY when it actually contains a
 * fenced openUI block ({@link hasOpenUIBlock}). Everything else — including
 * every pure-text reply and any reply whose only fenced code is a normal
 * language block — renders as ordinary markdown, exactly as before openUI
 * existed. The UI path can never turn a text reply into a blank bubble: the
 * lazy renderer falls back to showing the raw block source if parsing fails.
 */
import { lazy, Suspense, type ComponentType } from "react";

/** Action types a rendered block can raise. Mirrors the library enum. */
export const CONTINUE_CONVERSATION = "continue_conversation";
export const OPEN_URL = "open_url";

export interface UIBlockAction {
  type: string;
  params: Record<string, unknown>;
  humanFriendlyMessage: string;
}

export interface UIBlockProps {
  source: string;
  isStreaming?: boolean;
  onSend?: (message: string) => void;
  onAction?: (event: UIBlockAction) => void;
}

/**
 * Allow only absolute http(s) URLs.
 *
 * Returns null for anything else (`javascript:`, `data:`, `vbscript:`,
 * relative or malformed). A `javascript:` href is a stored-XSS vector even
 * without raw-HTML rendering, so links are gated on this.
 */
export function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject control characters that can smuggle a scheme past URL parsing.
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/** Extract the fenced block(s), fences stripped. */
export function extractUIBlocks(text: string): string {
  const blocks: string[] = [];
  const re = /```[\w-]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (body) blocks.push(body);
  }
  return blocks.join("\n");
}

/** Prose with fenced regions removed — rendered alongside a UI block. */
export function extractProse(text: string): string[] {
  return text
    .split(/```[\w-]*\n?[\s\S]*?```/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Cheap, dependency-free check for "does this reply contain an openUI block?".
 *
 * True for a fence tagged `openui-lang`/`openui`, or any fence whose body
 * defines `root =`. This is the gate that decides whether to load the heavy
 * renderer at all, so it must stay allocation-light and never import openUI.
 */
export function hasOpenUIBlock(text: string | null | undefined): boolean {
  if (!text) return false;
  const re = /```([\w-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag === "openui-lang" || tag === "openui") return true;
    if (/^\s*root\s*=/m.test(m[2])) return true;
  }
  return false;
}

const LazyOpenUIBlock = lazy(
  () => import("./openuiRenderer") as Promise<{ default: ComponentType<UIBlockProps> }>,
);

/**
 * Render a UI block. The heavy renderer is fetched on first use; until it
 * arrives (or if the chunk fails to load) nothing extra is shown, which keeps
 * a text reply intact.
 */
export function UIBlock(props: UIBlockProps) {
  return (
    <Suspense fallback={null}>
      <LazyOpenUIBlock {...props} />
    </Suspense>
  );
}

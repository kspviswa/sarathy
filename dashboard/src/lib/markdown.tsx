import type { Content, Element, Root, Text } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";

import { EMOJI_KEYS, EmojiIcon, normalizeEmoji } from "@/lib/emojiIcons";

/**
 * Shared markdown pipeline for the dashboard (spec 126 §C).
 *
 * Job-monitor pings are Telegram-flavored HTML (`<b>`, `<a href>`). Rendering
 * them with a markdown-only pipeline escaped the tags, so Viswa saw a literal
 * "code chunk" — `<b>Job 126 [feature]</b> — completed` — instead of a bold
 * header with a working deep link.
 *
 * `rehype-raw` parses raw HTML into the tree and `rehype-sanitize` then strips
 * everything outside the allowlist below. Sanitizing is NOT optional here: the
 * content is LLM/relay output, and rendering it raw would be a script-injection
 * hole. The ordering (raw, then sanitize) is the safe one — sanitize runs last,
 * so nothing reaches the DOM that it did not clear.
 */

/** Only these URL schemes survive on any sanitized link/image. */
const SAFE_PROTOCOLS = ["http", "https"];

/**
 * `defaultSchema` already covers the tags markdown itself emits (p, ul, code,
 * pre, headings, tables…), so the allowlist starts from it — replacing it
 * outright would silently break tables, code fences and markdown images.
 *
 * On top of it we:
 *  - narrow every URL scheme to http/https, dropping `javascript:`, `data:`,
 *    `mailto:` and friends that the default schema would otherwise allow;
 *  - re-declare `a` so its `href` is scheme-checked and no event-handler or
 *    `target` attribute can survive;
 *  - keep the Telegram-shaped inline tags (`b`, `strong`, `i`, `em`, `br`) that
 *    `defaultSchema` already permits, which is exactly the subset jobctl emits.
 */
export const SAFE_HTML_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: ["href"],
    img: ["src", "alt"],
    "*": [], // no global attributes at all (kills on*=, style=, id=)
  },
  protocols: {
    href: SAFE_PROTOCOLS,
    src: SAFE_PROTOCOLS,
  },
  // Fully removed (content included), not merely untagged: these can execute,
  // exfiltrate, or pull remote content into the page.
  strip: [
    "script",
    "style",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
  ],
} as typeof defaultSchema;

/**
 * rehype plugins to hand to `<ReactMarkdown rehypePlugins={...} />`.
 *
 * Applied in order: parse raw HTML, then sanitize. Typed as a `PluggableList`
 * because the sanitize entry is a `[plugin, schema]` tuple, which TypeScript
 * will not narrow to `Pluggable[]` on its own.
 */
export const SAFE_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, SAFE_HTML_SCHEMA],
  rehypeEmojiIcons,
];

/**
 * Emoji → inline lucide icon (2026-10-11).
 *
 * The agent's replies are emoji-heavy and the raw OS glyphs render
 * inconsistently across platforms. Every emoji in `EMOJI_ICONS` is replaced with
 * a custom `<emoji name="…">` element that `EmojiIcon` renders as a lucide SVG.
 *
 * Runs AFTER `rehypeSanitize`: the elements it inserts are ours, not the
 * untrusted input's, so they must not be handed to the sanitizer (which would
 * strip the unknown tag). Nothing from the source survives this step — only the
 * matched emoji characters are swapped, and the map is a fixed allowlist.
 *
 * `code` and `pre` are skipped: an emoji inside a fenced block is content, and
 * swapping it would corrupt the snippet.
 */
const SKIP_EMOJI_TAGS = new Set(["code", "pre", "script", "style"]);

/** Escape a single character for use inside a RegExp. */
function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One alternation of every known emoji, each key's code points followed by an
 * optional U+FE0F so a single entry matches both `⚠` and `⚠️`. `u` keeps
 * astral-plane code points intact.
 */
const EMOJI_RE = new RegExp(
  EMOJI_KEYS.map((key) =>
    Array.from(key)
      .map((char) => `${escapeRegExp(char)}\\uFE0F?`)
      .join(""),
  ).join("|"),
  "gu",
);

/** Split a text node into text/`emoji` element nodes. */
function splitEmoji(node: Text): Content[] {
  const value = node.value;
  const out: Content[] = [];
  let last = 0;
  EMOJI_RE.lastIndex = 0;

  for (let match = EMOJI_RE.exec(value); match; match = EMOJI_RE.exec(value)) {
    if (match.index > last) {
      out.push({ type: "text", value: value.slice(last, match.index) });
    }
    out.push({
      type: "element",
      tagName: "emoji",
      properties: { name: normalizeEmoji(match[0]) },
      children: [{ type: "text", value: match[0] }],
    });
    last = match.index + match[0].length;
  }

  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

function walkEmoji(node: Root | Element, skip: boolean): void {
  const children = node.children as Content[] | undefined;
  if (!children?.length) return;

  const inSkip = skip || (node.type === "element" && SKIP_EMOJI_TAGS.has(node.tagName));
  const next: Content[] = [];

  for (const child of children) {
    if (child.type === "text" && !inSkip) {
      next.push(...splitEmoji(child));
      continue;
    }
    if (child.type === "element") walkEmoji(child, inSkip);
    next.push(child);
  }

  node.children = next as typeof node.children;
}

/** rehype plugin: replace known emoji with `<emoji name="…">` elements. */
export function rehypeEmojiIcons() {
  return (tree: Root): void => walkEmoji(tree, false);
}

/**
 * Renders an `<emoji>` element as a lucide icon.
 *
 * The implementation moved to `lib/emojiIcons.tsx` (its natural home, next to
 * the map) so non-markdown surfaces — the live-status strip — can reuse it.
 * Re-exported here because this module is where the markdown `components` map
 * references it.
 */
export { EmojiIcon };

/**
 * Shared `components` for every `<ReactMarkdown>` in the dashboard.
 *
 * Both SPAs and both transcript surfaces spread this so the link and emoji
 * renderers can never drift; a surface with extra needs (the chat bubbles'
 * fenced-code renderer) spreads it and adds its own key on top.
 */
export const MD_COMPONENTS = {
  a: SafeLink,
  emoji: EmojiIcon,
} as Components;

/**
 * Custom renderer for links inside markdown/HTML content.
 *
 * The sanitize schema strips `target` and `rel`, so they are re-applied here as
 * React props: a job ping's "Open in dashboard" deep link must not navigate the
 * PWA away from the app it lives in, and `noopener` keeps the opened tab from
 * reaching back through `window.opener`.
 *
 * `javascript:` and other schemes never reach this — the schema already dropped
 * them, so anything still carrying an `href` here is http(s).
 */
export function SafeLink({
  children,
  href,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
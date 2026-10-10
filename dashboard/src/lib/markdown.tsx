import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";

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
];

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
/**
 * Shared `@OpenPortal(slug)` action spec + portal allowlist (LIGHT, plain ESM).
 *
 * This is the single source of truth for the custom action's name, description
 * and the slug -> URL table. It is deliberately a dependency-free `.js` module
 * with NO `@openuidev/*` import so that BOTH sides can import it:
 *
 *  - the browser renderer (`openuiRenderer.tsx`) via Vite, and
 *  - the Node prompt generator (`dashboard/scripts/gen-openui-prompt.mjs`).
 *
 * Each side builds its own `DefinedAction` from {@link OPEN_PORTAL_SPEC} with
 * `defineAction(spec)`; the spec itself is never duplicated.
 */

/** The action's step name; the model writes `@OpenPortal("manana")`. */
export const OPEN_PORTAL = "open_portal";

/**
 * The action definition, minus the framework-specific `ref` that `defineAction`
 * mints. Import this and pass it to `defineAction()`.
 */
export const OPEN_PORTAL_SPEC = Object.freeze({
  name: OPEN_PORTAL,
  description:
    "Open one of Sarathy's portals in a new browser tab. Use it for a portal " +
    "shortcut button; it acts immediately with no model round-trip.",
  slugDescription:
    "Portal slug: manana, shravana, vatsalya, smriti, charitham, dashboard, or patra.",
});

/**
 * The hard allowlist. A slug is NEVER treated as a URL — only these keys, and
 * only these URLs, are ever opened. Case-sensitive, trimmed.
 */
export const PORTALS = Object.freeze({
  manana: "https://skandpriya.com/manana/",
  shravana: "https://skandpriya.com/shravana/",
  vatsalya: "https://skandpriya.com/vatsalya/",
  smriti: "https://skandpriya.com/smriti/",
  charitham: "https://skandpriya.com/charitham/",
  dashboard: "https://skandpriya.com/dashboard/",
  patra: "https://skandpriya.com/patra/",
});

/**
 * Resolve a slug to its portal URL, or `null` for anything unknown.
 *
 * The handler must NOT open a window when this returns `null`.
 */
export function resolvePortal(slug) {
  if (typeof slug !== "string") return null;
  const key = slug.trim();
  return Object.prototype.hasOwnProperty.call(PORTALS, key) ? PORTALS[key] : null;
}

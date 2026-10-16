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
 * The public origin every portal is served from.
 *
 * The port is NOT optional: the public edge (`skandpriya.com`) terminates TLS on
 * **8443** and does not answer on 443, so a bare-origin URL resolves but never
 * connects — the tab opens onto a connection error, which reads to the user as
 * "the portal didn't open". Confirmed 2026-10-15: `:8443/<slug>/` → 200,
 * `/<slug>/` → connection refused.
 *
 * Declared once so the port cannot drift between the seven entries below.
 */
export const PORTAL_BASE = "https://skandpriya.com:8443";

/**
 * The hard allowlist. A slug is NEVER treated as a URL — only these keys, and
 * only these URLs, are ever opened. Case-sensitive, trimmed.
 */
export const PORTALS = Object.freeze({
  manana: `${PORTAL_BASE}/manana/`,
  shravana: `${PORTAL_BASE}/shravana/`,
  vatsalya: `${PORTAL_BASE}/vatsalya/`,
  smriti: `${PORTAL_BASE}/smriti/`,
  charitham: `${PORTAL_BASE}/charitham/`,
  dashboard: `${PORTAL_BASE}/dashboard/`,
  patra: `${PORTAL_BASE}/patra/`,
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

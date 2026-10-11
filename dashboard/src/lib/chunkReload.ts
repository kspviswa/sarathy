/**
 * Self-heal for a failed lazy-chunk load (a `ChunkLoadError`).
 *
 * Vite fires `vite:preloadError` on `window` when a dynamic `import()` cannot
 * fetch its chunk. The overwhelmingly common cause is a client holding a stale
 * bundle (an installed PWA, a long-lived tab) whose referenced chunk hash the
 * latest deploy no longer serves — the openUI runtime is exactly such a chunk.
 *
 * The HTML shells are served `no-cache`, so one reload pulls the fresh shell and
 * with it the current chunk graph. We do it ONCE per 30s window so a genuinely
 * broken deploy cannot put the client in a reload loop; after that the error
 * flows on to the error boundaries, which degrade gracefully instead of
 * blanking.
 *
 * Installed by both SPA entry points (`src/main.tsx`, `src/mobile/main.tsx`) so
 * desktop and mobile recover identically.
 */
const RELOAD_KEY = "sarathy_chunk_reload_at";
const RELOAD_COOLDOWN_MS = 30_000;

export function installPreloadErrorReload(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    // Suppress Vite's default (rethrow) — we take over recovery.
    event.preventDefault();
    try {
      const last = Number(window.sessionStorage.getItem(RELOAD_KEY) || "0");
      if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) {
        // Already reloaded recently — let the boundaries degrade instead.
        return;
      }
      window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      // sessionStorage unavailable (private mode) — fall through and reload.
    }
    window.location.reload();
  });
}

/**
 * The same-origin image proxy (spec 152 §A).
 *
 * The Ask UI draws images that live on the open web — the favicon of every
 * cited source, the thumbnails of the media search. Pointing the browser
 * straight at those hosts is what broke them:
 *
 * * a third-party favicon service is unreachable from the installed PWA and
 *   on filtered networks, so every source card showed a blank square;
 * * many result hosts refuse hotlinking (they answer 403 unless the request
 *   carries a browser `Referer`), so the media rail rendered as empty boxes.
 *
 * The gateway fetches those images ON THE BOX — SSRF-guarded, with a browser
 * UA and a matching Referer — caches them on disk and serves them from the
 * dashboard's own origin. This module is the ONE place that knows the shape
 * of that URL, so the desktop and the mobile SPA cannot drift apart.
 */

/** The gateway route that serves the proxied images. */
export const MEDIA_PROXY_ENDPOINT = "/api/media/proxy";

/**
 * The URL the browser should use for a remote image.
 *
 * A remote http(s) image goes through the gateway's proxy. Anything else —
 * a `data:` URL, a `blob:` URL, a same-origin path — is already local and
 * is returned unchanged.
 */
export function proxiedImage(url: string | null | undefined): string {
  if (!url) return "";
  const trimmed = String(url).trim();
  if (!trimmed) return "";
  // Already local: a data URL, a blob URL or a same-origin path.
  if (trimmed.startsWith("/")) return trimmed;
  if (/^(data|blob):/i.test(trimmed)) return trimmed;
  // Only http(s) is proxied — anything else is left alone.
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${MEDIA_PROXY_ENDPOINT}?url=${encodeURIComponent(trimmed)}`;
}

export default proxiedImage;

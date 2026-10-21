import { AskSurface } from "@/components/ask/AskSurface";

/**
 * Ask mode — the mobile surface.
 *
 * The same shared canvas as the desktop view (`@/components/ask/AskSurface`):
 * one column, the composer pinned at the bottom, the same thread, the same
 * quote and reply mechanics. The only difference is the chrome.
 */
export function AskView() {
  return <AskSurface variant="mobile" />;
}

export default AskView;

import { AskSurface } from "@/components/ask/AskSurface";

/**
 * Ask mode — the desktop surface.
 *
 * Every piece of frame → state logic lives in `@/lib/ask`, and every piece of
 * presentation lives in `@/components/ask`. This file is the desktop frame
 * around the shared canvas; the mobile view (`@/mobile/AskView`) renders the
 * SAME surface with a different chrome.
 */
export function AskView() {
  return <AskSurface variant="desktop" />;
}

export default AskView;

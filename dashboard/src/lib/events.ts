/**
 * Shared window-event names.
 *
 * Kept in a dependency-free module so consumers (the WS client, the session
 * loader, the shared turn module) can all reference the same constant without
 * importing `ws.ts` — tests commonly mock `@/lib/ws`, and a value import from a
 * mocked module would throw for any name the mock omits.
 */

/** Fired on the window every time the dashboard WebSocket (re)opens. */
export const WS_OPEN_EVENT = "sarathy:ws-open";

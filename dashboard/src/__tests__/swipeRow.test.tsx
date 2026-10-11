import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SWIPE_DISMISS_THRESHOLD, SwipeRow } from "@/components/SwipeRow";

/**
 * A left swipe past the threshold dismisses; a shorter swipe snaps back; a
 * mostly-vertical drag is ignored (it belongs to the scroll container). No
 * `onDismiss` means the wrapper is a passthrough (desktop surfaces).
 *
 * jsdom has no TouchEvent, so we build a bubbling Event and hang a `touches`
 * array off it — exactly the shape React's synthetic touch handler reads.
 */
function touch(type: string, clientX: number, clientY = 0) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: [{ clientX, clientY }] });
  return e;
}

function swipe(el: Element, fromX: number, toX: number, dy = 0) {
  const y = 50;
  fireEvent(el, touch("touchstart", fromX, y));
  fireEvent(el, touch("touchmove", toX, y + dy));
  fireEvent(el, touch("touchend", toX, y + dy));
}

describe("SwipeRow", () => {
  afterEach(cleanup);

  it("renders children untouched when there is no onDismiss", () => {
    render(<SwipeRow>content</SwipeRow>);
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.queryByTestId("swipe-row")).toBeNull();
  });

  it("dismisses on a left swipe past the threshold", () => {
    const onDismiss = vi.fn();
    render(<SwipeRow onDismiss={onDismiss}>row</SwipeRow>);

    const surface = screen.getByText("row");
    swipe(surface, 240, 240 - (SWIPE_DISMISS_THRESHOLD + 20));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("snaps back on a short swipe that does not reach the threshold", () => {
    const onDismiss = vi.fn();
    render(<SwipeRow onDismiss={onDismiss}>row</SwipeRow>);

    swipe(screen.getByText("row"), 240, 240 - 20);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("ignores a mostly-vertical drag so the list still scrolls", () => {
    const onDismiss = vi.fn();
    render(<SwipeRow onDismiss={onDismiss}>row</SwipeRow>);

    // Moves left a little but down a lot — this is a scroll, not a dismiss.
    swipe(screen.getByText("row"), 240, 200, 120);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

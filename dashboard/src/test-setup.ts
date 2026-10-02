import "@testing-library/jest-dom/vitest";

/**
 * jsdom implements neither ResizeObserver nor scrollIntoView, and Radix's
 * ScrollArea (used by SessionsView, FilesView and ClientsView) needs both on
 * mount. Stubbing them here means the real components are exercised in tests
 * rather than mocked away per-file — a test that mocks the thing under test's
 * layout has stopped testing the layout.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

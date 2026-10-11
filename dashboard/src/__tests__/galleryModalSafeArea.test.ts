/**
 * Guard: the openUI gallery modal must respect the device safe area.
 *
 * This is a CSS-only bug that jsdom cannot catch — there is no layout engine, so
 * a unit test can never observe the close button sliding under a notch. The
 * regression is also invisible on desktop (where `env()` is 0) and only appears
 * on a notched phone, which is exactly the kind of thing that gets deleted by a
 * future refactor without anyone noticing.
 *
 * So this asserts the *rule* rather than the rendering: the selector must exist,
 * must use the safe-area env vars, and must out-specify the library's own
 * `.openui-gallery__modal-content` rule (which arrives later, in the lazy openUI
 * chunk, and would otherwise win the cascade).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

/** Pull the declaration block for a selector, ignoring whitespace/newlines. */
function ruleFor(selector: string): string | null {
  const flat = css.replace(/\s+/g, " ");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(flat);
  return match ? match[1] : null;
}

describe("openUI gallery modal — safe-area guard", () => {
  const rule = ruleFor(".openui-gallery__modal .openui-gallery__modal-content");

  it("overrides the modal content padding with a safe-area-aware rule", () => {
    expect(rule).not.toBeNull();
  });

  it("pads the top by the safe area so the close button clears a notch", () => {
    expect(rule).toMatch(/padding-top:\s*max\(.*env\(safe-area-inset-top\)/);
  });

  it("pads the bottom by the safe area so the thumbnails clear the home bar", () => {
    expect(rule).toMatch(/padding-bottom:\s*max\(.*env\(safe-area-inset-bottom\)/);
  });

  it("keeps the library's 24px fallback when there is no inset (desktop)", () => {
    expect(rule).toMatch(/max\(var\(--openui-space-xl/);
  });

  it("out-specifies the library's single-class rule", () => {
    // Two classes beat one, regardless of stylesheet order.
    expect(".openui-gallery__modal .openui-gallery__modal-content".split(" ")).toHaveLength(2);
    expect(rule).not.toBeNull();
  });
});

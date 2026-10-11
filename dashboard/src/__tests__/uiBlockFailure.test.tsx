/**
 * Regression guard for the "screen went blank" failure mode (2026-10-11).
 *
 * The openUI renderer is a LAZY chunk. When it fails — a ChunkLoadError after a
 * redeploy, or a flaky mobile network — the dynamic import rejects and React
 * throws during render. With no error boundary anywhere, that unmounted the
 * ENTIRE app and left a blank white screen on both SPAs.
 *
 * Here the renderer is mocked to throw, proving `UIBlock` degrades to the block's
 * raw source instead of propagating the throw up the tree.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/openuiRenderer", () => ({
  // Stands in for the failed chunk: importing it "succeeds" but rendering
  // throws, exactly as a broken widget does.
  default: () => {
    throw new Error("Failed to fetch dynamically imported module: openuiRenderer-abc123.js");
  },
}));

import { UIBlock } from "@/lib/uiBlocks";

const FENCE = (body: string) => ["```openui-lang", body, "```"].join("\n");
const SOURCE = FENCE('root = Stack([t])\nt = TextContent("widget survives the crash")');

describe("UIBlock failure boundary", () => {
  it("degrades to the raw block source when the renderer throws", async () => {
    render(<UIBlock source={SOURCE} />);

    // The raw source is shown, and no throw escapes the boundary.
    const raw = await screen.findByTestId("ui-block-raw", {}, { timeout: 4000 });
    expect(raw.textContent).toContain("widget survives the crash");
    // The crashed widget is not mounted.
    expect(screen.queryByTestId("ui-block")).not.toBeInTheDocument();
  });
});

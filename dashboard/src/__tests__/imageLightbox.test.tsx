/**
 * Image lightbox — tap-to-zoom for images inside openUI blocks.
 *
 * Proves the user-visible intent, not the plumbing: an image the model renders
 * is a button, tapping it opens a fullscreen overlay, the overlay zooms, and it
 * closes. Also guards the contract that the swapped catalog is still the
 * official one (same component names → the generated prompt stays valid).
 */
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { UIBlock } from "@/lib/uiBlocks";
import { UI_BLOCK_COMPONENTS, UI_BLOCK_OVERRIDES, uiLibrary } from "@/lib/openuiRenderer";

const FENCE = (body: string) => ["```openui-lang", body, "```"].join("\n");

const IMAGE_BLOCK = FENCE(
  [
    "root = Stack([card])",
    "card = Card([img])",
    'img = ImageBlock("/api/media?path=/tmp/pic.jpg", "A diagram")',
  ].join("\n"),
);

const IMAGE = FENCE(
  ["root = Stack([card])", "card = Card([img])", 'img = Image("A diagram", "/api/media?path=/tmp/pic.jpg")'].join("\n"),
);

async function renderImageBlock(source = IMAGE_BLOCK) {
  render(<UIBlock source={source} />);
  await screen.findByTestId("ui-block");
  return screen.findByRole("button", { name: /zoom image/i });
}

describe("image lightbox", () => {
  it("makes an ImageBlock image a zoom button", async () => {
    const trigger = await renderImageBlock();
    expect(trigger).toHaveAttribute("title", "Zoom: A diagram");
    expect(within(trigger).getByRole("img")).toHaveAttribute(
      "src",
      "/api/media?path=/tmp/pic.jpg",
    );
  });

  it("makes an Image image a zoom button", async () => {
    const trigger = await renderImageBlock(IMAGE);
    expect(trigger).toHaveAttribute("aria-label", "Zoom image: A diagram");
  });

  it("opens a fullscreen overlay on tap, and closes it", async () => {
    const trigger = await renderImageBlock();
    expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const overlay = await screen.findByTestId("image-lightbox");
    expect(overlay).toHaveAttribute("role", "dialog");
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(within(overlay).getByTestId("lightbox-zoom-level")).toHaveTextContent("100%");

    fireEvent.click(screen.getByTestId("lightbox-close"));
    await waitFor(() => expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument());
  });

  it("zooms with the controls and resets", async () => {
    const trigger = await renderImageBlock();
    fireEvent.click(trigger);
    await screen.findByTestId("image-lightbox");

    fireEvent.click(screen.getByTestId("lightbox-zoom-in"));
    expect(screen.getByTestId("lightbox-zoom-level")).toHaveTextContent("140%");

    fireEvent.click(screen.getByTestId("lightbox-reset"));
    expect(screen.getByTestId("lightbox-zoom-level")).toHaveTextContent("100%");
  });

  it("does NOT dismiss when a toolbar control is used (regression)", async () => {
    // The overlay used to inspect `event.target` for a backdrop tap. A pointer
    // capture on the overlay retargeted the click, so every toolbar tap was
    // read as a backdrop tap and closed the lightbox.
    const trigger = await renderImageBlock();
    fireEvent.click(trigger);
    await screen.findByTestId("image-lightbox");

    fireEvent.pointerDown(screen.getByTestId("lightbox-zoom-in"), { pointerId: 1, buttons: 1 });
    fireEvent.click(screen.getByTestId("lightbox-zoom-in"));
    fireEvent.pointerUp(screen.getByTestId("lightbox-zoom-in"), { pointerId: 1, buttons: 0 });

    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
    expect(screen.getByTestId("lightbox-zoom-level")).toHaveTextContent("140%");
  });

  it("dismisses on a backdrop tap", async () => {
    const trigger = await renderImageBlock();
    fireEvent.click(trigger);
    await screen.findByTestId("image-lightbox");

    fireEvent.click(screen.getByTestId("lightbox-backdrop"));
    await waitFor(() => expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument());
  });

  it("zooms when the image itself is tapped, and zooms back out", async () => {
    const trigger = await renderImageBlock();
    fireEvent.click(trigger);
    const overlay = await screen.findByTestId("image-lightbox");
    const image = within(overlay).getByRole("img");

    fireEvent.click(image);
    expect(screen.getByTestId("lightbox-zoom-level")).toHaveTextContent("250%");

    fireEvent.click(image);
    expect(screen.getByTestId("lightbox-zoom-level")).toHaveTextContent("100%");
  });

  it("closes on Escape", async () => {
    const trigger = await renderImageBlock();
    fireEvent.click(trigger);
    await screen.findByTestId("image-lightbox");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument());
  });

  it("opens from the keyboard", async () => {
    const trigger = await renderImageBlock();
    fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByTestId("image-lightbox");
  });

  it("renders no overlay for a block with no image", async () => {
    const source = FENCE(['root = Stack([t])', 't = TextContent("no image here")'].join("\n"));
    render(<UIBlock source={source} />);
    await screen.findByTestId("ui-block");
    expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument();
  });
});

describe("lightbox catalog contract", () => {
  it("keeps the official catalog intact (prompt stays in sync)", () => {
    // Same names, same count — the generated system prompt still describes
    // exactly what renders.
    expect(Object.keys(uiLibrary().components).sort()).toEqual([...UI_BLOCK_COMPONENTS].sort());
  });

  it("overrides the image components and nothing else", () => {
    expect([...UI_BLOCK_OVERRIDES].sort()).toEqual(["Image", "ImageBlock"]);
    const lib = uiLibrary().components;
    for (const name of UI_BLOCK_OVERRIDES) {
      expect(typeof lib[name].component).toBe("function");
    }
  });

  it("leaves non-image widgets unzoomable", async () => {
    const source = FENCE(
      [
        "root = Stack([tbl])",
        "tbl = Table([c1])",
        'c1 = Col("Region", ["eu-west-1"])',
      ].join("\n"),
    );
    render(<UIBlock source={source} />);
    await screen.findByTestId("ui-block");
    expect(screen.queryByRole("button", { name: /zoom image/i })).not.toBeInTheDocument();
  });
});

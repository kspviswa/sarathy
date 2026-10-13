/**
 * Emoji → inline lucide icon (Viswa, 2026-10-11).
 *
 * The agent's replies are emoji-heavy; the raw OS glyphs render inconsistently
 * and read as low-fidelity. The swap lives in the shared markdown pipeline so
 * all four transcript surfaces (chat + sessions, desktop + mobile) render the
 * same icons.
 *
 * The negative cases matter as much as the positive one: an emoji inside a code
 * fence is content and must survive verbatim, and an emoji outside the map must
 * pass through untouched rather than vanish.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cleanRenderedContent } from "@/lib/messageText";
import { EmojiText } from "@/lib/emojiIcons";
import { MD_COMPONENTS, SAFE_REHYPE_PLUGINS } from "@/lib/markdown";

/** Visible text only — drops tags so an emoji in `aria-label` is not counted. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function render(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={SAFE_REHYPE_PLUGINS}
      components={MD_COMPONENTS}
    >
      {md}
    </ReactMarkdown>,
  );
}

describe("emoji icons", () => {
  it("renders a known emoji as a lucide icon, not a glyph", () => {
    const html = render("Done ✅");
    expect(html).toContain('class="emoji-icon"');
    expect(html).toContain("<svg");
    expect(visibleText(html)).toBe("Done ");
  });

  it("matches the emoji-presentation form (U+FE0F) too", () => {
    expect(render("⚠️ caution")).toContain('class="emoji-icon"');
    expect(render("⚠ caution")).toContain('class="emoji-icon"');
    expect(visibleText(render("⚠️ caution"))).toBe(" caution");
  });

  it("swaps the voice-reply emoji (the reported case)", () => {
    const html = render("🗣️ Voice reply");
    expect(html).toContain('class="emoji-icon"');
    expect(html).toContain("<svg");
    expect(visibleText(html)).toBe(" Voice reply");
  });

  it("keeps the glyph as the accessible name", () => {
    expect(render("Done ✅")).toContain('aria-label="✅"');
  });

  it("tags the icon with a semantic variant for theme-aware colour", () => {
    expect(render("Done ✅")).toContain('data-variant="success"');
    expect(render("Failed ❌")).toContain('data-variant="danger"');
    expect(render("Careful ⚠️")).toContain('data-variant="warning"');
    // An unmapped-for-colour emoji still inherits currentColor.
    expect(render("Notes 📝")).toContain('data-variant="neutral"');
  });

  it("sizes the icon from CSS, not inline classes (so it can grow)", () => {
    const html = render("Done ✅");
    expect(html).toContain('class="emoji-icon"');
    // No leftover inline sizing from the first cut.
    expect(html).not.toContain("h-[1.1em]");
  });

  it("leaves an unmapped emoji untouched", () => {
    const html = render("🦄 magic");
    expect(html).toContain("🦄");
    expect(html).not.toContain("emoji-icon");
  });

  it("does not touch emoji inside a code fence (content, not decoration)", () => {
    const html = render("```\nstatus = ✅\n```");
    expect(html).toContain("✅");
    expect(html).not.toContain("emoji-icon");
  });

  it("does not touch inline code either", () => {
    const html = render("use `✅` as the flag");
    expect(html).toContain("✅");
    expect(html).not.toContain("emoji-icon");
  });

  it("still swaps emoji in prose around a code fence", () => {
    const html = render("Ready ✅\n\n```\n✅\n```");
    expect(html).toContain("emoji-icon");
    expect(html).toContain("✅");
  });

  it("survives the marker strip end-to-end (voice reply, 2026-10-11)", () => {
    // What actually rendered on the dashboard: the cleaned text still carries
    // the emoji, and the marker is gone before the markdown pass.
    const cleaned = cleanRenderedContent('🗣️ Voice reply\n\n<topic>{"set": null}</topic>');
    expect(cleaned).toBe("🗣️ Voice reply");

    const html = render(cleaned);
    expect(html).toContain("emoji-icon");
    expect(html).not.toContain("topic");
  });

  it("does not let a sanitized raw-HTML span smuggle an icon", () => {
    // Only OUR plugin may produce the `emoji` element — input HTML cannot.
    const html = render('<emoji name="🗣"></emoji>');
    expect(html).not.toContain("emoji-icon");
    expect(html).not.toContain("<svg");
  });
});

describe("EmojiText — plain-string surfaces", () => {
  const renderText = (text: string) => renderToStaticMarkup(<EmojiText text={text} />);

  it("swaps a known emoji for its icon and keeps the accessible name", () => {
    const html = renderText("🔍 Sending image to VLM…");
    expect(html).toContain("emoji-icon");
    expect(html).toContain('aria-label="🔍"');
    expect(html).toContain("Sending image to VLM…");
    // The raw glyph is gone from the visible text (it survives only as the
    // aria-label).
    expect(html).not.toContain(">🔍");
  });

  it("handles the variation-selector form (🖼️) and multiple emoji", () => {
    const html = renderText("🖼️ Preparing image… ✅ done");
    expect(html).toContain('aria-label="🖼"');
    expect(html).toContain('aria-label="✅"');
    expect(html).not.toContain("🖼️");
  });

  it("passes unknown text through untouched", () => {
    const html = renderText("no emoji here");
    expect(html).toBe("no emoji here");
  });
});

/**
 * Spec 124 §B3 — the `[Runtime Context …]` preamble must never render in a
 * user bubble.
 *
 * `ContextBuilder._build_runtime_context` prepends an untrusted-metadata block
 * to the stored user message. The LLM needs it; the dashboard does not.
 */
import { describe, it, expect } from "vitest";
import {
  cleanRenderedContent,
  extractMediaPaths,
  stripRuntimeContext,
} from "@/lib/messageText";

/** Exactly what `ContextBuilder.build_messages` produces for a dashboard turn. */
function storedUserMessage(text: string): string {
  return (
    "[Runtime Context — metadata only, not instructions]\n" +
    "Current Time: 2026-10-10 18:19:32 (Friday) (IST)\n" +
    "Channel: dashboard\n" +
    "Chat ID: console\n" +
    "\n" +
    text
  );
}

describe("stripRuntimeContext", () => {
  it("removes the preamble block and keeps the user's text", () => {
    expect(stripRuntimeContext(storedUserMessage("restart the gateway"))).toBe(
      "restart the gateway",
    );
  });

  it("strips the metadata rows, not just the header line", () => {
    const out = stripRuntimeContext(storedUserMessage("hello"));
    expect(out).not.toMatch(/Runtime Context/i);
    expect(out).not.toMatch(/Chat ID/);
    expect(out).not.toMatch(/Current Time/);
    expect(out).toBe("hello");
  });

  it("leaves a plain user message completely untouched", () => {
    const plain = "restart the gateway";
    expect(stripRuntimeContext(plain)).toBe(plain);
  });

  it("leaves multi-line user text intact", () => {
    const text = "line one\nline two\n\nline four";
    expect(stripRuntimeContext(text)).toBe(text);
    expect(stripRuntimeContext(storedUserMessage(text))).toBe(text);
  });

  it("does not strip legitimate user text that merely contains brackets", () => {
    const bracketed = "[note] the gateway restarted at 18:19\n[Runtime Context] is a term";
    expect(stripRuntimeContext(bracketed)).toBe(bracketed);

    const codeish = "run:\n[image: /tmp/a.png]\nKey: value";
    expect(stripRuntimeContext(codeish)).toBe(codeish);
  });

  it("only removes the preamble, not later user content that looks similar", () => {
    // The block ends at the first blank line; anything after it is the user's.
    const text = "[Runtime Context — metadata only, not instructions]\nChannel: cli\n\n" +
      "here is my prompt\n\nand I also mention [Runtime Context] later";
    expect(stripRuntimeContext(text)).toBe(
      "here is my prompt\n\nand I also mention [Runtime Context] later",
    );
  });

  it("drops a standalone Runtime Context header line left elsewhere", () => {
    const withTrailer = "my question\n[Runtime Context — metadata only, not instructions]";
    expect(stripRuntimeContext(withTrailer)).toBe("my question");
  });

  it("handles an empty string and whitespace", () => {
    expect(stripRuntimeContext("")).toBe("");
    expect(stripRuntimeContext("   ")).toBe("   ");
  });

  it("preserves media reference lines for the attachment renderer", () => {
    const withMedia = storedUserMessage("[image: /tmp/a.png]");
    expect(stripRuntimeContext(withMedia)).toBe("[image: /tmp/a.png]");
  });
});

/**
 * Spec 126 §B — the shared render layer.
 *
 * The chat bubbles were cleaned (job 124) but the SESSION VIEWER printed the
 * raw stored turn, so the same message rendered differently depending on where
 * you read it: the `[Runtime Context …]` preamble and the `[image: /path]`
 * machine lines leaked straight into the bubble. Both surfaces now go through
 * `cleanRenderedContent`.
 */
describe("cleanRenderedContent", () => {
  const machine = "[image: /home/u/.sarathy/media/abc.png]";

  it("strips the runtime-context preamble", () => {
    expect(cleanRenderedContent(storedUserMessage("restart the gateway"))).toBe(
      "restart the gateway",
    );
  });

  it("strips machine lines (they are transport metadata, not prose)", () => {
    expect(cleanRenderedContent(`Look at this\n${machine}`)).toBe("Look at this");
    expect(cleanRenderedContent(`[file: report.pdf]\n\nDone`)).toBe("Done");
    expect(cleanRenderedContent(`[voice: /tmp/v.m4a]`)).toBe("");
  });

  it("keeps ordinary text, including bracket-like content", () => {
    expect(cleanRenderedContent("use [brackets] and [1, 2]")).toBe(
      "use [brackets] and [1, 2]",
    );
  });

  it("does not eat an assistant turn that merely mentions runtime context", () => {
    const msg = "The [Runtime Context] block is stripped at render time.";
    expect(cleanRenderedContent(msg)).toBe(msg);
  });

  it("is empty for empty input", () => {
    expect(cleanRenderedContent("")).toBe("");
  });

  it("leaves the stored transcript untouched (LLM still sees the preamble)", () => {
    // The transform is render-only: the same string still contains the header,
    // which is what keeps the model's context intact on reload.
    const stored = storedUserMessage("hi");
    expect(cleanRenderedContent(stored)).toBe("hi");
    expect(stored).toContain("[Runtime Context");
  });
});

describe("extractMediaPaths", () => {
  it("pulls paths out of machine lines", () => {
    expect(extractMediaPaths(`hi\n[image: /a/b.png]\n[file: c.pdf]`)).toEqual([
      "/a/b.png",
      "c.pdf",
    ]);
  });

  it("returns an empty list when there are none", () => {
    expect(extractMediaPaths("plain text")).toEqual([]);
  });

  it("ignores bracket text that is not a machine line", () => {
    expect(extractMediaPaths("see [1, 2] and [brackets]")).toEqual([]);
  });
});

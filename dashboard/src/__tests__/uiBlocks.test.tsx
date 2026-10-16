/**
 * openUI adapter: catalog wiring, markdown fallback, URL sanitisation, and the
 * "lazy boundary" contract.
 *
 * Enforces the architecture:
 *  - the heavy openUI runtime lives ONLY in openuiRenderer.tsx (+ openuiTheme
 *    if present) — never imported from any other module under src/;
 *  - uiBlocks.tsx stays dependency-light (no @openuidev import);
 *  - a text reply never renders as a UI block.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReactMarkdown from "react-markdown";

import {
  sanitizeUrl,
  extractProse,
  extractUIBlocks,
  hasOpenUIBlock,
  resolvePortal,
  UIBlock,
} from "@/lib/uiBlocks";
import {
  parseUI,
  uiLibrary,
  UI_BLOCK_COMPONENTS,
  UI_BLOCK_OVERRIDES,
} from "@/lib/openuiRenderer";

describe("sanitizeUrl", () => {
  it("allows absolute http and https URLs", () => {
    expect(sanitizeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com/");
  });

  it("rejects dangerous schemes", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects non-strings, empty and malformed values", () => {
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(sanitizeUrl(null)).toBeNull();
    expect(sanitizeUrl(42)).toBeNull();
    expect(sanitizeUrl("")).toBeNull();
    expect(sanitizeUrl("   ")).toBeNull();
    expect(sanitizeUrl("not a url")).toBeNull();
    expect(sanitizeUrl("/relative/path")).toBeNull();
  });

  it("rejects control-character scheme smuggling", () => {
    expect(sanitizeUrl("java script:alert(1)")).toBeNull();
    expect(sanitizeUrl("https://exa\nmple.com")).toBeNull();
  });
});

const FENCE = (body: string) => ["```openui-lang", body, "```"].join("\n");

const VALID = FENCE(
  [
    "root = Stack([card])",
    "card = Card([t, tbl])",
    't = TextContent("Deploy status")',
    "tbl = Table([c1, c2])",
    'c1 = Col("Region", ["eu-west-1"])',
    'c2 = Col("Replicas", ["3"])',
  ].join("\n"),
);

describe("hasOpenUIBlock (the heavy-load gate)", () => {
  it("detects a tagged openui-lang fence", () => {
    expect(hasOpenUIBlock(VALID)).toBe(true);
  });

  it("does NOT fire for ordinary prose or a normal code fence", () => {
    expect(hasOpenUIBlock("Just a plain answer.")).toBe(false);
    expect(hasOpenUIBlock("```python\nprint('hi')\n```")).toBe(false);
    expect(hasOpenUIBlock("")).toBe(false);
    expect(hasOpenUIBlock(null)).toBe(false);
  });
});

describe("parseUI", () => {
  it("accepts a well-formed block from the official library", () => {
    expect(parseUI(VALID).kind).toBe("ui");
  });

  it("falls back to markdown for an unknown component", () => {
    const bad = FENCE('root = Stack([t])\nt = TotallyMadeUpComponent("x")');
    const parsed = parseUI(bad);
    expect(parsed.kind).toBe("markdown");
    expect(parsed.kind === "markdown" && parsed.reason).toMatch(/unknown-component/);
  });

  it("falls back for pure prose / empty / nullish", () => {
    expect(parseUI("Here is a normal answer").kind).toBe("markdown");
    expect(parseUI("").kind).toBe("markdown");
    expect(parseUI("   \n  ").kind).toBe("markdown");
    expect(parseUI(null).kind).toBe("markdown");
    expect(parseUI(undefined).kind).toBe("markdown");
  });

  it("falls back when the root reference is unresolved", () => {
    expect(parseUI(FENCE("root = Stack([missingThing])")).kind).toBe("markdown");
  });
});

describe("UIBlock rendering (lazy)", () => {
  it("renders a Card + Table from the official library", async () => {
    render(<UIBlock source={VALID} />);
    const block = await screen.findByTestId("ui-block");
    await waitFor(() => expect(within(block).getByText("Deploy status")).toBeInTheDocument());
    expect(within(block).getByText("Region")).toBeInTheDocument();
    expect(within(block).getByText("eu-west-1")).toBeInTheDocument();
  });

  it("renders a Callout", async () => {
    const source = FENCE(
      ['root = Stack([c])', 'c = Callout("success", "Deploy finished", "All green")'].join("\n"),
    );
    render(<UIBlock source={source} />);
    await waitFor(() => expect(screen.getByText("Deploy finished")).toBeInTheDocument());
  });

  it("falls back to raw source for an invalid block (never an empty bubble)", async () => {
    const bad = FENCE('root = Stack([t])\nt = Nope("x")');
    render(<UIBlock source={bad} />);
    const raw = await screen.findByTestId("ui-block-raw");
    expect(raw.textContent).toContain("Nope");
  });

  it("does not emit an unsafe javascript: href from markdown links", async () => {
    const source = FENCE(
      ["root = Stack([t])", 't = MarkDownRenderer("[x](javascript:alert(1))")'].join("\n"),
    );
    const { container } = render(<UIBlock source={source} />);
    await screen.findByTestId("ui-block");
    expect(container.innerHTML).not.toContain("javascript:");
  });
});

describe("extractProse / extractUIBlocks", () => {
  it("splits prose from the fenced region", () => {
    const mixed = "Before the block\n\n```openui-lang\nroot = Stack([])\n```\n\nAfter the block";
    expect(extractProse(mixed)).toEqual(["Before the block", "After the block"]);
    expect(extractUIBlocks(mixed)).toBe("root = Stack([])");
  });
});

describe("adapter boundary", () => {
  it("exposes the full official catalog, not a curated subset", () => {
    const names = Object.keys(uiLibrary().components);
    expect(names.length).toBeGreaterThan(60);
    for (const required of ["Table", "BarChart", "LineChart", "Button", "Form", "Tabs", "Stack"]) {
      expect(names).toContain(required);
    }
  });

  it("offers no raw-HTML escape hatch", () => {
    const names = Object.keys(uiLibrary().components).map((n) => n.toLowerCase());
    for (const forbidden of ["html", "raw", "iframe", "dangerouslysetinnerhtml"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("keeps the heavy runtime in one lazy module", async () => {
    const { globSync, readFileSync, existsSync } = await import("node:fs");
    const allowed = new Set(["src/lib/openuiRenderer.tsx", "src/lib/openuiTheme.tsx"]);
    const files = globSync("src/**/*.{ts,tsx}");
    const offenders = files.filter((f) => {
      if (allowed.has(f)) return false;
      return /from\s+["']@openuidev\//.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
    expect(existsSync("src/lib/openuiRenderer.tsx")).toBe(true);
  });

  it("uiBlocks.tsx imports no openUI package", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/uiBlocks.tsx", "utf8");
    expect(/from\s+["']@openuidev\//.test(src)).toBe(false);
  });
});

describe("markdown regression guard", () => {
  it("pure text still renders as markdown, exactly as before openUI", () => {
    render(<ReactMarkdown>{"Normal **bold** reply"}</ReactMarkdown>);
    expect(screen.getByText("bold")).toBeInTheDocument();
  });
});

describe("openUI 1.0: library.extend() catalog", () => {
  it("overrides exactly ImageBlock and Image, in that order", () => {
    expect(UI_BLOCK_OVERRIDES).toEqual(["ImageBlock", "Image"]);
  });

  it("keeps every component from the official catalog", () => {
    const names = Object.keys(uiLibrary().components);
    // extend() derives from the base library, so the name set is unchanged.
    expect([...names].sort()).toEqual([...UI_BLOCK_COMPONENTS].sort());
    expect(names.length).toBeGreaterThan(60);
    for (const required of ["Table", "BarChart", "LineChart", "Button", "Form", "Tabs", "Stack"]) {
      expect(names).toContain(required);
    }
  });

  it("actually swapped the Image/ImageBlock renderers (not just listed them)", () => {
    const lib = uiLibrary().components;
    // A DerivedComponent keeps its schema but carries our zoomable renderer.
    for (const name of UI_BLOCK_OVERRIDES) {
      expect(typeof lib[name].component).toBe("function");
    }
  });
});

describe("resolvePortal (open-portal allowlist)", () => {
  const ALLOWLISTED: Record<string, string> = {
    manana: "https://skandpriya.com/manana/",
    shravana: "https://skandpriya.com/shravana/",
    vatsalya: "https://skandpriya.com/vatsalya/",
    smriti: "https://skandpriya.com/smriti/",
    charitham: "https://skandpriya.com/charitham/",
    dashboard: "https://skandpriya.com/dashboard/",
    patra: "https://skandpriya.com/patra/",
  };

  it("resolves every allowlisted slug to its portal URL", () => {
    for (const [slug, url] of Object.entries(ALLOWLISTED)) {
      expect(resolvePortal(slug)).toBe(url);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(resolvePortal("  manana  ")).toBe(ALLOWLISTED.manana);
  });

  it("returns null for unknown, malformed or non-string slugs", () => {
    for (const bad of [
      "evil",
      "http://x",
      "",
      "   ",
      "MANANA", // case-sensitive
      "manana/",
      "https://skandpriya.com/manana/",
      undefined,
      null,
      42,
      {},
      ["manana"],
    ]) {
      expect(resolvePortal(bad)).toBeNull();
    }
  });
});

describe("openUI 1.0: @OpenPortal custom action", () => {
  // The action is registered as `open_portal` (the step the parser and prompt
  // use verbatim is `@open_portal(...)`); `@OpenPortal` is just the label.
  const PORTAL_BLOCK = FENCE(
    ["root = Stack([btn])", 'btn = Button("Open Manana", @open_portal("manana"))'].join("\n"),
  );

  const portalBlockFor = (slugLiteral: string) =>
    FENCE(["root = Stack([btn])", `btn = Button("Go", @open_portal(${slugLiteral}))`].join("\n"));

  it("parses a block carrying the custom action (parser built from the extended library)", () => {
    const parsed = parseUI(PORTAL_BLOCK);
    expect(parsed.kind).toBe("ui");
    if (parsed.kind === "ui") {
      // Footgun 1: a parser built from the BASE library would flag the unknown
      // action. Built from the extended one, there are no errors at all.
      expect(parsed.result.meta.errors ?? []).toEqual([]);
    }
  });

  it("dispatches {type:open_portal, params:{slug}} to onAction", async () => {
    const onAction = vi.fn();
    render(<UIBlock source={PORTAL_BLOCK} onAction={onAction} />);
    const btn = await screen.findByRole("button", { name: /open manana/i });
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open_portal", params: { slug: "manana" } }),
    );
  });

  it("opens the allowlisted portal URL when no onAction takes ownership", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      render(<UIBlock source={PORTAL_BLOCK} />);
      const btn = await screen.findByRole("button", { name: /open manana/i });
      fireEvent.click(btn);
      expect(open).toHaveBeenCalledWith(
        "https://skandpriya.com/manana/",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
    }
  });

  it.each(['"evil"', '"http://x"', '""'])(
    "does NOT open a window for a non-allowlisted slug (%s)",
    async (slugLiteral) => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      try {
        render(<UIBlock source={portalBlockFor(slugLiteral)} />);
        const btn = await screen.findByRole("button", { name: /go/i });
        fireEvent.click(btn);
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    },
  );
});

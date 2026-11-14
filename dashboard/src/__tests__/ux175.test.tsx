/**
 * Spec 175 — eight dashboard UX fixes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React, { useRef, useState } from "react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: any) =>
    React.cloneElement(children, props),
  TooltipContent: () => null,
}));

import { DEFAULT_SUGGESTIONS, GreetingState } from "@/components/GreetingState";
import { QuoteActionBar } from "@/components/QuoteAsk";
import {
  ComposerFormatToolbar,
  ComposerMarkdownPreview,
} from "@/components/ComposerFormatToolbar";
import { MessageActions } from "@/components/MessageActions";
import { MediaAttachments } from "@/components/ChatMedia";
import {
  ChatFontScaleControl,
  useChatFontScale,
} from "@/components/ChatFontScaleControl";
import { AskResearchProgress } from "@/components/ask/AskResearchProgress";
import { AskTurnCard } from "@/components/ask/AskTurnCard";
import { LightboxProvider } from "@/lib/lightbox";
import {
  CHAT_FONT_SCALE_KEY,
  CHAT_FONT_SCALE_STEPS,
  clampChatFontScale,
  nextChatFontScale,
  readChatFontScale,
} from "@/lib/chatFontScale";
import { applyFormatAction } from "@/lib/composerFormat";
import type { AskStep, AskTurn } from "@/lib/ask";

const BAD_CHIP = /^(?:\[|\/home\/)|Runtime Context|\[image:/i;

describe("spec 175 §A — greeting chips never use raw preview text", () => {
  it("DEFAULT_SUGGESTIONS labels are curated and clean", () => {
    for (const s of DEFAULT_SUGGESTIONS) {
      expect(s.label).not.toMatch(BAD_CHIP);
      expect(s.label.startsWith("[")).toBe(false);
    }
  });

  it("GreetingState renders only the labels it is given", () => {
    render(
      <GreetingState
        suggestions={DEFAULT_SUGGESTIONS}
        onPick={vi.fn()}
      />,
    );
    const chips = screen.getAllByTestId("suggestion-chip");
    expect(chips).toHaveLength(DEFAULT_SUGGESTIONS.length);
    for (const chip of chips) {
      expect(chip.textContent).not.toMatch(BAD_CHIP);
    }
  });
});

describe("spec 175 §B — QuoteActionBar contrast", () => {
  it("uses a high-contrast primary surface and the exact label", () => {
    render(
      <QuoteActionBar
        visible
        rect={{ top: 100, left: 40 }}
        onAdd={vi.fn()}
      />,
    );
    const bar = screen.getByTestId("quote-action-bar");
    expect(bar).toHaveTextContent("Add to follow-up");
    expect(bar.className).toMatch(/bg-primary/);
    expect(bar.className).toMatch(/text-primary-foreground/);
    expect(bar.className).not.toMatch(/bg-card/);
  });
});

describe("spec 175 §C — composer format helpers + preview", () => {
  it("wraps a selection in bold / italic / code", () => {
    expect(applyFormatAction("hello world", 0, 5, "bold")).toEqual({
      value: "**hello** world",
      selectionStart: 2,
      selectionEnd: 7,
    });
    expect(applyFormatAction("hello", 0, 5, "italic").value).toBe("*hello*");
    expect(applyFormatAction("hello", 0, 5, "code").value).toBe("`hello`");
  });

  it("inserts placeholders at the caret", () => {
    const r = applyFormatAction("ab", 1, 1, "bold");
    expect(r.value).toBe("a**bold**b");
  });

  it("toolbar inserts markdown and preview renders strong", () => {
    function Harness() {
      const [value, setValue] = useState("**bold**");
      const [preview, setPreview] = useState(false);
      const ref = useRef<HTMLTextAreaElement>(null);
      return (
        <div>
          <ComposerFormatToolbar
            value={value}
            onChange={setValue}
            textareaRef={ref}
            preview={preview}
            onPreviewChange={setPreview}
          />
          <textarea ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
          {preview && <ComposerMarkdownPreview content={value} />}
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("composer-format-toolbar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("composer-preview-toggle"));
    const preview = screen.getByTestId("composer-markdown-preview");
    expect(preview.querySelector("strong")).toHaveTextContent("bold");
    // Draft preserved on toggle.
    fireEvent.click(screen.getByTestId("composer-preview-toggle"));
    expect(screen.queryByTestId("composer-markdown-preview")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("**bold**")).toBeInTheDocument();
  });
});

describe("spec 175 §D — user-bubble action colours", () => {
  it("user actions use primary-foreground, not muted-foreground", () => {
    render(
      <MessageActions content="hi" onReply={vi.fn()} onPrimary />,
    );
    const reply = screen.getByTestId("message-reply");
    const copy = screen.getByTestId("message-action-copy");
    expect(reply.className).toMatch(/primary-foreground/);
    expect(reply.className).not.toMatch(/muted-foreground/);
    expect(copy.className).toMatch(/primary-foreground/);
    expect(copy.className).not.toMatch(/muted-foreground/);
  });

  it("assistant actions keep muted-foreground", () => {
    render(<MessageActions content="hi" onReply={vi.fn()} />);
    expect(screen.getByTestId("message-reply").className).toMatch(/muted-foreground/);
  });
});

describe("spec 175 §E — image thumbnails", () => {
  it("renders images as object-cover thumbs", () => {
    render(
      <MediaAttachments
        paths={["/home/viswa/pic.png"]}
        onPrimary
      />,
    );
    const thumb = screen.getByTestId("chat-media-thumb");
    expect(thumb.className).toMatch(/size-20/);
    expect(thumb.className).toMatch(/primary-foreground/);
    const img = thumb.querySelector("img");
    expect(img?.className).toMatch(/object-cover/);
  });
});

describe("spec 175 §F — font scale", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("clamps to the allowed steps", () => {
    expect(clampChatFontScale(0.5)).toBe(0.9);
    expect(clampChatFontScale(1.4)).toBe(1.4);
    expect(clampChatFontScale(9)).toBe(1.4);
  });

  it("steps up and down without leaving the range", () => {
    expect(nextChatFontScale(0.9, -1)).toBe(0.9);
    expect(nextChatFontScale(1.4, 1)).toBe(1.4);
    expect(nextChatFontScale(1.0, 1)).toBe(1.125);
  });

  it("persists and updates the control value", () => {
    function Harness() {
      const { scale, increase, decrease, reset, style } = useChatFontScale();
      return (
        <div data-testid="scale-wrap" style={style} data-chat-scale="">
          <ChatFontScaleControl
            scale={scale}
            onIncrease={increase}
            onDecrease={decrease}
            onReset={reset}
          />
        </div>
      );
    }

    render(<Harness />);
    const wrap = screen.getByTestId("scale-wrap");
    expect(wrap.style.getPropertyValue("--chat-font-scale")).toBe("1");

    act(() => {
      fireEvent.click(screen.getByTestId("chat-font-increase"));
    });
    expect(wrap.style.getPropertyValue("--chat-font-scale")).toBe("1.125");
    expect(localStorage.getItem(CHAT_FONT_SCALE_KEY)).toBe("1.125");
    expect(readChatFontScale()).toBe(1.125);

    act(() => {
      fireEvent.click(screen.getByTestId("chat-font-reset"));
    });
    expect(wrap.style.getPropertyValue("--chat-font-scale")).toBe("1");

    // Drive to max then refuse to go further.
    for (let i = 0; i < CHAT_FONT_SCALE_STEPS.length + 2; i++) {
      act(() => {
        fireEvent.click(screen.getByTestId("chat-font-increase"));
      });
    }
    expect(wrap.style.getPropertyValue("--chat-font-scale")).toBe("1.4");
  });
});

describe("spec 175 §G — Ask rail gutter reserved", () => {
  function makeTurn(overrides: Partial<AskTurn> = {}): AskTurn {
    return {
      id: "turn-1",
      query: "Capital of France?",
      mode: "speed",
      sources: [],
      answer: "Paris.",
      sourcesList: [],
      steps: [],
      createdAt: 0,
      media: [],
      ...overrides,
    };
  }

  it("desktop turn always renders the rail column with empty media", () => {
    render(
      <LightboxProvider>
        <AskTurnCard
          turn={makeTurn()}
          streaming={false}
          onReply={vi.fn()}
          onQuote={vi.fn()}
          onRewrite={vi.fn()}
          onSummarize={vi.fn()}
        />
      </LightboxProvider>,
    );
    expect(screen.getByTestId("ask-media-rail")).toBeInTheDocument();
    expect(screen.getByTestId("ask-turn-content").className).toMatch(/lg:max-w-3xl/);
  });
});

describe("spec 175 §H — Research Progress bounded + bottom collapse", () => {
  const steps: AskStep[] = Array.from({ length: 20 }, (_, i) => ({
    kind: "reasoning" as const,
    reasoning: `Step ${i}`,
  }));

  it("bounds the expanded list, keeps sticky header classes, and collapses from the bottom", () => {
    render(<AskResearchProgress steps={steps} streaming={false} />);
    fireEvent.click(screen.getByTestId("ask-steps-toggle"));
    const list = screen.getByTestId("ask-step-list");
    expect(list.className).toMatch(/max-h-\[60vh]/);
    expect(list.className).toMatch(/overflow-y-auto/);
    expect(screen.getByTestId("ask-steps-toggle").className).toMatch(/sticky/);
    expect(screen.getByTestId("ask-steps")).toHaveAttribute("data-expanded", "true");

    fireEvent.click(screen.getByTestId("ask-steps-collapse-bottom"));
    expect(screen.getByTestId("ask-steps")).toHaveAttribute("data-expanded", "false");
    expect(screen.queryByTestId("ask-step-list")).not.toBeInTheDocument();
  });
});

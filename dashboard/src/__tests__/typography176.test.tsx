/**
 * Spec 176 — uncapped reading size, composer size, appearance fonts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React, { useRef, useState } from "react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: any) =>
    React.cloneElement(children, props),
  TooltipContent: () => null,
}));

vi.mock("@/lib/api", () => ({
  api: {
    getConfig: vi.fn().mockResolvedValue({ agents: { defaults: {} } }),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    modalities: vi.fn().mockResolvedValue(null),
    usageSummary: vi.fn().mockResolvedValue({ available: false }),
    devices: {
      list: vi.fn().mockResolvedValue({ devices: [] }),
    },
  },
  getToken: vi.fn(() => "test"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
  Toaster: () => null,
}));

import {
  ChatFontScaleControl,
  useChatFontScale,
} from "@/components/ChatFontScaleControl";
import {
  ComposerFormatToolbar,
  ComposerMarkdownPreview,
} from "@/components/ComposerFormatToolbar";
import { AppearanceSettings } from "@/components/AppearanceSettings";
import { SettingsView } from "@/views/SettingsView";
import {
  CHAT_FONT_SCALE_DEFAULT,
  CHAT_FONT_SCALE_KEY,
  FONT_SCALE_FACTOR,
  FONT_SCALE_FLOOR,
  isValidFontScale,
  nextChatFontScale,
  readChatFontScale,
  writeChatFontScale,
} from "@/lib/chatFontScale";
import {
  COMPOSER_FONT_SCALE_KEY,
  readComposerFontScale,
  writeComposerFontScale,
} from "@/lib/composerFontScale";
import {
  APP_FONT_KEY,
  COMPOSED_FONT_KEY,
  FONT_FACE_DEFAULT,
  WEB_SAFE_FALLBACK_FONTS,
  applyAppearanceFonts,
  loadFontFamilies,
  readAppFont,
  readComposedFont,
  writeAppFont,
  writeComposedFont,
} from "@/lib/appearanceFonts";

describe("spec 176 §A — uncapped reading scale maths", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("rejects non-finite / non-positive values", () => {
    expect(isValidFontScale(0)).toBe(false);
    expect(isValidFontScale(-1)).toBe(false);
    expect(isValidFontScale(NaN)).toBe(false);
    expect(isValidFontScale(Infinity)).toBe(false);
    expect(isValidFontScale(1.25)).toBe(true);
    expect(isValidFontScale(3.75)).toBe(true);
  });

  it("A+ keeps growing past 140% with no ceiling", () => {
    let scale = 1.0;
    for (let i = 0; i < 8; i++) scale = nextChatFontScale(scale, 1);
    expect(scale).toBeCloseTo(FONT_SCALE_FACTOR ** 8, 10);
    expect(scale).toBeGreaterThan(1.4);
    // Keep going — still no cap.
    for (let i = 0; i < 20; i++) scale = nextChatFontScale(scale, 1);
    expect(scale).toBeGreaterThan(10);
  });

  it("A− floors around 0.5 and never goes non-positive", () => {
    let scale = 1.0;
    for (let i = 0; i < 40; i++) scale = nextChatFontScale(scale, -1);
    expect(scale).toBe(FONT_SCALE_FLOOR);
    expect(scale).toBeGreaterThan(0);
  });

  it("A− / A+ are inverses within floating point", () => {
    const start = 1.25;
    const up = nextChatFontScale(start, 1);
    const back = nextChatFontScale(up, -1);
    expect(back).toBeCloseTo(start, 10);
  });

  it("stored 3.75 round-trips without snapping", () => {
    writeChatFontScale(3.75);
    expect(readChatFontScale()).toBe(3.75);
    expect(localStorage.getItem(CHAT_FONT_SCALE_KEY)).toBe("3.75");
  });

  it("invalid stored values fall back to default", () => {
    localStorage.setItem(CHAT_FONT_SCALE_KEY, "0");
    expect(readChatFontScale()).toBe(CHAT_FONT_SCALE_DEFAULT);
    localStorage.setItem(CHAT_FONT_SCALE_KEY, "nope");
    expect(readChatFontScale()).toBe(CHAT_FONT_SCALE_DEFAULT);
  });
});

describe("spec 176 §A/§B — header vs composer controls", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--composer-font-scale");
    document.documentElement.style.removeProperty("--chat-font-scale");
  });

  it("header control persists and grows past 140%", () => {
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
          <div data-testid="bubble" data-chat-body="">
            bubble
          </div>
          <textarea data-testid="composer" data-chat-composer="" defaultValue="draft" />
        </div>
      );
    }

    render(<Harness />);
    const wrap = screen.getByTestId("scale-wrap");
    expect(wrap.style.getPropertyValue("--chat-font-scale")).toBe("1");

    act(() => {
      fireEvent.click(screen.getByTestId("chat-font-increase"));
    });
    expect(Number(wrap.style.getPropertyValue("--chat-font-scale"))).toBeCloseTo(
      FONT_SCALE_FACTOR,
      10,
    );
    expect(readChatFontScale()).toBeCloseTo(FONT_SCALE_FACTOR, 10);

    for (let i = 0; i < 8; i++) {
      act(() => {
        fireEvent.click(screen.getByTestId("chat-font-increase"));
      });
    }
    const after = Number(wrap.style.getPropertyValue("--chat-font-scale"));
    expect(after).toBeGreaterThan(1.4);
    expect(screen.getByTestId("chat-font-reset")).toHaveTextContent(
      `${Math.round(after * 100)}%`,
    );

    // Composer key untouched by reading control.
    expect(localStorage.getItem(COMPOSER_FONT_SCALE_KEY)).toBeNull();
  });

  it("composer control changes only the composer scale key", () => {
    function Harness() {
      const ref = useRef<HTMLTextAreaElement>(null);
      const reading = useChatFontScale();
      return (
        <div>
          <div data-testid="reading" style={reading.style}>
            {reading.scale}
          </div>
          <ComposerFormatToolbar
            value="hello"
            onChange={() => {}}
            textareaRef={ref}
            preview={false}
            onPreviewChange={() => {}}
          />
          <textarea data-testid="composer" data-chat-composer="" />
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("composer-font-scale")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("composer-font-increase"));
    });
    expect(readComposerFontScale()).toBeCloseTo(FONT_SCALE_FACTOR, 10);
    expect(readChatFontScale()).toBe(1);
    expect(
      document.documentElement.style.getPropertyValue("--composer-font-scale"),
    ).toBe(String(FONT_SCALE_FACTOR));

    act(() => {
      fireEvent.click(screen.getByTestId("composer-font-reset"));
    });
    expect(readComposerFontScale()).toBe(1);
  });

  it("changing reading scale does not change composer scale and vice versa", () => {
    writeChatFontScale(2);
    writeComposerFontScale(0.9);
    expect(readChatFontScale()).toBe(2);
    expect(readComposerFontScale()).toBe(0.9);

    writeChatFontScale(2.5);
    expect(readComposerFontScale()).toBe(0.9);

    writeComposerFontScale(1.5);
    expect(readChatFontScale()).toBe(2.5);
  });
});

describe("spec 176 §C — appearance fonts", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--app-font-family");
    document.documentElement.style.removeProperty("--chat-font-family");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists selection and Default restores", () => {
    writeAppFont("Georgia");
    writeComposedFont("Courier New");
    expect(readAppFont()).toBe("Georgia");
    expect(readComposedFont()).toBe("Courier New");

    applyAppearanceFonts("Georgia", "Courier New");
    expect(
      document.documentElement.style.getPropertyValue("--app-font-family"),
    ).toBe("Georgia");
    expect(
      document.documentElement.style.getPropertyValue("--chat-font-family"),
    ).toBe('"Courier New"');

    writeAppFont(FONT_FACE_DEFAULT);
    writeComposedFont(FONT_FACE_DEFAULT);
    applyAppearanceFonts("", "");
    expect(
      document.documentElement.style.getPropertyValue("--app-font-family"),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--chat-font-family"),
    ).toBe("");
    expect(localStorage.getItem(APP_FONT_KEY)).toBeNull();
    expect(localStorage.getItem(COMPOSED_FONT_KEY)).toBeNull();
  });

  it("fallback path renders explanatory note when queryLocalFonts is absent", async () => {
    // Ensure the API is missing.
    const original = window.queryLocalFonts;
    window.queryLocalFonts = undefined;

    render(<AppearanceSettings />);
    expect(screen.getByTestId("appearance-idle-note")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("appearance-load-fonts"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("appearance-fallback-note")).toBeInTheDocument();
    });
    expect(screen.getByTestId("appearance-fallback-note").textContent).toMatch(
      /not your installed fonts/i,
    );
    expect(loadFontFamilies).toBeDefined();
    const result = await loadFontFamilies();
    expect(result.source).toBe("fallback");
    expect(result.families).toEqual([...WEB_SAFE_FALLBACK_FONTS]);

    window.queryLocalFonts = original;
  });

  it("queryLocalFonts absence does not throw", async () => {
    window.queryLocalFonts = undefined;
    await expect(loadFontFamilies()).resolves.toMatchObject({
      source: "fallback",
    });
  });

  it("Settings exposes an Appearance segment after Form", async () => {
    render(<SettingsView onLoggedOut={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-segment-appearance")).toBeInTheDocument();
    });
    const segments = screen.getByTestId("settings-segments");
    const ids = Array.from(segments.querySelectorAll("[data-testid^='settings-segment-']")).map(
      (el) => el.getAttribute("data-testid"),
    );
    expect(ids.indexOf("settings-segment-form")).toBeLessThan(
      ids.indexOf("settings-segment-appearance")!,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-segment-appearance"));
    });
    expect(screen.getByTestId("settings-appearance")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-app-font")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-composed-font")).toBeInTheDocument();
  });
});

describe("spec 176 — composer toolbar hosts A−/A+", () => {
  it("places the composer scale control next to the preview toggle", () => {
    function Harness() {
      const [value, setValue] = useState("hi");
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
          {preview && <ComposerMarkdownPreview content={value} />}
        </div>
      );
    }
    render(<Harness />);
    const toolbar = screen.getByTestId("composer-format-toolbar");
    const preview = screen.getByTestId("composer-preview-toggle");
    const scale = screen.getByTestId("composer-font-scale");
    expect(toolbar.contains(preview)).toBe(true);
    expect(toolbar.contains(scale)).toBe(true);
    // Scale comes after preview in DOM order.
    expect(
      preview.compareDocumentPosition(scale) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

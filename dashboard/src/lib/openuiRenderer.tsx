/**
 * openUI renderer (HEAVY half) — the ONLY module that pulls the openUI runtime
 * into the browser. Loaded lazily via `React.lazy` from `./uiBlocks`, so a
 * conversation with no UI blocks never downloads d3/katex/radix or the widget
 * catalog.
 *
 * ## One catalog, one renderer
 *
 * The component catalog is the official `openuiLibrary` from
 * `@openuidev/react-ui` — every widget the library ships (tables, charts,
 * forms, buttons, tabs, …). There is NO hand-maintained allowlist: the backend
 * prompt is generated from this same library
 * (`dashboard/scripts/gen-openui-prompt.mjs` →
 * `sarathy/channels/dashboard/openui_prompt.txt`), so the model can never be
 * told about a component the UI cannot render.
 *
 * Rendering goes through the library's own `<Renderer>`. We do NOT hand-walk
 * the tree: openUI components use hooks (theme, layout, form context), so they
 * must be rendered as real React elements inside a render pass.
 *
 * ## Safety / degradation
 *
 * Model output is never injected as HTML. `open_url` actions are opened only
 * after `sanitizeUrl` approves them (http/https), so a block can never launch a
 * `javascript:` URL. If a block fails to parse, we render its raw source as a
 * code block rather than a half-empty card.
 */
import "@openuidev/react-ui/index.css";
import { createParser, Renderer, type Library, type ParseResult } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { ThemeProvider as OpenUIThemeProvider, type Theme } from "@openuidev/react-ui";
import { useMemo } from "react";

import { useTheme } from "@/lib/theme";
import { extractUIBlocks, sanitizeUrl, OPEN_URL, type UIBlockProps } from "@/lib/uiBlocks";

/** Component names in the catalog — derived from the library, never hand-listed. */
export const UI_BLOCK_COMPONENTS: readonly string[] = Object.keys(openuiLibrary.components);

/** The library instance. Exposed for tests; call sites use `<UIBlock>`. */
export function uiLibrary(): Library {
  return openuiLibrary;
}

export type UIBlockParse =
  | { kind: "ui"; source: string; result: ParseResult }
  | { kind: "markdown"; reason: string };

let cachedParser: ReturnType<typeof createParser> | null = null;

function uiParser() {
  if (!cachedParser) {
    cachedParser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
  }
  return cachedParser;
}

/**
 * Decide whether a message body should render as a typed UI block or markdown.
 *
 * Falls back to markdown unless the text parses to a root element with no
 * structural errors and no unresolved references. Deliberately strict: a
 * partially-broken block renders as its source rather than a silently-empty
 * card, because an empty bubble is a much worse failure than unstyled text.
 */
export function parseUI(text: string | null | undefined): UIBlockParse {
  if (!text || !text.trim()) return { kind: "markdown", reason: "empty" };

  const result = uiParser().parse(text);
  if (!result.root) return { kind: "markdown", reason: "no-root" };
  if (result.meta.incomplete) return { kind: "markdown", reason: "incomplete" };

  // Unresolved references are NOT in meta.errors — they land in meta.unresolved
  // and the missing child is silently dropped. Rendering that would show the
  // user an empty card, so treat it as a failure.
  if (result.meta.unresolved.length > 0) return { kind: "markdown", reason: "unresolved" };

  const errors = result.meta.errors ?? [];
  const structural = errors.some(
    (e) => e.code === "unknown-component" || e.code === "type-mismatch",
  );
  if (structural) return { kind: "markdown", reason: `error:${errors[0].code}` };

  return { kind: "ui", source: text, result };
}

/**
 * Brand token mapping. Values reference the dashboard's own CSS variables
 * (defined in `src/index.css`) so light/dark follow the app with no duplicate
 * palette.
 */
function brandTokens(): Theme {
  return {
    background: "var(--background)",
    foreground: "var(--card)",
    popoverBackground: "var(--popover)",
    invertedBackground: "var(--foreground)",

    textNeutralPrimary: "var(--foreground)",
    textNeutralSecondary: "var(--muted-foreground)",
    textBrand: "var(--primary)",

    borderDefault: "var(--border)",
    borderInteractive: "var(--border)",
    borderAccent: "var(--border)",
    borderAccentEmphasis: "var(--primary)",

    interactiveAccentDefault: "var(--primary)",
    interactiveAccentHover: "var(--primary)",
    interactiveAccentPressed: "var(--primary)",

    fontBody: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
  } as Theme;
}

/** Default export target for `React.lazy` in `./uiBlocks`. */
export default function OpenUIBlock({
  source,
  isStreaming,
  onSend,
  onAction,
}: UIBlockProps) {
  const { resolved } = useTheme();
  const parsed = useMemo(() => parseUI(source), [source]);

  if (parsed.kind !== "ui") {
    const raw = extractUIBlocks(source);
    return raw ? (
      <pre
        data-testid="ui-block-raw"
        className="mt-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-[11px] text-muted-foreground"
      >
        {raw}
      </pre>
    ) : null;
  }

  function handleAction(event: {
    type: string;
    params: Record<string, unknown>;
    humanFriendlyMessage: string;
  }) {
    onAction?.(event);
    if (onAction) return; // caller took ownership

    if (event.type === OPEN_URL) {
      const url = sanitizeUrl(event.params?.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const message = event.humanFriendlyMessage?.trim();
    if (message && onSend) onSend(message);
  }

  const tokens = brandTokens();
  return (
    <OpenUIThemeProvider mode={resolved} lightTheme={tokens} darkTheme={tokens} cssSelector="body">
      <div className="w-full" data-testid="ui-block">
        <Renderer
          response={extractUIBlocks(source) || source}
          library={openuiLibrary}
          isStreaming={isStreaming}
          onAction={handleAction}
        />
      </div>
    </OpenUIThemeProvider>
  );
}

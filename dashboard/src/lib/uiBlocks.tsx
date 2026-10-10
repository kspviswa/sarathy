/**
 * openUI adapter — the ONLY place in the dashboard that imports openUI.
 *
 * All openUI usage is funnelled through this file so the dependency can be
 * swapped or re-pinned without touching call sites. Nothing else under src/
 * may import `@openuidev/*` (enforced by `src/__tests__/uiBlocks.test.tsx`).
 *
 * ## Safety model
 *
 * The model may emit a fenced ```openui-lang block. We parse it against a
 * CURATED ALLOWLIST of components — never a generic HTML escape hatch. Every
 * component renders through a hand-written React element, so model output is
 * never injected as markup.
 *
 * Any block that fails to parse cleanly (unknown component, unresolved
 * reference, unparseable text) falls back to rendering the message as plain
 * markdown, exactly as it did before openUI existed. Pure-text replies must
 * NEVER regress to a blank bubble — that is the whole reason `parseUI` exists
 * rather than just calling `<Renderer>` directly (the Renderer returns `null`
 * for prose).
 *
 * URLs are sanitised to http/https only: a `javascript:` href is a stored-XSS
 * vector even without raw HTML rendering.
 *
 * The component catalog here must stay in sync with
 * `sarathy/channels/dashboard/uiblocks.py` (the system-prompt source of
 * truth). `UI_BLOCK_COMPONENTS` mirrors `UI_BLOCK_COMPONENTS` there, and a
 * Python test asserts the names line up.
 */
import { z } from "zod";
import {
  createLibrary,
  createParser,
  defineComponent,
  type Library,
  type ParseResult,
} from "@openuidev/react-lang";

/** Component names in the curated catalog. Mirrors the backend allowlist. */
export const UI_BLOCK_COMPONENTS = [
  "Root",
  "Heading",
  "Text",
  "KeyValues",
  "Steps",
  "Callout",
  "LinkList",
  "CodeBlock",
] as const;

export type UIBlockComponent = (typeof UI_BLOCK_COMPONENTS)[number];

/**
 * Allow only absolute http(s) URLs.
 *
 * Returns null for anything else (`javascript:`, `data:`, `vbscript:`,
 * relative or malformed). Callers must drop the link rather than render an
 * un-href'd anchor, which would still be a bad look and could confuse AT.
 */
export function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Guard against control characters used to smuggle a scheme past the parser.
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return parsed.toString();
}

const labelValueSchema = z.object({
  label: z.string().optional(),
  value: z.string().optional(),
});

const stepSchema = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
});

const linkSchema = z.object({
  label: z.string().optional(),
  href: z.string().optional(),
});

/**
 * Build the openUI component library (the allowlist).
 *
 * Built lazily and memoised: `createLibrary` mints an id and walks every zod
 * schema, and this module is imported on first paint. Doing it at module scope
 * would also make a malformed schema throw during app boot.
 */
let cachedLibrary: Library | null = null;

export function uiLibrary(): Library {
  if (cachedLibrary) return cachedLibrary;

  const Heading = defineComponent({
    name: "Heading",
    description: "A section heading.",
    props: z.object({
      text: z.string(),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    }),
    component: ({ props: { text, level } }) => {
      const Tag = (level === 1 ? "h3" : level === 3 ? "h5" : "h4") as "h3";
      return (
        <Tag className="mb-1.5 mt-3 font-semibold leading-tight text-foreground first:mt-0">
          {text}
        </Tag>
      );
    },
  });

  const Text = defineComponent({
    name: "Text",
    description: "Renders plain text.",
    props: z.object({
      text: z.string(),
      muted: z.boolean().optional(),
    }),
    component: ({ props: { text, muted } }) => (
      <p className={muted ? "text-muted-foreground" : "text-foreground"}>{text}</p>
    ),
  });

  const KeyValues = defineComponent({
    name: "KeyValues",
    description: "Label/value pairs rendered as a compact table.",
    props: z.object({ items: z.array(labelValueSchema) }),
    component: ({ props: { items } }) => (
      <dl className="my-1 divide-y divide-border overflow-hidden rounded-lg border border-border">
        {items.map((item, i) => (
          <div key={i} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
            <dt className="w-1/3 shrink-0 text-muted-foreground">{item.label ?? ""}</dt>
            <dd className="min-w-0 flex-1 break-words font-medium text-foreground">
              {item.value ?? ""}
            </dd>
          </div>
        ))}
      </dl>
    ),
  });

  const Steps = defineComponent({
    name: "Steps",
    description: "An ordered list of steps.",
    props: z.object({ items: z.array(stepSchema) }),
    component: ({ props: { items } }) => (
      <ol className="my-1 space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2.5 text-sm">
            <span className="mt-0.5 flex size-5 shrink-0 select-none items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{item.title ?? ""}</span>
              {item.detail && (
                <span className="mt-0.5 block text-muted-foreground">{item.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    ),
  });

  const Callout = defineComponent({
    name: "Callout",
    description: "A single highlighted aside.",
    props: z.object({
      text: z.string(),
      tone: z.enum(["info", "warning", "success", "danger"]).optional(),
    }),
    component: ({ props: { text, tone } }) => {
      const tones: Record<string, string> = {
        info: "border-sky-500/30 bg-sky-500/10 text-sky-900 dark:text-sky-100",
        warning: "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100",
        success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100",
        danger: "border-destructive/30 bg-destructive/10 text-destructive",
      };
      return (
        <div
          className={`my-1 rounded-lg border px-3 py-2 text-sm ${tones[tone ?? "info"] ?? tones.info}`}
        >
          {text}
        </div>
      );
    },
  });

  const LinkList = defineComponent({
    name: "LinkList",
    description: "A list of links.",
    props: z.object({ items: z.array(linkSchema) }),
    component: ({ props: { items } }) => {
      // Drop unsafe hrefs rather than rendering a dead/hostile anchor.
      const safe = items
        .map((item) => ({ ...item, href: sanitizeUrl(item.href) }))
        .filter((item): item is { label?: string; href: string } => item.href !== null);
      if (!safe.length) return null;
      return (
        <ul className="my-1 space-y-1">
          {safe.map((item, i) => (
            <li key={i}>
              <a
                href={item.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-primary underline underline-offset-2 hover:opacity-80"
              >
                {item.label || item.href}
              </a>
            </li>
          ))}
        </ul>
      );
    },
  });

  const CodeBlock = defineComponent({
    name: "CodeBlock",
    description: "Preformatted code.",
    props: z.object({
      code: z.string(),
      language: z.string().optional(),
    }),
    component: ({ props: { code, language } }) => (
      <pre className="my-1 overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 text-xs">
        {language && (
          <span className="mb-1 block font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
            {language}
          </span>
        )}
        <code className="font-mono text-foreground">{code}</code>
      </pre>
    ),
  });

  // `Root` is the top-level container. Its `children` accepts any catalog
  // component: unknown-component detection is done by the parser against the
  // library registry, so a loose element schema costs nothing in safety and
  // avoids a circular type reference (and a TDZ error at build time).
  const Root = defineComponent({
    name: "Root",
    description: "Top-level container for a UI block.",
    props: z.object({
      children: z.array(z.any()),
      title: z.string().optional(),
    }),
    component: ({ props: { children, title } }) => (
      <section
        data-testid="ui-block"
        aria-label={title}
        className="my-1 overflow-hidden rounded-xl border border-border bg-card/40 p-3"
      >
        {title && <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>}
        <div className="space-y-2">{children}</div>
      </section>
    ),
  });

  cachedLibrary = createLibrary({
    components: [Root, Heading, Text, KeyValues, Steps, Callout, LinkList, CodeBlock],
    root: "Root",
    id: "sarathy-dashboard",
  });
  return cachedLibrary;
}

let cachedParser: ReturnType<typeof createParser> | null = null;

function uiParser() {
  if (!cachedParser) {
    const library = uiLibrary();
    // createParser takes the JSON schema, NOT the Library object.
    cachedParser = createParser(library.toJSONSchema(), library.root);
  }
  return cachedParser;
}

export type UIBlockParse =
  /** A trusted, fully-resolved UI block. Render with `<UIBlock>`. */
  | { kind: "ui"; source: string; result: ParseResult }
  /** Not renderable as UI — render `source` as markdown instead. */
  | { kind: "markdown"; reason: string };

/**
 * Decide whether a message body should render as a typed UI block or markdown.
 *
 * Falls back to markdown unless the text contains a fenced UI block that parses
 * to a root element with no errors. Deliberately strict: a partially-broken
 * block renders as its source markdown rather than a half-empty card, because
 * a silently-empty bubble is a much worse failure than an unstyled list.
 */
export function parseUI(text: string | null | undefined): UIBlockParse {
  if (!text || !text.trim()) return { kind: "markdown", reason: "empty" };

  const result = uiParser().parse(text);
  if (!result.root) return { kind: "markdown", reason: "no-root" };
  if (result.meta.incomplete) return { kind: "markdown", reason: "incomplete" };

  // An unresolved reference is NOT reported in meta.errors by the parser — it
  // lands in meta.unresolved and the missing child is silently dropped as null.
  // Rendering that would show the user an empty card, so treat it as a failure
  // and fall back to markdown.
  if (result.meta.unresolved.length > 0) {
    return { kind: "markdown", reason: "unresolved" };
  }

  const errors = result.meta.errors ?? [];
  if (errors.length > 0) {
    // While streaming a block, transient missing-prop errors are expected; only
    // a structural failure should force the markdown path.
    const structural = errors.some(
      (e) => e.code === "unknown-component" || e.code === "type-mismatch",
    );
    if (structural) {
      const first = errors[0];
      return { kind: "markdown", reason: `error:${first.code}` };
    }
  }
  return { kind: "ui", source: text, result };
}

/** Extract the fenced block(s) so prose can be rendered alongside UI. */
export function extractProse(text: string): string[] {
  // Keep fenced regions out of the prose output; they are rendered as UI.
  return text
    .split(/```[\w-]*\n?[\s\S]*?```/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Minimal structural view of a parsed openUI element.
 *
 * We walk the tree ourselves rather than delegating to openUI's `<Renderer>`:
 * the Renderer materialises its tree inside an effect (it is client-only and
 * paints an empty shell during SSR/hydration), which makes it untestable and
 * adds a second parse of the same text. Rendering directly gives us one parse,
 * a synchronous tree, and full control over how unknown nodes degrade.
 */
interface UIElementNode {
  type: "element";
  typeName: string;
  props?: Record<string, unknown>;
  partial?: boolean;
  statementId?: string;
}

function asElement(value: unknown): UIElementNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as UIElementNode;
  return node.type === "element" && typeof node.typeName === "string" ? node : null;
}

/**
 * Recursively render one parsed element.
 *
 * A component missing from the allowlist renders as null (dropped), which is the
 * same degradation openUI applies. `parseUI` normally rejects the whole block
 * before we get here, so this is defence in depth.
 */
function renderNode(value: unknown, library: Library): React.ReactNode {
  const node = asElement(value);
  if (!node) return null;

  const component = library.components[node.typeName];
  if (!component || typeof component.component !== "function") return null;

  const props: Record<string, unknown> = { ...(node.props ?? {}) };
  const children = props.children;
  if (Array.isArray(children)) {
    props.children = children
      .map((child) => renderNode(child, library))
      .filter((child) => child !== null && child !== undefined);
  }

  try {
    return component.component({
      props,
      renderNode: (v: unknown) => renderNode(v, library),
      statementId: node.statementId,
    } as never);
  } catch {
    // A single malformed subtree must not blank the whole message.
    return null;
  }
}

/**
 * Render an already-validated UI block.
 *
 * Callers must gate on `parseUI(...).kind === "ui"` first. Streaming is handled
 * upstream: the adapter re-parses on every cumulative chunk, so children reveal
 * progressively without any special casing here.
 */
export function UIBlock({ result }: { result: ParseResult }) {
  const library = uiLibrary();
  const rendered = renderNode(result.root, library);
  return <>{rendered}</>;
}
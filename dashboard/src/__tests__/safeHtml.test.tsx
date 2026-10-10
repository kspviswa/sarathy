/**
 * Spec 126 §C — the dashboard must render a *safe* HTML subset, not literal tags.
 *
 * Job-monitor pings are Telegram HTML (`<b>`, `<a href>`). With a markdown-only
 * pipeline they escaped to visible text ("code chunk"). `rehype-raw` +
 * `rehype-sanitize` fix that, but the content is relay/LLM output, so the
 * sanitization half is a security requirement, not a nicety: everything below
 * the "strips" section is a regression guard against the fix re-opening an
 * injection hole.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { SAFE_HTML_SCHEMA, SAFE_REHYPE_PLUGINS } from "@/lib/markdown";

function render(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={SAFE_REHYPE_PLUGINS}>
      {md}
    </ReactMarkdown>,
  );
}

/** Exactly the ping `jobctl.py build_ping_html()` emits. */
const JOB_PING =
  "<b>Job 126 [feature]</b> — completed\n" +
  "All tests green.\n\n" +
  '<a href="https://skandpriya.com/dashboard/#/jobs/126">Open in dashboard</a>';

describe("job ping renders as bold + a real link", () => {
  it("does not escape the tags to literal text", () => {
    const html = render(JOB_PING);
    expect(html).not.toContain("&lt;b&gt;");
    expect(html).not.toContain("&lt;a href");
  });

  it("renders the bold header as a <b> element", () => {
    expect(render(JOB_PING)).toContain("<b>Job 126 [feature]</b>");
  });

  it("renders the deep link as a clickable anchor with its href", () => {
    expect(render(JOB_PING)).toContain(
      '<a href="https://skandpriya.com/dashboard/#/jobs/126">Open in dashboard</a>',
    );
  });

  it("supports the inline subset jobctl emits", () => {
    const html = render("<i>a</i> <em>b</em> <strong>c</strong><br/>next");
    expect(html).toContain("<i>a</i>");
    expect(html).toContain("<em>b</em>");
    expect(html).toContain("<strong>c</strong>");
    expect(html).toContain("<br/>");
  });
});

describe("sanitization strips everything outside the allowlist", () => {
  it("removes script tags and their contents", () => {
    const html = render("<script>alert(1)</script>safe");
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("safe");
  });

  it("removes inline event handlers but keeps the safe element", () => {
    const html = render('<img src="https://x.com/a.png" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert");
    expect(html).toContain("https://x.com/a.png");
  });

  it("drops javascript: hrefs", () => {
    const html = render('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("drops data: hrefs", () => {
    const html = render('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("alert(1)");
  });

  it("drops non-http(s) schemes outright (mailto)", () => {
    expect(render('<a href="mailto:a@b.c">x</a>')).not.toContain("mailto:");
  });

  it("keeps http and https hrefs", () => {
    expect(render('<a href="http://a.test/x">x</a>')).toContain("http://a.test/x");
    expect(render('<a href="https://a.test/x">x</a>')).toContain("https://a.test/x");
  });

  it("removes iframes", () => {
    expect(render('<iframe src="https://evil.test"></iframe>')).not.toContain("iframe");
  });

  it("removes svg animation event handlers", () => {
    const html = render('<svg><animate onbegin="alert(1)"/></svg>');
    expect(html).not.toContain("onbegin");
    expect(html).not.toContain("alert");
  });

  it("removes style blocks", () => {
    expect(render("<style>body{display:none}</style>ok")).not.toContain("display:none");
  });

  it("removes form controls", () => {
    const html = render('<form action="/x"><input name="p"/></form>');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  it("does not let raw HTML smuggle a target attribute", () => {
    const html = render('<a href="https://a.test" target="_top">x</a>');
    expect(html).not.toContain("_top");
  });
});

describe("markdown rendering is unchanged by the HTML pipeline", () => {
  it("still renders GFM tables", () => {
    expect(render("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("<table>");
  });

  it("still renders fenced code blocks with their language class", () => {
    const html = render("```py\nprint(1)\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("language-py");
  });

  it("still renders bold and emphasis", () => {
    expect(render("**b** and *e*")).toContain("<strong>b</strong>");
  });

  it("still renders markdown images", () => {
    expect(render("![alt](https://x.com/a.png)")).toContain('<img');
  });

  it("still renders lists and links", () => {
    expect(render("- one\n- two")).toContain("<li>");
    expect(render("[t](https://a.test)")).toContain('<a href="https://a.test"');
  });
});

describe("the allowlist itself", () => {
  it("permits only http/https schemes", () => {
    expect(SAFE_HTML_SCHEMA.protocols?.href).toEqual(["http", "https"]);
    expect(SAFE_HTML_SCHEMA.protocols?.src).toEqual(["http", "https"]);
  });

  it("grants no global attributes, so no event handler can survive", () => {
    expect(SAFE_HTML_SCHEMA.attributes?.["*"]).toEqual([]);
  });

  it("allows only href on anchors", () => {
    expect(SAFE_HTML_SCHEMA.attributes?.a).toEqual(["href"]);
  });

  it("strips executable tags", () => {
    expect(SAFE_HTML_SCHEMA.strip).toContain("script");
    expect(SAFE_HTML_SCHEMA.strip).toContain("style");
  });
});
import { useMemo } from "react";
import type { Components } from "react-markdown";

import { CodeBlock } from "@/components/CodeBlock";
import { MarkdownBubble } from "@/components/MarkdownBubble";
import {
  ASK_CITE_PREFIX,
  preprocessAskCitations,
  type AskSource,
} from "@/lib/ask";
import { MD_COMPONENTS, SafeLink } from "@/lib/markdown";
import { extractProse, hasOpenUIBlock, UIBlock } from "@/lib/uiBlocks";

/**
 * The Ask answer — REAL markdown, with the citation pills intact.
 *
 * Complaint #4 was that the Ask tab printed the raw markdown source: a
 * heading showed as `# Heading`, a table as pipes and dashes. The chat
 * already solved this (`MarkdownBubble` + `MD_COMPONENTS` +
 * `SAFE_REHYPE_PLUGINS`), so this reuses that pipeline instead of writing a
 * second renderer.
 *
 * The ONE thing markdown does not know about is the engine's `[n]` citation
 * marker. Uttaram solves it the same way (see `useChat.tsx`): the marker is
 * rewritten into a markdown link with a sentinel href BEFORE the markdown is
 * parsed, and the link renderer turns the sentinel back into a pill that
 * points at the matching source.
 */
export function AskAnswer({
  answer,
  sources,
  isStreaming = false,
  onSend,
}: {
  answer: string;
  sources: AskSource[];
  /** Let a partially-arrived openUI block render progressively. */
  isStreaming?: boolean;
  /** A widget button's follow-up question starts the next Ask turn. */
  onSend?: (message: string) => void;
}) {
  // The same cheap fence gate ChatView uses, so a plain answer never pays for
  // the heavy lazy renderer. When a block IS present, prose is split out FIRST
  // and citation markers are rewritten per chunk — a `[n]` inside a widget
  // body must stay part of the widget source, not become a pill.
  const hasUI = useMemo(() => hasOpenUIBlock(answer), [answer]);
  const chunks = useMemo(
    () =>
      (hasUI ? extractProse(answer) : [answer]).map((chunk) =>
        preprocessAskCitations(chunk),
      ),
    [answer, hasUI],
  );

  const components = useMemo<Components>(
    () => ({
      ...MD_COMPONENTS,
      a: ({ href, children, ...props }) => {
        const match =
          typeof href === "string"
            ? new RegExp(`^${ASK_CITE_PREFIX}(\\d{1,3})$`).exec(href)
            : null;

        // Not one of ours — an ordinary markdown link.
        if (!match) {
          return (
            <SafeLink href={href} {...props}>
              {children}
            </SafeLink>
          );
        }

        const idx = Number(match[1]);
        const source = sources.find((item) => item.idx === idx);

        // A marker with no matching source stays plain text — the writer
        // cited something the backend never sent.
        if (!source) {
          return <span>{`[${idx}]`}</span>;
        }

        return (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            data-testid={`ask-citation-${idx}`}
            className="mx-0.5 rounded bg-primary/10 px-1 text-[0.8em] font-semibold text-primary no-underline hover:bg-primary/20"
          >
            {`[${idx}]`}
          </a>
        );
      },
      code: ({ children, className, ...props }) => {
        const isBlock = className?.startsWith("language-");
        if (isBlock) {
          return (
            <CodeBlock className={className}>
              {String(children)}
            </CodeBlock>
          );
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
    }),
    [sources],
  );

  return (
    <div className="flex flex-col gap-2">
      <div data-testid="ask-answer-markdown">
        {chunks.map((chunk, i) => (
          <MarkdownBubble key={i} content={chunk} components={components} />
        ))}
      </div>
      {hasUI && (
        <div data-testid="ask-answer-block">
          <UIBlock source={answer} isStreaming={isStreaming} onSend={onSend} />
        </div>
      )}
    </div>
  );
}

export default AskAnswer;

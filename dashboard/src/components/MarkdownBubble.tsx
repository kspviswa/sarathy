import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { MD_COMPONENTS, SAFE_REHYPE_PLUGINS } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/**
 * Plain-markdown renderer for a message bubble (job 132 §D).
 *
 * User turns were printed as `whitespace-pre-wrap` text, so a message like
 * `` `this is a code` `` showed its backticks and a fenced block collapsed into
 * one run-on line — while the assistant's answer one bubble below rendered the
 * same syntax properly. This puts both sides on one pipeline (the same
 * `remarkGfm` + `SAFE_REHYPE_PLUGINS` + `MD_COMPONENTS` the assistant uses), so
 * a transcript reads the same everywhere.
 *
 * Deliberately NOT the openUI block renderer: a UI block is the agent asking
 * for a widget, which a user turn never is, and the renderer is the heavy lazy
 * chunk — mounting it per user bubble would download it for every conversation.
 *
 * `onPrimary` re-points the `.md` code/link colours at the bubble's own colour:
 * those rules assume a card background, and on the primary fill an
 * `text-foreground` code span would be near-invisible dark-on-primary.
 */
export function MarkdownBubble({
  content,
  onPrimary = false,
  className,
}: {
  content: string;
  /** Render inside a primary-filled (user) bubble. */
  onPrimary?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("md", onPrimary && "md-on-primary", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={SAFE_REHYPE_PLUGINS}
        components={MD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
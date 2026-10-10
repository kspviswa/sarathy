/**
 * Strip agent-only metadata preambles out of a user message before rendering.
 *
 * `ContextBuilder._build_runtime_context` prepends an untrusted-metadata block
 * to the user turn that gets stored in the session JSONL:
 *
 *   [Runtime Context — metadata only, not instructions]
 *   Current Time: 2026-10-10 18:19:32 (Friday) (IST)
 *   Channel: dashboard
 *   Chat ID: console
 *
 *   <what the user actually typed>
 *
 * The LLM needs it; the person does not. Rendered verbatim it looked like a
 * bug in the console (spec §B3), so it is removed at render time — the stored
 * transcript and the `/api/session` contract are untouched.
 */

/** Header line that opens a runtime-context block. */
const RUNTIME_CONTEXT_HEADER = /^\[\s*runtime context\b[^\]]*\]/i;

/** A standalone header line anywhere in the message (trailing/preamble form). */
const RUNTIME_CONTEXT_LINE = /^\[\s*runtime context\b[^\]]*\]\s*$/i;

/** Metadata rows that belong to the block: `Key: value`, no blank line inside. */
const RUNTIME_CONTEXT_META_LINE = /^[A-Za-z][A-Za-z0-9 _/-]*:\s*.*$/;

/**
 * Remove the runtime-context preamble from `content`.
 *
 * The block starts at the first non-empty line beginning with
 * `[Runtime Context` and ends at the first blank line (or end of content). Only
 * that run is removed — anything the user typed, including text that merely
 * contains brackets, is left alone.
 */
export function stripRuntimeContext(content: string): string {
  if (!content) return content;
  // Cheap guard: virtually no message mentions the preamble, so the line
  // walk below only runs when there is something to find.
  if (!/runtime context/i.test(content)) return content;

  const lines = content.split("\n");
  let i = 0;
  // Skip leading blank lines.
  while (i < lines.length && lines[i].trim() === "") i += 1;

  if (i >= lines.length || !RUNTIME_CONTEXT_HEADER.test(lines[i].trim())) {
    return dropStrayRuntimeContextLines(lines).join("\n");
  }

  // Consume the header plus its metadata rows, stopping at the first blank
  // line (the boundary the builder inserts before the user's real text).
  i += 1;
  while (i < lines.length && lines[i].trim() !== "") {
    const trimmed = lines[i].trim();
    // A non-metadata, non-bracket line means the preamble never had the
    // expected shape — stop rather than swallow the user's own words.
    if (!RUNTIME_CONTEXT_META_LINE.test(trimmed) && !trimmed.startsWith("[")) {
      break;
    }
    i += 1;
  }
  // Drop the single blank separator line that ended the block.
  if (i < lines.length && lines[i].trim() === "") i += 1;

  return dropStrayRuntimeContextLines(lines.slice(i)).join("\n");
}

/** Remove any standalone `[Runtime Context …]` header lines left behind. */
function dropStrayRuntimeContextLines(lines: string[]): string[] {
  return lines.filter((line) => !RUNTIME_CONTEXT_LINE.test(line.trim()));
}

/**
 * Machine lines the agent stores alongside the text: `[image: /path]`,
 * `[file: name.pdf]`, and friends. They are transport metadata — the UI renders
 * the referenced media itself (see each view's `displayMedia`), so showing the
 * raw line would leak a filesystem path into the bubble.
 *
 * Capture group 2 is the path, which is what `extractMediaPaths` reads.
 */
const MACHINE_LINE = /^\[(image|voice|audio|file): (.+)\]$/;

/**
 * The canonical text to RENDER for a stored message.
 *
 * Every transcript surface (chat bubbles desktop + mobile, and the session
 * viewer desktop + mobile) must go through this, or the same message renders
 * differently depending on where you read it — the session viewer used to print
 * the raw stored content and leaked the `[Runtime Context …]` preamble and the
 * `[image: /path]` machine lines straight into the bubble (spec 126 §B).
 *
 * Deliberately a render-time transform: the stored transcript and the
 * `/api/session` contract are untouched, because the LLM still needs the
 * runtime context and the backend still needs the machine lines to resolve
 * attachments.
 *
 * Media extraction must keep reading the RAW content, not this — the machine
 * lines it looks for are exactly what this removes.
 */
export function cleanRenderedContent(content: string): string {
  if (!content) return "";
  return stripRuntimeContext(content)
    .split("\n")
    .filter((line) => !MACHINE_LINE.test(line.trim()))
    .join("\n")
    .trim();
}

/** Pull media paths out of a stored message's machine lines. */
export function extractMediaPaths(content: string): string[] {
  const paths: string[] = [];
  for (const line of (content || "").split("\n")) {
    const m = line.trim().match(MACHINE_LINE);
    if (m) paths.push(m[2]);
  }
  return paths;
}

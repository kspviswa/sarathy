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

/**
 * Markdown wrap/insert helpers for the composer formatting toolbar (spec 175 §C).
 */

export type FormatAction = "bold" | "italic" | "code" | "list" | "link";

export interface FormatResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const WRAP: Record<"bold" | "italic" | "code", { before: string; after: string; placeholder: string }> = {
  bold: { before: "**", after: "**", placeholder: "bold" },
  italic: { before: "*", after: "*", placeholder: "italic" },
  code: { before: "`", after: "`", placeholder: "code" },
};

/**
 * Apply a formatting action around the current selection (or at the caret).
 * Returns the new value and the selection to restore after focus.
 */
export function applyFormatAction(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: FormatAction,
): FormatResult {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const selected = value.slice(start, end);

  if (action === "list") {
    if (selected.includes("\n") || selected.length > 0) {
      const lines = selected.split("\n");
      const formatted = lines
        .map((line) => (line.startsWith("- ") ? line : `- ${line || "item"}`))
        .join("\n");
      return {
        value: value.slice(0, start) + formatted + value.slice(end),
        selectionStart: start,
        selectionEnd: start + formatted.length,
      };
    }
    const insert = "- ";
    return {
      value: value.slice(0, start) + insert + value.slice(end),
      selectionStart: start + insert.length,
      selectionEnd: start + insert.length,
    };
  }

  if (action === "link") {
    if (selected) {
      const wrapped = `[${selected}](url)`;
      const urlStart = start + selected.length + 3; // after "]("
      return {
        value: value.slice(0, start) + wrapped + value.slice(end),
        selectionStart: urlStart,
        selectionEnd: urlStart + 3,
      };
    }
    const insert = "[text](url)";
    return {
      value: value.slice(0, start) + insert + value.slice(end),
      selectionStart: start + 1,
      selectionEnd: start + 5,
    };
  }

  const { before, after, placeholder } = WRAP[action];
  if (selected) {
    const wrapped = `${before}${selected}${after}`;
    return {
      value: value.slice(0, start) + wrapped + value.slice(end),
      selectionStart: start + before.length,
      selectionEnd: start + before.length + selected.length,
    };
  }
  const insert = `${before}${placeholder}${after}`;
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    selectionStart: start + before.length,
    selectionEnd: start + before.length + placeholder.length,
  };
}

/**
 * Quote-and-ask: selection → chip → payload.
 *
 * Selecting text in an assistant message offers "Add to follow-up", which drops
 * a dismissible `@`-prefixed chip above the composer. Multiple selections are
 * allowed and the whole set travels with the next message as
 * `quotes: [{text, source_message_id, source_role}]`.
 *
 * Kept as pure functions + a small reducer so the chip lifecycle is testable
 * without a DOM.
 */

export interface Quote {
  text: string;
  source_message_id?: string;
  source_role?: "user" | "assistant";
}

/** Display cap for a chip; the full text still travels in the payload. */
export const QUOTE_CHIP_MAX = 120;
/** Guard rails matching the backend's MAX_QUOTES / MAX_QUOTE_CHARS. */
export const MAX_QUOTES = 12;
export const MAX_QUOTE_CHARS = 2000;

let counter = 0;
/** Stable chip id — separate from the quoted text so duplicate selections of
 *  the same passage can be removed independently. */
function nextId(): string {
  counter += 1;
  return `q${counter}`;
}

/** Reset the id counter (tests). */
export function __resetQuoteIds(): void {
  counter = 0;
}

/**
 * Build a Quote from a DOM Selection.
 *
 * Returns null when the selection is empty, whitespace-only, or too long to be
 * meaningful. Returns null for selections inside our own UI chrome (a chip or
 * the action bar) so clicking one does not create a quote of a quote.
 */
export function quoteFromSelection(
  selection: Selection | null,
  opts: { sourceMessageId?: string; sourceRole?: "user" | "assistant" } = {},
): Quote | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > MAX_QUOTE_CHARS) return null;

  return {
    text,
    ...(opts.sourceMessageId ? { source_message_id: opts.sourceMessageId } : {}),
    ...(opts.sourceRole ? { source_role: opts.sourceRole } : {}),
  };
}

/** One chip in the composer. */
export interface QuoteChip {
  id: string;
  text: string;
  source_message_id?: string;
  source_role?: "user" | "assistant";
}

export function chipLabel(chip: QuoteChip): string {
  const flat = chip.text.replace(/\s+/g, " ").trim();
  const clipped =
    flat.length > QUOTE_CHIP_MAX ? `${flat.slice(0, QUOTE_CHIP_MAX)}…` : flat;
  return `@${clipped}`;
}

/**
 * Add a quote as a chip.
 *
 * De-duplicates by text: quoting the same passage twice adds nothing to the
 * model's context and just clutters the composer.
 */
export function addQuote(chips: QuoteChip[], quote: Quote): QuoteChip[] {
  const normalized = quote.text.replace(/\s+/g, " ").trim();
  if (!normalized) return chips;
  if (chips.some((c) => c.text.replace(/\s+/g, " ").trim() === normalized)) return chips;
  const next = [...chips, { id: nextId(), ...quote }];
  return next.length > MAX_QUOTES ? next.slice(next.length - MAX_QUOTES) : next;
}

/** Remove one chip by id. */
export function removeQuote(chips: QuoteChip[], id: string): QuoteChip[] {
  return chips.filter((c) => c.id !== id);
}

/** Drop every chip. */
export function clearQuotes(): QuoteChip[] {
  return [];
}

/**
 * Build the `quotes` payload for `POST /api/chat`.
 *
 * Returns [] when there are no chips so the field is omitted entirely rather
 * than sent as an empty array.
 */
export function buildQuotesPayload(chips: QuoteChip[]): Quote[] {
  return chips.map(({ text, source_message_id, source_role }) => ({
    text: text.slice(0, MAX_QUOTE_CHARS),
    ...(source_message_id ? { source_message_id } : {}),
    ...(source_role ? { source_role } : {}),
  }));
}

/** True when there is something to send. */
export function hasQuotes(chips: QuoteChip[]): boolean {
  return chips.length > 0;
}
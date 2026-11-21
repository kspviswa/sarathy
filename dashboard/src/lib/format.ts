/**
 * Compact token-count formatting shared by the usage surfaces (UsageCard,
 * UsageFooter). One implementation so the card and the footer can never
 * disagree about how a number is abbreviated.
 *
 * Scales: B (billions) → M (millions) → K/k (thousands) → raw. The card shows
 * an uppercase "K" and the footer a lowercase "k" (existing convention), so the
 * suffix is a parameter; the B/M branches are identical for both.
 */
export function formatTokens(n: number, kUnit: "k" | "K" = "k"): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}${kUnit}`;
  return String(n);
}

/**
 * Command palette + `/` autocomplete filtering.
 *
 * The command list is fetched from `GET /api/commands` (never hardcoded), so
 * the palette can never advertise a command the agent does not implement.
 */

export interface SlashCommand {
  name: string;
  description: string;
  subcommands: string[];
  hasStatus: boolean;
}

/**
 * Fuzzy subsequence match.
 *
 * Subsequence rather than substring so "/mdl" still finds "model" — that is
 * what makes the palette feel native. Returns a score (higher = better, null =
 * no match) so results can be ranked rather than merely filtered.
 *
 * Scoring rewards: consecutive runs, matches at word boundaries, and matches
 * early in the string, which is what users expect from a command palette.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (!t) return null;

  let score = 0;
  let ti = 0;
  let lastMatch = -1;

  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null; // not a subsequence
    score += 1;
    if (found === lastMatch + 1) score += 3; // consecutive bonus
    if (found === 0) score += 2; // prefix bonus
    // Word-boundary bonus: preceded by nothing, a space, / or _.
    const prev = found > 0 ? t[found - 1] : "";
    if (prev === "" || prev === " " || prev === "/" || prev === "_") score += 2;
    lastMatch = found;
    ti = found + 1;
  }

  // Prefer shorter targets when scores tie ("help" over "providerHelp").
  return score - t.length * 0.01;
}

/**
 * Filter + rank commands for the palette.
 *
 * A query matches against both the command name and its description, so
 * "usage" finds /context and "model" finds /model. Name matches outrank
 * description matches so typing a command name always floats it to the top.
 */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
  limit = 50,
): SlashCommand[] {
  const q = query.trim();
  if (!q) return commands.slice(0, limit);

  const nameMatches: { cmd: SlashCommand; score: number }[] = [];
  const descMatches: { cmd: SlashCommand; score: number }[] = [];

  for (const cmd of commands) {
    const nameScore = fuzzyScore(q, cmd.name);
    if (nameScore !== null) {
      nameMatches.push({ cmd, score: nameScore });
      continue; // don't also index the description for a name hit
    }
    const descScore = fuzzyScore(q, cmd.description);
    if (descScore !== null) descMatches.push({ cmd, score: descScore });
  }

  const byScore = (a: { score: number }, b: { score: number }) => b.score - a.score;
  nameMatches.sort(byScore);
  descMatches.sort(byScore);

  return [...nameMatches, ...descMatches].slice(0, limit).map((m) => m.cmd);
}

/**
 * Autocomplete for a `/token` being typed in the composer.
 *
 * Only matches the command name (not descriptions) and only for the first
 * whitespace-separated token — completing a subcommand path like `/model set`
 * is out of scope and would fight the user's actual typing.
 */
export function completeSlashCommands(
  commands: SlashCommand[],
  token: string,
  limit = 8,
): SlashCommand[] {
  const q = token.replace(/^\//, "").toLowerCase();
  if (!q) return commands.slice(0, limit);

  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) starts.push(cmd);
    else if (name.includes(q)) contains.push(cmd);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** True when the composer should show the `/` menu for this input. */
export function shouldSuggestSlash(input: string): boolean {
  // Only at the very start, and only for a single token with no space yet.
  return /^\/[^\s]*$/.test(input.trim()) && input.trimStart().startsWith("/");
}
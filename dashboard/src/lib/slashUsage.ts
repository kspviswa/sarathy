/**
 * Slash-command usage parsing for the dashboard SPAs (spec 137 §A).
 *
 * The gateway keeps replying to a bare slash command with its plain-text help
 * block. NOTHING here changes that contract — this module is a pure, render-time
 * transform that recognises the existing wire shapes and turns them into a
 * structure a rich usage card can render.
 *
 * Rules the whole module obeys:
 *   - a parser NEVER throws; unrecognised text yields `null`;
 *   - a parser NEVER false-positives on ordinary prose (structural anchors like
 *     `📖 /x —`, `Subcommands:` and `Usage: /x` must ALL be present);
 *   - detection + the per-command design map live HERE, in one module, because
 *     desktop and mobile rendering the same reply differently is how surfaces
 *     drift.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One tappable option of a command (its subcommand value + display label). */
export interface UsageOption {
  value: string;
  label: string;
}

/** The `📖 /<name> — <desc>` + `Usage:` + `Subcommands:` help block. */
export interface ParsedUsage {
  name: string;
  description: string;
  options: UsageOption[];
}

/** The `🪆 Available commands:` block. */
export interface ParsedCommandList {
  commands: { name: string; description: string }[];
}

/** One row of the `Configured providers:` block. */
export interface ParsedProviderRow {
  name: string;
  active: boolean;
}

/** One assignable row of the `🎭 Provider roles:` block. */
export interface ParsedRoleRow {
  role: string;
  provider: string;
  model: string | null;
}

/** One labelled `Key: value` status line. */
export interface ParsedKeyValueRow {
  key: string;
  value: string;
}

/** The `📦 Models available on '<p>':` / `📦 Models on '<p>':` block. */
export interface ParsedModelBlock {
  provider: string;
  /** `true` for `/model list` (rows send `/model set <name>`). */
  fromModelCommand: boolean;
  models: string[];
}

/** A `Usage: /<name> …` notice, plus any `Example:` / `Current:` lines. */
export interface ParsedPromptUsage {
  command: string;
  usage: string;
  examples: string[];
  /** Live value the reply reported (`Current: on`), when it carries one. */
  current?: string | null;
}

/** What kind of card the matched text renders as. */
export type UsageMatchKind =
  | "help"
  | "commands"
  | "models"
  | "providers"
  | "roles"
  | "info"
  | "prompt"
  | "setup";

/**
 * The result of running every parser over one assistant bubble: the structures
 * that matched, the command whose `USAGE_CARD_DESIGN` entry drives the card, and
 * the prose left over that must STILL render as markdown so nothing is lost.
 */
export interface SlashUsageMatch {
  kind: UsageMatchKind;
  /** Command name used to look up `USAGE_CARD_DESIGN`. */
  command: string;
  /** One-line human title for the card header. */
  title: string;
  help?: ParsedUsage;
  commands?: ParsedCommandList;
  models?: ParsedModelBlock;
  providers?: ParsedProviderRow[];
  roles?: ParsedRoleRow[];
  rows?: ParsedKeyValueRow[];
  prompt?: ParsedPromptUsage;
  /** A canned notice shown verbatim as the card's own message. */
  hint?: string;
  /** Live value reported by the reply, so a toggle/chip control preselects it. */
  current?: string | null;
  /** Leftover descriptive text — render it as markdown above/below the card. */
  prose: string;
}

// ---------------------------------------------------------------------------
// Per-command control design (spec 137 §B)
// ---------------------------------------------------------------------------

/** A secondary action on a prompt card: either a direct send or a text prompt. */
export interface UsageExtraAction {
  label: string;
  /** Sent verbatim on tap (mutually exclusive with `prefix`). */
  command?: string;
  /** Opens a text field that sends `${prefix}${text}` when submitted. */
  prefix?: string;
}

export type UsageControl =
  | { kind: "chips"; options: UsageOption[]; status?: UsageOption }
  | { kind: "toggle"; on: UsageOption; off: UsageOption; status?: UsageOption }
  | { kind: "list" }
  | { kind: "grid" }
  | { kind: "info" }
  | { kind: "danger"; label: string }
  | { kind: "action"; label: string }
  | { kind: "prompt"; hint: string; placeholder: string; extras?: UsageExtraAction[] };

const THINK_LEVELS: UsageOption[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

/**
 * Which visual control each command's help/status reply deserves.
 *
 * Every entry is a pure render-time decision: the card's buttons call
 * `onSend("/<command> <sub>")` — the exact strings the composer would have typed
 * — so tapping an option never requires typing a subcommand by hand.
 *
 * A command with NO entry (or an unrecognised reply) falls back to today's plain
 * markdown rendering. That fallback is the invariant that makes this safe to
 * extend: a shape we did not anticipate can never render as a card.
 */
export const USAGE_CARD_DESIGN: Record<string, UsageControl> = {
  think: {
    kind: "chips",
    options: THINK_LEVELS,
    status: { value: "status", label: "Status" },
  },
  verbose: {
    kind: "toggle",
    on: { value: "true", label: "On" },
    off: { value: "false", label: "Off" },
    status: { value: "status", label: "Status" },
  },
  streaming: {
    kind: "toggle",
    on: { value: "true", label: "On" },
    off: { value: "false", label: "Off" },
    status: { value: "status", label: "Status" },
  },
  model: { kind: "list" },
  provider: { kind: "list" },
  help: { kind: "grid" },
  status: { kind: "info" },
  version: { kind: "info" },
  context: { kind: "info" },
  restart: { kind: "danger", label: "Restart gateway" },
  new: { kind: "action", label: "Start a new conversation" },
  clear: { kind: "action", label: "Clear this session" },
  stop: { kind: "action", label: "Stop the current task" },
  remember: {
    kind: "prompt",
    hint: "Save something to long-term memory.",
    placeholder: "e.g. My API key is abc123",
  },
  shell: {
    kind: "prompt",
    hint: "Run a shell command directly and get its output.",
    placeholder: "e.g. df -h",
  },
  steer: {
    kind: "prompt",
    hint: "Inject a mid-turn instruction into the response streaming right now.",
    placeholder: "e.g. wrap that in bullets",
  },
  btw: {
    kind: "prompt",
    hint: "Ask a side question that runs concurrently — delivered as soon as it's ready.",
    placeholder: "e.g. what is 2+2?",
  },
  local: {
    kind: "prompt",
    hint: "Ask a side question on the local provider/model configured for the local role.",
    placeholder: "e.g. summarise this repo",
    extras: [{ label: "Set local model", prefix: "/provider role local " }],
  },
  topic: {
    kind: "prompt",
    hint: "Name this conversation's topic (locks it — the LLM can no longer change it).",
    placeholder: "e.g. dashboard usage cards",
    extras: [{ label: "Clear", command: "/topic clear" }],
  },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A recognised structure plus the raw lines it accounted for. */
interface Block<T> {
  value: T;
  consumed: string[];
}

/** `Key: value` on one line. */
const KV_LINE = /^([^:\n]{1,60}):[ \t]*(.*)$/;

/** A label that survives emoji/symbol stripping (e.g. `🤖 Model` → `Model`). */
const CLEAN_KEY = /^[A-Za-z][A-Za-z0-9 ._()/&+'-]*$/;

const LEADING_JUNK = /^[^A-Za-z0-9]+/;

/** Lines that carry usage information rather than prose. */
const USAGE_PREFIX = /^(usage|example|examples)\s*:/i;

/** Strip decoration from a `Key:` label so it reads as a human label. */
function cleanKey(raw: string): string {
  return raw.replace(LEADING_JUNK, "").trim();
}

function lines(text: string): string[] {
  return (text || "").split("\n");
}

/** First non-blank line index, or `-1`. */
function firstContentLine(raw: string[]): number {
  for (let i = 0; i < raw.length; i += 1) if (raw[i].trim() !== "") return i;
  return -1;
}

/** Everything that is not a structural line, rejoined as clean markdown prose. */
function leftoverProse(text: string, consumed: string[]): string {
  const structural = new Set(consumed.map((l) => l.trim()));
  return lines(text)
    .filter((l) => l.trim() !== "")
    .filter((l) => !structural.has(l.trim()))
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// parseCommandHelp — the `📖 /model — …` block
// ---------------------------------------------------------------------------

const HELP_HEADER = /^📖[ \t]*\/([a-z0-9_-]+)[ \t]*[—–-][ \t]*(.*)$/i;
const HELP_USAGE = /^Usage:[ \t]*\/([a-z0-9_-]+)\b/i;
const HELP_SUBCOMMANDS = /^Subcommands:[ \t]*$/i;

/**
 * Parse the bare-command help block generated by `get_help_text`.
 *
 * Returns `null` unless the text opens with a `📖 /<name> — <desc>` header AND
 * carries a matching `Usage: /<name> …` line AND a `Subcommands:` block — so a
 * sentence that merely starts with an emoji is never mistaken for help.
 */
export function parseCommandHelp(text: string): ParsedUsage | null {
  return parseCommandHelpBlock(text)?.value ?? null;
}

function parseCommandHelpBlock(text: string): Block<ParsedUsage> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0) return null;
  const header = raw[start].trim().match(HELP_HEADER);
  if (!header) return null;

  const name = header[1].toLowerCase();
  const description = header[2].trim();
  const consumed: string[] = [raw[start].trim()];

  // The Usage line must name the SAME command, otherwise these are two
  // unrelated lines that happen to start with an emoji.
  let usageSeen = false;
  let i = start + 1;
  for (; i < raw.length; i += 1) {
    const t = raw[i].trim();
    if (t === "") continue;
    const u = t.match(HELP_USAGE);
    if (u && u[1].toLowerCase() === name) {
      usageSeen = true;
      consumed.push(t);
      continue;
    }
    break;
  }
  if (!usageSeen) return null;

  let j = i;
  while (j < raw.length && raw[j].trim() === "") j += 1;
  if (j >= raw.length || !HELP_SUBCOMMANDS.test(raw[j].trim())) return null;
  consumed.push(raw[j].trim());
  j += 1;

  const options: UsageOption[] = [];
  for (; j < raw.length; j += 1) {
    if (raw[j].trim() === "") continue;
    // Indented subcommand rows only — an unindented line ends the block.
    if (!/^[ \t]/.test(raw[j])) break;
    const [value, ...descParts] = raw[j].trim().split(/\s+[—–-]\s+/);
    if (!value) continue;
    const label = descParts.join(" ").trim();
    options.push({ value, label: label || value });
    consumed.push(raw[j].trim());
  }
  if (options.length === 0) return null;

  return { value: { name, description, options }, consumed };
}

// ---------------------------------------------------------------------------
// parseCommandList — the `🪆 Available commands:` block
// ---------------------------------------------------------------------------

const COMMAND_LIST_HEADER = /^🪆[ \t]*Available commands:[ \t]*$/i;
const COMMAND_LIST_ROW = /^\/([a-z0-9_-]+)[ \t]*[—–-][ \t]*(.*)$/i;

/** Parse the `/help` output into a tappable list of commands. */
export function parseCommandList(text: string): ParsedCommandList | null {
  return parseCommandListBlock(text)?.value ?? null;
}

function parseCommandListBlock(text: string): Block<ParsedCommandList> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0 || !COMMAND_LIST_HEADER.test(raw[start].trim())) return null;

  const commands: { name: string; description: string }[] = [];
  const consumed: string[] = [raw[start].trim()];
  for (let j = start + 1; j < raw.length; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    const row = t.match(COMMAND_LIST_ROW);
    // A non-row line means this is not the command list.
    if (!row) return null;
    commands.push({ name: row[1].toLowerCase(), description: row[2].trim() });
    consumed.push(t);
  }
  if (commands.length === 0) return null;
  return { value: { commands }, consumed };
}

// ---------------------------------------------------------------------------
// parseModelList — the `📦 Models …` block
// ---------------------------------------------------------------------------

const MODEL_HEADER = /^📦[ \t]*Models (available on|on)[ \t]*'([^']*)':[ \t]*$/i;
const MODEL_ROW = /^[•\-*]\s+(.*\S)\s*$/;

/** Parse `/model list` / `/provider models <name>` into plain model names. */
export function parseModelList(text: string): string[] | null {
  return parseModelListBlockOf(text)?.value.models ?? null;
}

/** Same as {@link parseModelList} but keeps the provider the list came from. */
export function parseModelListBlock(text: string): ParsedModelBlock | null {
  return parseModelListBlockOf(text)?.value ?? null;
}

function parseModelListBlockOf(text: string): Block<ParsedModelBlock> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0) return null;
  const header = raw[start].trim().match(MODEL_HEADER);
  if (!header) return null;

  const models: string[] = [];
  const consumed: string[] = [raw[start].trim()];
  for (let j = start + 1; j < raw.length; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    const row = t.match(MODEL_ROW);
    if (!row) return null;
    models.push(row[1]);
    consumed.push(t);
  }
  if (models.length === 0) return null;

  return {
    value: {
      provider: header[2].trim(),
      fromModelCommand: header[1].toLowerCase() === "available on",
      models,
    },
    consumed,
  };
}

// ---------------------------------------------------------------------------
// parseProviderList — the `Configured providers:` block
// ---------------------------------------------------------------------------

const PROVIDER_HEADER = /^Configured providers:[ \t]*$/;
const PROVIDER_ROW = /^[ \t]*(?:→|->)?[ \t]*(.+?)[ \t]*$/;
const PROVIDER_ACTIVE = /^[ \t]*(?:→|->)/;

/** Parse `/provider list` / `/provider status` into tappable provider rows. */
export function parseProviderList(text: string): ParsedProviderRow[] | null {
  return parseProviderListBlockOf(text)?.value.providers ?? null;
}

/** {@link parseProviderList} plus the status rows that may lead the reply. */
export function parseProviderListBlock(
  text: string,
): { providers: ParsedProviderRow[]; rows: ParsedKeyValueRow[] } | null {
  return parseProviderListBlockOf(text)?.value ?? null;
}

function parseProviderListBlockOf(
  text: string,
): Block<{ providers: ParsedProviderRow[]; rows: ParsedKeyValueRow[] }> | null {
  const raw = lines(text);
  // `/provider status` leads with `🔌 Provider:` / `🤖 Model:` rows, so the
  // header is SEARCHED FOR rather than assumed to be the first line.
  let head = -1;
  for (let i = 0; i < raw.length; i += 1) {
    if (PROVIDER_HEADER.test(raw[i].trim())) {
      head = i;
      break;
    }
  }
  if (head < 0) return null;

  // Anything labelled before the header is a status row — capture it so the card
  // can show it as info rows above the provider list.
  const rows: ParsedKeyValueRow[] = [];
  const consumed: string[] = [];
  for (let j = 0; j < head; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    const row = rowFrom(t);
    if (row) {
      rows.push(row);
      consumed.push(t);
    }
  }

  const providers: ParsedProviderRow[] = [];
  consumed.push(raw[head].trim());
  for (let j = head + 1; j < raw.length; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    if (USAGE_PREFIX.test(t)) break; // the trailing `Usage: …` line ends the block
    if (!/^[ \t]/.test(raw[j])) break;
    const row = t.match(PROVIDER_ROW);
    if (!row || !row[1]) break;
    providers.push({ name: row[1], active: PROVIDER_ACTIVE.test(raw[j]) });
    consumed.push(t);
  }
  if (providers.length === 0) return null;
  return { value: { providers, rows }, consumed };
}

// ---------------------------------------------------------------------------
// parseRoleStatus — the `🎭 Provider roles:` block
// ---------------------------------------------------------------------------

const ROLE_HEADER = /^🎭[ \t]*Provider roles:[ \t]*$/i;
const ROLE_ROW = /^[ \t]*[^A-Za-z0-9\s]*[ \t]*(main|local|image|active)[ \t]*[→-][ \t]*(.+?)[ \t]*$/i;
const ROLE_MODEL = /\(([^()]+)\)[ \t]*$/;

/** Parse `/provider roles` into one row per assignable role. */
export function parseRoleStatus(text: string): ParsedRoleRow[] | null {
  return parseRoleStatusBlock(text)?.value ?? null;
}

function parseRoleStatusBlock(text: string): Block<ParsedRoleRow[]> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0 || !ROLE_HEADER.test(raw[start].trim())) return null;

  const roles: ParsedRoleRow[] = [];
  const consumed: string[] = [raw[start].trim()];
  for (let j = start + 1; j < raw.length; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    const row = t.match(ROLE_ROW);
    if (!row) break;
    let provider = row[2].trim();
    let model: string | null = null;
    const m = provider.match(ROLE_MODEL);
    if (m && !/^none\b/i.test(m[1])) {
      model = m[1].trim();
      provider = provider.slice(0, m.index).trim();
    }
    // `🔌 active` is informational, not an assignable role.
    if (row[1].toLowerCase() !== "active") roles.push({ role: row[1].toLowerCase(), provider, model });
    consumed.push(t);
  }
  if (roles.length === 0) return null;
  return { value: roles, consumed };
}

// ---------------------------------------------------------------------------
// parseKeyValue — labelled status lines
// ---------------------------------------------------------------------------

/**
 * Parse labelled `Key: value` status lines (`/status`, `/model status`).
 *
 * Strict on purpose: the first line may be a bare title (`🪆 sarathy Status`),
 * but every remaining non-empty line — except `Usage:`/`Example:` trailers —
 * must be a labelled row. Ordinary prose therefore fails as soon as a second
 * line is not a row, which is what stops this from hijacking normal replies.
 */
export function parseKeyValue(text: string): ParsedKeyValueRow[] | null {
  return parseKeyValueBlock(text)?.value ?? null;
}

function parseKeyValueBlock(text: string): Block<ParsedKeyValueRow[]> | null {
  const raw = lines(text).filter((l) => l.trim() !== "");
  if (raw.length < 2) return null;

  const start = rowFrom(raw[0]) ? 0 : 1; // a leading title line
  if (raw.length - start < 2) return null;

  const rows: ParsedKeyValueRow[] = [];
  const consumed: string[] = [];
  for (let i = start; i < raw.length; i += 1) {
    const t = raw[i].trim();
    if (USAGE_PREFIX.test(t)) {
      consumed.push(t);
      continue;
    }
    const row = rowFrom(t);
    if (!row) return null;
    rows.push(row);
    consumed.push(t);
  }
  if (rows.length < 2) return null;
  return { value: rows, consumed };
}

/** Turn one `Key: value` line into a row, or `null` if it is not one. */
function rowFrom(line: string): ParsedKeyValueRow | null {
  const m = line.trim().match(KV_LINE);
  if (!m) return null;
  const key = cleanKey(m[1]);
  const value = m[2].trim();
  if (!CLEAN_KEY.test(key) || key.length > 60 || value === "") return null;
  return { key, value };
}

/**
 * `/context` output: a titled block whose trailing verdict line (`✅ Context OK`)
 * is prose rather than a row, so it needs a tolerant reader.
 */
const CONTEXT_HEADER = /^📊[ \t]*Context Usage[ \t]*$/i;

function parseContextBlock(text: string): Block<ParsedKeyValueRow[]> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0 || !CONTEXT_HEADER.test(raw[start].trim())) return null;

  const rows: ParsedKeyValueRow[] = [];
  const consumed: string[] = [raw[start].trim()];
  for (let j = start + 1; j < raw.length; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    const row = rowFrom(t);
    if (row) rows.push(row);
    consumed.push(t);
  }
  if (rows.length < 2) return null;
  return { value: rows, consumed };
}

/** `/status` output: a titled block of labelled rows. */
const STATUS_HEADER = /^🪆[ \t]*sarathy Status[ \t]*$/i;

function parseStatusBlock(text: string): Block<ParsedKeyValueRow[]> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0 || !STATUS_HEADER.test(raw[start].trim())) return null;

  const rows: ParsedKeyValueRow[] = [];
  const consumed: string[] = [raw[start].trim()];
  for (let j = start + 1; j < raw.length; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    const row = rowFrom(t);
    if (!row) return null;
    rows.push(row);
    consumed.push(t);
  }
  if (rows.length < 2) return null;
  return { value: rows, consumed };
}

/** `/version` output — a single line that names itself. */
const VERSION_LINE = /^sarathy v([0-9][0-9A-Za-z.+-]*)\s*$/i;

function parseVersionBlock(text: string): Block<ParsedKeyValueRow[]> | null {
  const t = (text || "").trim();
  if (!VERSION_LINE.test(t)) return null;
  return { value: [{ key: "Version", value: t }], consumed: [t] };
}

/**
 * `/think status` — a single labelled row naming the live effort level. The card
 * renders it as the chips control with the current level highlighted.
 */
const THINK_STATUS = /^🧠[ \t]*Thinking:[ \t]*(\S+)[ \t]*$/i;

function parseThinkStatusBlock(text: string): Block<ParsedKeyValueRow[]> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0) return null;
  // Only the headline carries the level; the `Use /think <level> …` line that
  // follows it stays as prose.
  const m = raw[start].trim().match(THINK_STATUS);
  if (!m) return null;
  return { value: [{ key: "Thinking", value: m[1] }], consumed: [raw[start].trim()] };
}

// ---------------------------------------------------------------------------
// Prompt usage notices — `Usage: /<name> …`
// ---------------------------------------------------------------------------

const PROMPT_USAGE = /^Usage:[ \t]*\/([a-z0-9_-]+)\b[ \t]*(.*)$/i;

/**
 * Parse the `Usage: /<name> …` notice that arg-less commands reply with
 * (`/btw`, `/steer`, `/shell`, `/local`, `/remember`, `/topic` …).
 */
export function parsePromptUsage(text: string): ParsedPromptUsage | null {
  return parsePromptUsageBlock(text)?.value ?? null;
}

function parsePromptUsageBlock(text: string): Block<ParsedPromptUsage> | null {
  const raw = lines(text);
  const start = firstContentLine(raw);
  if (start < 0) return null;

  // The `Usage: /x …` line leads the reply for `/btw`, `/steer`, `/shell`,
  // `/local` and `/remember`, but follows one prose line for `/topic`. A short
  // lead-in is allowed; a long one is ordinary prose and must not be claimed.
  let hit: RegExpMatchArray | null = null;
  let idx = -1;
  for (let j = start, seen = 0; j < raw.length && seen < 3; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    const m = t.match(PROMPT_USAGE);
    if (m) {
      hit = m;
      idx = j;
      break;
    }
    seen += 1;
  }
  if (!hit) return null;

  const examples: string[] = [];
  const consumed: string[] = [raw[idx].trim()];
  let current: string | null = null;
  for (let j = idx + 1; j < raw.length; j += 1) {
    const t = raw[j].trim();
    if (t === "") continue;
    if (/^Example:/i.test(t)) {
      examples.push(t.replace(/^Examples?:[ \t]*/i, "").trim());
      consumed.push(t);
      continue;
    }
    // `/verbose` and `/streaming` report their live value right under the usage
    // line (`Current: on`) — that seeds the toggle's initial position.
    const c = t.match(/^Current:[ \t]*(.+?)[ \t]*$/i);
    if (c) {
      current = c[1];
      consumed.push(t);
      continue;
    }
    break;
  }

  return {
    value: { command: hit[1].toLowerCase(), usage: hit[2].trim(), examples, current },
    consumed,
  };
}

/**
 * Which command a reply's `Usage: /x …` trailer names.
 *
 * `/model status` and friends carry no other self-identification, so this is
 * what attributes their info card. Reading it is a render-time concern — the
 * help-text format itself is unchanged.
 */
function trailerCommand(text: string): string | undefined {
  for (const line of lines(text)) {
    const m = line.trim().match(PROMPT_USAGE);
    if (m) return m[1].toLowerCase();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Detection — which card does this bubble render as?
// ---------------------------------------------------------------------------

type PartialMatch = Omit<SlashUsageMatch, "prose"> & { consumed: string[] };

/**
 * Run every parser over one assistant reply and decide what it should render.
 *
 * Returns `null` when the text is not a slash-command usage reply, OR when the
 * command it belongs to has no `USAGE_CARD_DESIGN` entry — in both cases the
 * caller keeps today's plain rendering. That single choke point is what makes
 * the feature safe: an unknown shape can never render as a card.
 */
export function matchSlashUsage(text: string): SlashUsageMatch | null {
  if (!text || !text.trim()) return null;

  const setup = parseLocalSetupBlock(text);

  // 1. /help — the full command list.
  const list = parseCommandListBlock(text);
  if (list) {
    return finish(text, {
      kind: "commands",
      command: "help",
      title: "Available commands",
      commands: list.value,
      consumed: list.consumed,
    });
  }

  // 2. /model list and /provider models <name>.
  const models = parseModelListBlockOf(text);
  if (models) {
    return finish(text, {
      kind: "models",
      command: models.value.fromModelCommand ? "model" : "provider",
      title: `Models on '${models.value.provider}'`,
      models: models.value,
      consumed: models.consumed,
    });
  }

  // 3. /provider list, plus the Provider/Model rows /provider status leads with.
  const providers = parseProviderListBlockOf(text);
  if (providers) {
    return finish(text, {
      kind: "providers",
      command: "provider",
      title: "Providers",
      providers: providers.value.providers,
      rows: providers.value.rows.length ? providers.value.rows : undefined,
      consumed: providers.consumed,
    });
  }

  // 4. /provider roles.
  const roles = parseRoleStatusBlock(text);
  if (roles) {
    return finish(text, {
      kind: "roles",
      command: "provider",
      title: "Provider roles",
      roles: roles.value,
      consumed: roles.consumed,
    });
  }

  // 5. The `📖 /x — …` help block.
  const help = parseCommandHelpBlock(text);
  if (help) {
    return finish(text, {
      kind: "help",
      command: help.value.name,
      title: `/${help.value.name}`,
      help: help.value,
      consumed: help.consumed,
    });
  }

  // 6. Info cards: /think status, /context, /status, /version, /model status.
  const info = [
    [parseThinkStatusBlock(text), "think", "/think"],
    [parseContextBlock(text), "context", "Context usage"],
    [parseStatusBlock(text), "status", "Status"],
    [parseVersionBlock(text), "version", "Version"],
  ] as const;
  for (const [block, command, title] of info) {
    if (!block) continue;
    const current = command === "think" ? (block.value[0]?.value ?? null) : null;
    return finish(text, {
      kind: "info",
      command,
      title,
      rows: block.value,
      current,
      consumed: block.consumed,
    });
  }

  const rows = parseKeyValueBlock(text);
  if (rows) {
    // `/model status` and friends name their own command in the trailing
    // `Usage: /model …` line — that trailer is what attributes the card.
    const named = trailerCommand(text);
    if (named && USAGE_CARD_DESIGN[named]) {
      return finish(text, {
        kind: "info",
        command: named,
        title: `/${named} status`,
        rows: rows.value,
        consumed: rows.consumed,
      });
    }
  }

  // 7. The canned "no local provider" reply — offer the fix as a tap.
  if (setup) {
    return finish(text, {
      kind: "setup",
      command: "local",
      title: "/local",
      hint: setup.value,
      consumed: setup.consumed,
    });
  }

  // 8. `Usage: /x …` notices for the prompt / toggle / list designs.
  const prompt = parsePromptUsageBlock(text);
  if (prompt && USAGE_CARD_DESIGN[prompt.value.command]) {
    return finish(text, {
      kind: "prompt",
      command: prompt.value.command,
      title: `/${prompt.value.command}`,
      prompt: prompt.value,
      current: prompt.value.current ?? null,
      consumed: prompt.consumed,
    });
  }

  return null;
}

/**
 * The canned "no local provider" reply `/local` returns when the `local` role is
 * unconfigured. Recognised so the dashboard can offer the fix as a tap instead of
 * leaving the user to remember the exact `/provider role local …` incantation.
 */
const LOCAL_SETUP = /no local provider is configured/i;

function parseLocalSetupBlock(text: string): Block<string> | null {
  const t = (text || "").trim();
  if (!LOCAL_SETUP.test(t)) return null;
  return { value: t, consumed: [t] };
}

/** Assemble the match, fill in leftover prose, and gate on the design map. */
function finish(text: string, partial: PartialMatch): SlashUsageMatch | null {
  if (!USAGE_CARD_DESIGN[partial.command]) return null;
  const { consumed, ...rest } = partial;
  return { ...rest, prose: leftoverProse(text, consumed) };
}

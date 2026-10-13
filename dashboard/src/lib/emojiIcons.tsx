import {
  AlarmClock,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Brain,
  Brush,
  Bug,
  Calendar,
  Camera,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clapperboard,
  Compass,
  Flame,
  FlaskConical,
  Folder,
  FolderTree,
  Frown,
  Gem,
  Hammer,
  HandHeart,
  Headphones,
  Heart,
  Hourglass,
  Image as ImageIcon,
  Info,
  Key,
  Laugh,
  Lightbulb,
  Link as LinkIcon,
  Lock,
  Map as MapIcon,
  Medal,
  Megaphone,
  Meh,
  MessageSquare,
  Moon,
  Music,
  NotebookPen,
  OctagonX,
  Package,
  Paperclip,
  PartyPopper,
  Pencil,
  Pin,
  Puzzle,
  ReceiptText,
  RefreshCw,
  Rocket,
  Save,
  Scissors,
  Search,
  Settings,
  Shield,
  Siren,
  Smile,
  Star,
  Sun,
  Target,
  ThumbsUp,
  Timer,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Trophy,
  Volume2,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Semantic colour slot for an icon. Each maps to a theme token
 * (`--emoji-*` in index.css) that is redefined for light and dark, so the
 * icon adapts to the active theme instead of being a fixed colour.
 *
 * `neutral` keeps `currentColor` — the icon follows the surrounding text,
 * which is itself theme-aware.
 */
export type EmojiVariant = "success" | "danger" | "warning" | "info" | "neutral";

export interface EmojiEntry {
  icon: LucideIcon;
  variant: EmojiVariant;
}

/**
 * Emoji → lucide icon map, shared by the desktop and mobile SPAs.
 *
 * The agent's replies are emoji-heavy (🗣️ voice replies, ✅/❌ status, 🔧 tool
 * work). Rendered verbatim they read as low-fidelity OS glyphs and vary per
 * platform; Viswa asked for inline lucide icons instead (2026-10-11). The swap
 * happens in the shared markdown pipeline, so every surface renders the same
 * icon set — the same "share the module, never duplicate" rule as
 * `channelIcons.tsx` and `transcript.ts`.
 *
 * Keys are stored WITHOUT the U+FE0F variation selector so a single entry
 * matches both the text form (⚠) and the emoji-presentation form (⚠️) — see
 * `emojiIcon()`.
 */
export const EMOJI_ICONS: Record<string, EmojiEntry> = {
  // Status / feedback
  "✅": { icon: CircleCheck, variant: "success" },
  "❌": { icon: CircleX, variant: "danger" },
  "⚠": { icon: TriangleAlert, variant: "warning" },
  "❗": { icon: CircleAlert, variant: "warning" },
  "❓": { icon: CircleHelp, variant: "info" },
  "🛑": { icon: OctagonX, variant: "danger" },
  "🚨": { icon: Siren, variant: "danger" },
  "🎉": { icon: PartyPopper, variant: "success" },
  "🏆": { icon: Trophy, variant: "success" },
  "🥇": { icon: Medal, variant: "success" },
  "⭐": { icon: Star, variant: "success" },
  "💎": { icon: Gem, variant: "info" },
  "🔥": { icon: Flame, variant: "warning" },
  "❤": { icon: Heart, variant: "danger" },
  "👍": { icon: ThumbsUp, variant: "success" },
  "🙏": { icon: HandHeart, variant: "success" },

  // Voice / audio / media
  "🗣": { icon: Volume2, variant: "info" },
  "🎧": { icon: Headphones, variant: "info" },
  "🎵": { icon: Music, variant: "info" },
  "🎬": { icon: Clapperboard, variant: "info" },
  "📷": { icon: Camera, variant: "neutral" },
  "🖼": { icon: ImageIcon, variant: "neutral" },

  // Work / tooling
  "🔧": { icon: Wrench, variant: "info" },
  "🛠": { icon: Hammer, variant: "info" },
  "⚙": { icon: Settings, variant: "neutral" },
  "🧪": { icon: FlaskConical, variant: "info" },
  "🐛": { icon: Bug, variant: "danger" },
  "🧹": { icon: Brush, variant: "neutral" },
  "📦": { icon: Package, variant: "neutral" },
  "🧩": { icon: Puzzle, variant: "info" },
  "🔒": { icon: Lock, variant: "neutral" },
  "🔑": { icon: Key, variant: "warning" },
  "🛡": { icon: Shield, variant: "info" },
  "🧭": { icon: Compass, variant: "info" },

  // Notes / docs / comms
  "📝": { icon: NotebookPen, variant: "neutral" },
  "📖": { icon: BookOpen, variant: "neutral" },
  "🧾": { icon: ReceiptText, variant: "neutral" },
  "📌": { icon: Pin, variant: "warning" },
  "📎": { icon: Paperclip, variant: "neutral" },
  "🔗": { icon: LinkIcon, variant: "info" },
  "🔍": { icon: Search, variant: "neutral" },
  "🗺": { icon: MapIcon, variant: "neutral" },
  "🗂": { icon: FolderTree, variant: "neutral" },
  "📁": { icon: Folder, variant: "neutral" },
  "💬": { icon: MessageSquare, variant: "neutral" },
  "📣": { icon: Megaphone, variant: "info" },
  "🔔": { icon: Bell, variant: "warning" },
  "✏": { icon: Pencil, variant: "neutral" },
  "✂": { icon: Scissors, variant: "neutral" },
  "🗑": { icon: Trash2, variant: "danger" },
  "💾": { icon: Save, variant: "neutral" },

  // Data / trends
  "📊": { icon: BarChart3, variant: "info" },
  "📈": { icon: TrendingUp, variant: "success" },
  "📉": { icon: TrendingDown, variant: "danger" },
  "🎯": { icon: Target, variant: "info" },
  "🧠": { icon: Brain, variant: "info" },
  "🤖": { icon: Bot, variant: "info" },
  "⚡": { icon: Zap, variant: "warning" },
  "🚀": { icon: Rocket, variant: "success" },
  "🔄": { icon: RefreshCw, variant: "info" },
  "⏳": { icon: Hourglass, variant: "warning" },
  "⏱": { icon: Timer, variant: "info" },
  "⏰": { icon: AlarmClock, variant: "warning" },
  "📅": { icon: Calendar, variant: "neutral" },
  "💡": { icon: Lightbulb, variant: "warning" },
  "ℹ": { icon: Info, variant: "info" },

  // Time of day / mood
  "🌙": { icon: Moon, variant: "neutral" },
  "☀": { icon: Sun, variant: "warning" },
  "💤": { icon: Moon, variant: "neutral" },
  "😀": { icon: Smile, variant: "success" },
  "😄": { icon: Laugh, variant: "success" },
  "😅": { icon: Laugh, variant: "success" },
  "😐": { icon: Meh, variant: "neutral" },
  "😞": { icon: Frown, variant: "danger" },
  "😢": { icon: Frown, variant: "danger" },
};

/** U+FE0F forces emoji presentation; drop it so one key matches both forms. */
const VARIATION_SELECTOR = /\uFE0F/g;

/** Normalise an emoji to its map key form (variation selector removed). */
export function normalizeEmoji(char: string): string {
  return char.replace(VARIATION_SELECTOR, "");
}

/** Icons the pipeline should swap, longest first so multi-codepoint keys win. */
export const EMOJI_KEYS: string[] = Object.keys(EMOJI_ICONS).sort(
  (a, b) => b.length - a.length,
);

/** The icon + colour variant for an emoji, or `null` when it is not mapped. */
export function emojiIcon(char: string): EmojiEntry | null {
  return EMOJI_ICONS[normalizeEmoji(char)] ?? null;
}

/**
 * Render one emoji as a lucide icon.
 *
 * Sizing and colour live in `.emoji-icon` (index.css): the span sets the size
 * relative to the surrounding text and the `data-variant` attribute picks a
 * theme-aware colour token, so the icon is bigger than a plain glyph and adapts
 * to light/dark instead of being a fixed colour.
 *
 * The original glyph is kept as the accessible name (`role="img"` +
 * `aria-label`) so the emoji still reads correctly to a screen reader.
 */
export function EmojiIcon({ name }: { name?: string }) {
  const entry = name ? emojiIcon(name) : null;
  if (!entry) return <span>{name}</span>;
  const { icon: Icon, variant } = entry;
  return (
    <span className="emoji-icon" data-variant={variant} role="img" aria-label={name}>
      <Icon aria-hidden="true" />
    </span>
  );
}

/** Escape a character for use inside a RegExp. */
function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One alternation of every known emoji, each key's code points followed by an
 * optional U+FE0F so a single entry matches both `⚠` and `⚠️`.
 */
const EMOJI_TEXT_RE = new RegExp(
  EMOJI_KEYS.map((key) =>
    Array.from(key)
      .map((char) => `${escapeRegExp(char)}\\uFE0F?`)
      .join(""),
  ).join("|"),
  "gu",
);

/**
 * Render a plain string with every known emoji swapped for its lucide icon.
 *
 * The markdown pipeline (`lib/markdown.tsx`) already does this for assistant
 * prose, but surfaces that render a bare string — the live-status strip, chips,
 * any non-markdown label — showed the raw OS glyph. This is the same swap for
 * those surfaces, so the dashboard never emits a raw emoji (standing rule,
 * 2026-10-13). Unmapped text passes through untouched.
 */
export function EmojiText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  EMOJI_TEXT_RE.lastIndex = 0;

  for (let match = EMOJI_TEXT_RE.exec(text); match; match = EMOJI_TEXT_RE.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<EmojiIcon key={match.index} name={normalizeEmoji(match[0])} />);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return <>{parts}</>;
}

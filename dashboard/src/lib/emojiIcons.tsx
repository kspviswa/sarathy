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
export const EMOJI_ICONS: Record<string, LucideIcon> = {
  // Status / feedback
  "✅": CircleCheck,
  "❌": CircleX,
  "⚠": TriangleAlert,
  "❗": CircleAlert,
  "❓": CircleHelp,
  "🛑": OctagonX,
  "🚨": Siren,
  "🎉": PartyPopper,
  "🏆": Trophy,
  "🥇": Medal,
  "⭐": Star,
  "💎": Gem,
  "🔥": Flame,
  "❤": Heart,
  "👍": ThumbsUp,
  "🙏": HandHeart,

  // Voice / audio / media
  "🗣": Volume2,
  "🎧": Headphones,
  "🎵": Music,
  "🎬": Clapperboard,
  "📷": Camera,
  "🖼": ImageIcon,

  // Work / tooling
  "🔧": Wrench,
  "🛠": Hammer,
  "⚙": Settings,
  "🧪": FlaskConical,
  "🐛": Bug,
  "🧹": Brush,
  "📦": Package,
  "🧩": Puzzle,
  "🔒": Lock,
  "🔑": Key,
  "🛡": Shield,
  "🧭": Compass,

  // Notes / docs / comms
  "📝": NotebookPen,
  "📖": BookOpen,
  "🧾": ReceiptText,
  "📌": Pin,
  "📎": Paperclip,
  "🔗": LinkIcon,
  "🔍": Search,
  "🗺": MapIcon,
  "🗂": FolderTree,
  "📁": Folder,
  "💬": MessageSquare,
  "📣": Megaphone,
  "🔔": Bell,
  "✏": Pencil,
  "✂": Scissors,
  "🗑": Trash2,
  "💾": Save,

  // Data / trends
  "📊": BarChart3,
  "📈": TrendingUp,
  "📉": TrendingDown,
  "🎯": Target,
  "🧠": Brain,
  "🤖": Bot,
  "⚡": Zap,
  "🚀": Rocket,
  "🔄": RefreshCw,
  "⏳": Hourglass,
  "⏱": Timer,
  "⏰": AlarmClock,
  "📅": Calendar,
  "💡": Lightbulb,

  // Time of day / mood
  "🌙": Moon,
  "☀": Sun,
  "💤": Moon,
  "😀": Smile,
  "😄": Laugh,
  "😅": Laugh,
  "😐": Meh,
  "😞": Frown,
  "😢": Frown,
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

/** The lucide icon for an emoji, or `null` when it is not in the map. */
export function emojiIcon(char: string): LucideIcon | null {
  return EMOJI_ICONS[normalizeEmoji(char)] ?? null;
}

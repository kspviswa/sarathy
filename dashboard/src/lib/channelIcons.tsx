import {
  LayoutDashboard,
  Mail,
  MessageSquare,
  MessagesSquare,
  Send,
  Server,
  Terminal,
  type LucideIcon,
} from "lucide-react";

/**
 * Channel → lucide icon mapping, shared by the desktop and mobile Sessions
 * drill-down so a channel reads the same everywhere (spec §C).
 */
const CHANNEL_ICONS: Record<string, LucideIcon> = {
  telegram: Send,
  discord: MessagesSquare,
  email: Mail,
  dashboard: LayoutDashboard,
  cli: Terminal,
  backend: Server,
};

/** Icon for a channel name (falls back to a generic message bubble). */
export function channelIcon(channel: string | undefined | null): LucideIcon {
  if (!channel) return MessageSquare;
  return CHANNEL_ICONS[channel.toLowerCase()] ?? MessageSquare;
}

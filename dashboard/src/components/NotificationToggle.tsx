import { BellRing } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * The notification on/off toggle (spec 125 §B1).
 *
 * This is the PRIMARY control for notifications and it is always visible — the
 * question "are notifications on?" should never require opening the panel. The
 * bell + unread badge sits beside it and only exists when notifications are on.
 *
 * While the persisted preference is still resolving the caller passes
 * `disabled`, so the control never flashes the wrong state on first paint.
 */
export function NotificationToggle({
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("inline-flex items-center gap-1.5", className)}
      data-checked={checked ? "true" : "false"}
    >
      <BellRing
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="hidden select-none text-xs text-muted-foreground sm:inline">
        Notifications
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label="Enable notifications"
        data-testid="notifications-toggle"
      />
    </div>
  );
}

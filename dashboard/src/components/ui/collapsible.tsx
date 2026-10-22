import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface CollapsibleProps {
  /** Controlled open state. Omit it to let the component hold the state. */
  open?: boolean;
  /** Initial open state - only used when uncontrolled. */
  defaultOpen?: boolean;
  /** Notified on every open/close. */
  onOpenChange?: (open: boolean) => void;
  /** The trigger's content - e.g. `Media · 3 images · 2 videos`. */
  title?: ReactNode;
  /** Test id of the trigger button. */
  testId?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A small collapsible - plain React state, no third-party primitive.
 *
 * The trigger is a real <button type="button"> carrying aria-expanded and
 * aria-controls; the region it toggles holds the matching id. The chevron
 * rotates while open.
 */
export function Collapsible({
  open,
  defaultOpen = false,
  onOpenChange,
  title,
  testId,
  className,
  children,
}: CollapsibleProps) {
  const generatedId = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const openState = isControlled ? open : internalOpen;

  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const regionId = `${generatedId}-region`;
  const triggerId = `${generatedId}-trigger`;

  return (
    <div className={cn("w-full", className)}>
      <button
        type="button"
        id={triggerId}
        data-testid={testId}
        aria-expanded={openState}
        aria-controls={regionId}
        onClick={() => setOpen(!openState)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            openState && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {openState && (
        <div
          id={regionId}
          role="region"
          aria-labelledby={triggerId}
          className="mt-2 flex flex-col gap-3"
        >
          {children}
        </div>
      )}
    </div>
  );
}

Collapsible.displayName = "Collapsible";

export default Collapsible;

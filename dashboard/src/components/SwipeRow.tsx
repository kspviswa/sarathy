import { Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** How far (px) a left swipe must travel before it counts as a dismiss. */
export const SWIPE_DISMISS_THRESHOLD = 72;

/**
 * Touch swipe-to-dismiss wrapper.
 *
 * Drag a row left past `SWIPE_DISMISS_THRESHOLD` to fire `onDismiss`; a red
 * destructive backdrop is revealed behind it as a hint. Only horizontal swipes
 * are captured — a mostly-vertical drag is handed back to the scroll container
 * so the list still scrolls normally on a phone.
 *
 * Touch-only by design (it listens to touch events, never pointer/mouse), so a
 * desktop surface that does not pass `onDismiss` renders nothing extra and a
 * mouse drag never dismisses. When `onDismiss` is absent the children render
 * untouched.
 */
export function SwipeRow({
  children,
  onDismiss,
  className,
}: {
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const startY = useRef(0);
  const dragging = useRef(false);

  if (!onDismiss) return <>{children}</>;

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    dragging.current = false;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current === null) return;
    const ddx = e.touches[0].clientX - startX.current;
    const ddy = e.touches[0].clientY - startY.current;
    if (!dragging.current) {
      // Ignore tiny jitters; bail out if the gesture is really a vertical scroll.
      if (Math.abs(ddx) < 8) return;
      if (Math.abs(ddy) > Math.abs(ddx)) {
        startX.current = null;
        return;
      }
      dragging.current = true;
    }
    setDx(Math.min(0, ddx));
  };

  const end = () => {
    if (dx <= -SWIPE_DISMISS_THRESHOLD) onDismiss();
    setDx(0);
    startX.current = null;
    dragging.current = false;
  };

  return (
    <div className={cn("relative overflow-hidden", className)} data-testid="swipe-row">
      <div
        className="pointer-events-none absolute inset-y-0 right-0 flex w-20 items-center justify-end bg-destructive pr-5 text-destructive-foreground"
        style={{ opacity: dx < 0 ? 1 : 0 }}
        aria-hidden="true"
      >
        <Trash2 className="size-4" />
      </div>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={end}
        onTouchCancel={end}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging.current ? "none" : "transform 150ms ease-out",
        }}
        className="relative bg-background"
      >
        {children}
      </div>
    </div>
  );
}

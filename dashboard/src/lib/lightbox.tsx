/**
 * Image lightbox — tap-to-zoom for images rendered inside openUI blocks.
 *
 * ## Why this module is openUI-free
 *
 * The heavy openUI runtime is confined to `openuiRenderer.tsx` (a test enforces
 * that no other module imports `@openuidev/*`). So this file is plain React:
 * `openuiRenderer.tsx` wraps the catalog's `ImageBlock` / `Image` components and
 * spreads {@link useZoomable}'s handlers onto them. Every image the model renders
 * therefore becomes tappable — on BOTH the desktop and the mobile SPA, because
 * both draw blocks through the same `<UIBlock>`.
 *
 * ## Behaviour
 *
 * Tap/click an image → fullscreen overlay at fit size. Inside the overlay:
 * tap the image to toggle zoom, pinch to zoom on touch, wheel to zoom on
 * desktop, drag to pan when zoomed, and Esc / backdrop / the close button to
 * dismiss. The overlay portals to `<body>` so it escapes the chat bubble's
 * `overflow` and stacking context.
 *
 * Dependency-free on purpose (no Radix dialog): the whole interaction is
 * pointer events + transforms, which keeps it working identically on iOS
 * Safari, Android Chrome and desktop.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ExternalLink, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

import { cn } from "@/lib/utils";

/** An image the user asked to see up close. */
export interface LightboxItem {
  src: string;
  alt?: string;
  /** The page the image came from — renders a "Source" link when present. */
  href?: string;
  /** A human title for the image, used when the alt text is absent. */
  title?: string;
}

interface LightboxApi {
  /** Show `item` in the fullscreen overlay. */
  open: (item: LightboxItem) => void;
}

const LightboxContext = createContext<LightboxApi | null>(null);

/** Access the lightbox. Returns `null` outside a {@link LightboxProvider}. */
export function useLightbox(): LightboxApi | null {
  return useContext(LightboxContext);
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Scale a single tap jumps to (and back from). */
const TAP_SCALE = 2.5;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Largest pan offset that still keeps the image overlapping the viewport. */
function panLimit(scale: number): number {
  return ((scale - 1) * Math.min(window.innerWidth, window.innerHeight)) / 2;
}

/**
 * Handlers that make an image element open the lightbox.
 *
 * Spread onto the openUI `ImageBlock` / `Image` element — both forward unknown
 * props to their underlying DOM node.
 */
export function useZoomable(src: string, alt?: string) {
  const lightbox = useLightbox();

  const open = useCallback(
    (event: { stopPropagation: () => void }) => {
      // The chat bubble has its own click affordances; a zoom tap is not one.
      event.stopPropagation();
      lightbox?.open({ src, alt });
    },
    [lightbox, src, alt],
  );

  return useMemo(
    () => ({
      className: "cursor-zoom-in",
      title: alt ? `Zoom: ${alt}` : "Tap to zoom",
      "aria-label": alt ? `Zoom image: ${alt}` : "Zoom image",
      role: "button" as const,
      tabIndex: 0,
      onClick: (event: React.MouseEvent) => open(event),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event);
        }
      },
    }),
    [open, alt],
  );
}

/** Wraps the app (or a subtree) so descendants can open the lightbox. */
export function LightboxProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<LightboxItem | null>(null);
  const api = useMemo<LightboxApi>(() => ({ open: setItem }), []);
  const close = useCallback(() => setItem(null), []);

  return (
    <LightboxContext.Provider value={api}>
      {children}
      {item ? <LightboxOverlay item={item} onClose={close} /> : null}
    </LightboxContext.Provider>
  );
}

function LightboxOverlay({ item, onClose }: { item: LightboxItem; onClose: () => void }) {
  const [scale, setScale] = useState(MIN_SCALE);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Latest committed transform. Gesture handlers read this instead of the
  // render closure so a fast pinch never computes from a stale scale.
  const live = useRef({ scale, pan });
  live.current = { scale, pan };

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const moved = useRef(false);

  /** Zoom to `next`, keeping the viewport point (cx, cy) fixed on screen. */
  const applyScale = useCallback((next: number, cx: number, cy: number) => {
    const { scale: s0, pan: p0 } = live.current;
    const s1 = clamp(next, MIN_SCALE, MAX_SCALE);
    if (Math.abs(s1 - s0) < 1e-4) return;

    const cx0 = window.innerWidth / 2;
    const cy0 = window.innerHeight / 2;
    const lim = panLimit(s1);
    const nx = clamp(p0.x + (cx - cx0 - p0.x) * (1 - s1 / s0), -lim, lim);
    const ny = clamp(p0.y + (cy - cy0 - p0.y) * (1 - s1 / s0), -lim, lim);

    live.current = { scale: s1, pan: { x: nx, y: ny } };
    setScale(s1);
    setPan({ x: nx, y: ny });
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      applyScale(live.current.scale * factor, window.innerWidth / 2, window.innerHeight / 2);
    },
    [applyScale],
  );

  const reset = useCallback(() => {
    live.current = { scale: MIN_SCALE, pan: { x: 0, y: 0 } };
    setScale(MIN_SCALE);
    setPan({ x: 0, y: 0 });
  }, []);

  // Scroll lock + keyboard. Capture phase so Esc beats any outer handler.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "+" || event.key === "=") {
        zoomBy(1.4);
      } else if (event.key === "-" || event.key === "_") {
        zoomBy(1 / 1.4);
      } else if (event.key === "0") {
        reset();
      }
    };

    window.addEventListener("keydown", onKey, true);
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, zoomBy, reset]);

  // NOTE: deliberately NO `setPointerCapture` here. Capturing on the overlay
  // retargets the ensuing `click` to the overlay itself, so tapping a toolbar
  // button was read as a backdrop tap and dismissed the lightbox. The overlay
  // is full-viewport, so pointer events bubble to it anyway.
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moved.current = false;

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: live.current.scale,
      };
      drag.current = null;
    } else if (pointers.current.size === 1) {
      drag.current = {
        x: event.clientX,
        y: event.clientY,
        panX: live.current.pan.x,
        panY: live.current.pan.y,
      };
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const tracked = pointers.current.get(event.pointerId);
    if (!tracked) return;

    if (Math.hypot(event.clientX - tracked.x, event.clientY - tracked.y) > 4) {
      moved.current = true;
    }
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      applyScale(
        (pinch.current.scale * dist) / pinch.current.dist,
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
      );
      return;
    }

    // A lost pointerup (mouse released outside the window) would otherwise leave
    // the drag armed; `buttons === 0` means the gesture is already over.
    if (event.buttons === 0) {
      drag.current = null;
      pinch.current = null;
      return;
    }

    if (drag.current && live.current.scale > MIN_SCALE) {
      const lim = panLimit(live.current.scale);
      const nx = clamp(drag.current.panX + (event.clientX - drag.current.x), -lim, lim);
      const ny = clamp(drag.current.panY + (event.clientY - drag.current.y), -lim, lim);
      live.current = { scale: live.current.scale, pan: { x: nx, y: ny } };
      setPan({ x: nx, y: ny });
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  }

  /** True when the gesture that just ended was a drag, not a tap. */
  function consumedAsDrag(): boolean {
    if (!moved.current) return false;
    moved.current = false;
    return true;
  }

  /** Tap the image → zoom in on that point; tap again → back to fit. */
  function onImageClick(event: React.MouseEvent<HTMLImageElement>) {
    if (consumedAsDrag()) return;
    // `detail > 1` is the second half of a double-click. Letting it through
    // would toggle the zoom twice and cancel itself out.
    if (event.detail > 1) return;
    applyScale(
      live.current.scale > MIN_SCALE ? MIN_SCALE : TAP_SCALE,
      event.clientX,
      event.clientY,
    );
  }

  /** Tap outside the image → dismiss. */
  function onBackdropClick() {
    if (consumedAsDrag()) return;
    onClose();
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    applyScale(
      live.current.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
      event.clientX,
      event.clientY,
    );
  }

  const zoomed = scale > MIN_SCALE;
  const percent = Math.round(scale * 100);

  return createPortal(
    <div
      ref={overlayRef}
      data-testid="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={item.alt || item.title ? `Image: ${item.alt || item.title}` : "Image preview"}
      className="fixed inset-0 z-[60] flex touch-none select-none items-center justify-center overflow-hidden bg-black/90 backdrop-blur-sm"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      {/* Backdrop is its own layer: taps land on it only when they miss the
          image, so a toolbar tap can never be mistaken for a dismiss. */}
      <div
        data-testid="lightbox-backdrop"
        aria-hidden="true"
        className="absolute inset-0"
        onClick={onBackdropClick}
      />

      <img
        data-lightbox-image
        src={item.src}
        alt={item.alt ?? item.title ?? ""}
        draggable={false}
        onClick={onImageClick}
        className={cn(
          "relative z-[1] max-h-[92vh] max-w-[92vw] object-contain shadow-2xl",
          zoomed ? "cursor-move" : "cursor-zoom-in",
        )}
        style={{
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
          transformOrigin: "center center",
          willChange: "transform",
        }}
      />

      <button
        ref={closeRef}
        type="button"
        data-testid="lightbox-close"
        aria-label="Close image preview"
        onClick={onClose}
        className="safe-top absolute right-3 top-3 z-[2] rounded-full border border-white/15 bg-black/60 p-2.5 text-white transition-colors hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
      >
        <X className="size-5" />
      </button>

      <div className="safe-bottom pointer-events-none absolute inset-x-0 bottom-0 z-[2] flex justify-center p-4">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/15 bg-black/60 p-1 text-white backdrop-blur">
          <button
            type="button"
            data-testid="lightbox-zoom-out"
            aria-label="Zoom out"
            disabled={!zoomed}
            onClick={() => zoomBy(1 / 1.4)}
            className="rounded-full p-2 transition-colors hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ZoomOut className="size-4" />
          </button>
          <span
            data-testid="lightbox-zoom-level"
            className="min-w-[3.25rem] text-center text-xs tabular-nums text-white/80"
          >
            {percent}%
          </span>
          <button
            type="button"
            data-testid="lightbox-zoom-in"
            aria-label="Zoom in"
            disabled={scale >= MAX_SCALE}
            onClick={() => zoomBy(1.4)}
            className="rounded-full p-2 transition-colors hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            data-testid="lightbox-reset"
            aria-label="Reset zoom"
            disabled={!zoomed && pan.x === 0 && pan.y === 0}
            onClick={reset}
            className="rounded-full p-2 transition-colors hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <RotateCcw className="size-4" />
          </button>
          {item.href && (
            <a
              data-testid="lightbox-source"
              href={item.href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => event.stopPropagation()}
              className="flex items-center gap-1 rounded-full px-2.5 py-2 text-xs font-medium transition-colors hover:bg-white/15"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              <span>Source</span>
            </a>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { ExternalLink, ImageOff } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { AskMedia } from "@/lib/ask";
import { useLightbox } from "@/lib/lightbox";
import { proxiedImage } from "@/lib/mediaProxy";
import { cn } from "@/lib/utils";

/**
 * The answer's media.
 */

/**
 * How many thumbs the rail shows before the "View N more" tile.
 */
const RAIL_THUMB_COUNT = 3;

/**
 * The number of thumbs at which the "View N more" tile appears — more than
 * four images means the grid overflows, so the first three become clickable
 * tiles and the rest hide behind the tile.
 */
const RAIL_MORE_THRESHOLD = RAIL_THUMB_COUNT + 1;

/** The image an item actually points at, in preference order. */
function imageSrc(item: AskMedia): string {
  return item.img_src || item.thumb || item.url || "";
}

/**
 * The page a video tile opens.
 *
 * The provider's own page wins. A bare embed URL is turned back into the
 * watch page for YouTube, because the embed is what was failing.
 */
export function videoHref(item: AskMedia): string | null {
  if (item.url) return item.url;

  const raw = item.iframeUrl || item.iframe_src;
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, "");
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const match = url.pathname.match(/\/embed\/([^/?#]+)/);
      if (match) return `https://www.youtube.com/watch?v=${match[1]}`;
    }
  } catch {
    /* not an absolute URL — the raw value is still the best we have */
  }

  return raw;
}

/**
 * One thumbnail.
 *
 * The bytes are fetched by the GATEWAY and served from this origin (spec
 * 152 §A): pointing the browser straight at the result host left the rail
 * full of empty boxes, because many of them refuse hotlinking. A thumbnail
 * that cannot be fetched leaves a placeholder — never an empty box.
 */
function Thumb({
  src,
  alt,
  title,
  className,
}: {
  src?: string;
  alt?: string;
  title?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);

  if (!src || broken) {
    return (
      <div
        data-testid="ask-media-thumb-missing"
        className={cn(
          "flex h-full w-full items-center justify-center bg-muted/40 text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="size-4 shrink-0" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={proxiedImage(src)}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      onError={() => setBroken(true)}
      className={className}
    />
  );
}

/** One video tile — a link to the provider page, never an embed. */
function VideoTile({ item, className }: { item: AskMedia; className?: string }) {
  const src = item.thumb || item.img_src || "";
  const href = videoHref(item);

  const body = (
    <>
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {src ? (
          <Thumb
            src={src}
            alt={item.title || ""}
            className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Video
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-full bg-black/60 px-2 py-1 text-xs text-white">Play</div>
        </div>
        <ExternalLink
          className="absolute right-1.5 top-1.5 size-3.5 text-white drop-shadow"
          aria-hidden="true"
        />
      </div>
      <div className="flex items-center gap-1 p-2">
        <span
          className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
          title={item.title}
        >
          {item.title || href || "Video"}
        </span>
      </div>
    </>
  );

  if (!href) {
    return (
      <div
        data-testid="ask-media-video-static"
        className={cn("overflow-hidden rounded-lg border bg-card", className)}
      >
        {body}
      </div>
    );
  }

  return (
    <a
      data-testid="ask-media-video-link"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "group block overflow-hidden rounded-lg border bg-card transition-colors hover:bg-accent/50",
        className,
      )}
    >
      {body}
    </a>
  );
}

export function AskMediaView({
  media,
  variant,
  toolbar,
}: {
  media: AskMedia[];
  /** `rail` on desktop (a right column), `strip` on mobile (under the answer). */
  variant: "rail" | "strip";
  /**
   * The refresh buttons, drawn at the top of the rail — the rail's first
   * slot, above the image grid and the videos (Uttaram's order).
   */
  toolbar?: ReactNode;
}) {
  const lightbox = useLightbox();

  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");
  const hasMedia = media.length > 0;

  const openImage = (item: AskMedia) => {
    const src = imageSrc(item);
    if (!src) return;
    lightbox?.open({
      src: proxiedImage(src),
      href: item.url || undefined,
      alt: item.title || "",
      title: item.title || "",
    });
  };

  if (variant === "rail") {
    // The rail exists only when there is media to draw or a toolbar to show —
    // never an empty aside, never a reserved gutter.
    if (!hasMedia && !toolbar) return null;

    const visibleImages =
      images.length > RAIL_MORE_THRESHOLD ? images.slice(0, RAIL_THUMB_COUNT) : images;
    const showMore = images.length > RAIL_MORE_THRESHOLD;
    const moreCount = images.length - RAIL_THUMB_COUNT;

    return (
      <aside
        className="flex w-full shrink-0 flex-col gap-3 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:w-72"
        data-testid="ask-media-rail"
        aria-label="Media rail"
      >
        {toolbar}
        {hasMedia && images.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              {visibleImages.map((item, index) => {
                const src = imageSrc(item);
                const href = item.url || src;
                return (
                  <MediaThumb
                    key={`${href}-${index}`}
                    item={item}
                    onOpen={() => openImage(item)}
                    className="group relative block overflow-hidden rounded-lg border bg-card text-left"
                  />
                );
              })}
              {showMore && (
                <button
                  type="button"
                  data-testid="ask-media-more"
                  onClick={() => openImage(images[RAIL_THUMB_COUNT])}
                  className="flex w-full flex-col justify-between rounded-lg border bg-card p-2 text-left transition-colors hover:bg-accent/50"
                >
                  <span className="flex flex-row items-center gap-1">
                    {images.slice(RAIL_THUMB_COUNT, RAIL_THUMB_COUNT + 3).map((image, i) => (
                      <span key={i} className="aspect-video h-6 w-12 overflow-hidden rounded-md">
                        <Thumb
                          src={imageSrc(image)}
                          alt={image.title || ""}
                          className="h-full w-full object-cover"
                        />
                      </span>
                    ))}
                  </span>
                  <span className="text-xs text-muted-foreground">View {moreCount} more</span>
                </button>
              )}
            </div>
          </div>
        )}
        {hasMedia && videos.length > 0 && (
          <div className="flex flex-col gap-2">
            {videos.map((item, index) => (
              <VideoTile key={`${item.url}-${index}`} item={item} />
            ))}
          </div>
        )}
        {hasMedia && images.length === 0 && videos.length === 0 && !toolbar && (
          <div className="text-xs text-muted-foreground">No media found</div>
        )}
      </aside>
    );
  }

  if (!hasMedia) return null;

  return (
    <div className={cn("flex flex-col gap-3")} data-testid="ask-media-strip" aria-label="Media strip">
      {images.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Images</div>
          <div
            data-testid="ask-media-image-track"
            className="flex w-full max-w-full touch-pan-x snap-x snap-mandatory flex-row gap-2 overflow-x-auto overscroll-x-contain pb-1"
          >
            {images.map((item, index) => {
              const src = imageSrc(item);
              const href = item.url || src;
              return (
                <MediaThumb
                  key={`${href}-${index}`}
                  item={item}
                  onOpen={() => openImage(item)}
                  className="group relative block w-40 shrink-0 snap-start overflow-hidden rounded-lg border bg-card text-left sm:w-48"
                />
              );
            })}
          </div>
        </div>
      )}
      {videos.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Videos</div>
          <div
            data-testid="ask-media-video-track"
            className="flex w-full max-w-full touch-pan-x snap-x snap-mandatory flex-row gap-2 overflow-x-auto overscroll-x-contain pb-1"
          >
            {videos.map((item, index) => (
              <VideoTile
                key={`${item.url}-${index}`}
                item={item}
                className="w-64 shrink-0 snap-start sm:w-72"
              />
            ))}
          </div>
        </div>
      )}
      {images.length === 0 && videos.length === 0 && (
        <div className="text-xs text-muted-foreground">No media found</div>
      )}
    </div>
  );
}

/**
 * One media thumbnail — shared by the desktop rail and the mobile strip
 * (spec 164). Only the placement className differs; the markup, the test id
 * and the lightbox wiring are declared once.
 */
function MediaThumb({
  item,
  onOpen,
  className,
}: {
  item: AskMedia;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid="ask-media-thumb"
      onClick={onOpen}
      className={className}
    >
      <div className="relative aspect-video w-full overflow-hidden">
        <Thumb
          src={imageSrc(item)}
          alt={item.title || ""}
          title={item.title || ""}
          className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
        />
      </div>
      {item.title && (
        <div className="truncate p-1 text-[10px] text-muted-foreground">{item.title}</div>
      )}
    </button>
  );
}

export default AskMediaView;

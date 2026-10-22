import { ImageOff } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import type { AskMedia } from "@/lib/ask";
import { proxiedImage } from "@/lib/mediaProxy";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

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
  const [videoOpen, setVideoOpen] = useState(false);
  const [activeVideo, setActiveVideo] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [activeImage, setActiveImage] = useState<AskMedia | null>(null);

  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");
  const hasMedia = media.length > 0;

  if (variant === "rail") {
    // The rail exists only when there is media to draw or a toolbar to show —
    // never an empty aside, never a reserved gutter.
    if (!hasMedia && !toolbar) return null;

    const openImage = (item: AskMedia) => {
      setActiveImage(item);
      setImageOpen(true);
    };

    const visibleImages =
      images.length > RAIL_MORE_THRESHOLD ? images.slice(0, RAIL_THUMB_COUNT) : images;
    const showMore = images.length > RAIL_MORE_THRESHOLD;
    const moreCount = images.length - RAIL_THUMB_COUNT;

    return (
      <aside
        className="flex w-full shrink-0 flex-col gap-3 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:w-72"
        data-testid="ask-media-rail"
        aria-label="Media"
      >
        {toolbar}
        {hasMedia && images.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              {visibleImages.map((item, index) => {
                const src = item.img_src || item.thumb || item.url;
                const href = item.url || src;
                return (
                  <button
                    key={`${href}-${index}`}
                    type="button"
                    data-testid="ask-media-thumb"
                    onClick={() => openImage(item)}
                    className="group relative block overflow-hidden rounded-lg border bg-card text-left"
                  >
                    <div className="relative aspect-video w-full overflow-hidden">
                      <Thumb
                        src={src}
                        alt={item.title || ""}
                        title={item.title || ""}
                        className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                    </div>
                    {item.title && (
                      <div className="truncate p-1 text-[10px] text-muted-foreground">
                        {item.title}
                      </div>
                    )}
                  </button>
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
                          src={image.img_src || image.thumb || image.url}
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
            {videos.map((item, index) => {
              const src = item.thumb || item.img_src || "";
              const iframeSrc = item.iframeUrl || item.iframe_src;
              return (
                <div
                  key={`${item.url}-${index}`}
                  className="overflow-hidden rounded-lg border bg-card"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (iframeSrc) {
                        setActiveVideo(iframeSrc);
                        setVideoOpen(true);
                      } else if (item.url) {
                        window.open(item.url, "_blank", "noopener,noreferrer");
                      }
                    }}
                    className="group relative block w-full"
                  >
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
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="rounded-full bg-black/60 px-2 py-1 text-xs text-white">Play</div>
                    </div>
                  </button>
                  <div className="flex items-center justify-between gap-2 p-1">
                    <div className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={item.title}>
                      {item.title || item.url}
                    </div>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[10px] text-primary hover:underline"
                    >
                      Open
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {hasMedia && images.length === 0 && videos.length === 0 && !toolbar && (
          <div className="text-xs text-muted-foreground">No media found</div>
        )}
        <Dialog open={imageOpen} onOpenChange={setImageOpen}>
          <DialogContent data-testid="ask-media-image-dialog" className="max-w-3xl">
            {activeImage && (
              <>
                <DialogTitle>{activeImage.title || "Image"}</DialogTitle>
                <img
                  src={proxiedImage(activeImage.img_src || activeImage.thumb || activeImage.url)}
                  alt={activeImage.title || ""}
                  className="aspect-video w-full rounded-lg object-cover"
                />
              </>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={videoOpen} onOpenChange={setVideoOpen}>
          <DialogContent className="max-w-3xl">
            {activeVideo && (
              <iframe
                src={activeVideo}
                title="Video"
                className="aspect-video w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            )}
          </DialogContent>
        </Dialog>
      </aside>
    );
  }

  if (!hasMedia) return null;

  return (
    <div className={cn("flex flex-col gap-3")} data-testid="ask-media-strip" aria-label="Media">
      {images.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Images</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((item, index) => {
              const src = item.img_src || item.thumb || item.url;
              const href = item.url || src;
              return (
                <a
                  key={`${href}-${index}`}
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group relative block overflow-hidden rounded-lg border bg-card"
                >
                  <div className="relative aspect-video w-full overflow-hidden">
                    <Thumb
                      src={src}
                      alt={item.title || ""}
                      title={item.title || ""}
                      className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  </div>
                  {item.title && (
                    <div className="truncate p-1 text-[10px] text-muted-foreground">
                      {item.title}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </div>
      )}
      {videos.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Videos</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {videos.map((item, index) => {
              const src = item.thumb || item.img_src || "";
              const iframeSrc = item.iframeUrl || item.iframe_src;
              return (
                <div
                  key={`${item.url}-${index}`}
                  className="overflow-hidden rounded-lg border bg-card"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (iframeSrc) {
                        setActiveVideo(iframeSrc);
                        setVideoOpen(true);
                      } else if (item.url) {
                        window.open(item.url, "_blank", "noopener,noreferrer");
                      }
                    }}
                    className="group relative block w-full"
                  >
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
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="rounded-full bg-black/60 px-2 py-1 text-xs text-white">Play</div>
                    </div>
                  </button>
                  <div className="flex items-center justify-between gap-2 p-2">
                    <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={item.title}>
                      {item.title || item.url}
                    </div>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-primary hover:underline"
                    >
                      Open
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {images.length === 0 && videos.length === 0 && (
        <div className="text-xs text-muted-foreground">No media found</div>
      )}
      <Dialog open={videoOpen} onOpenChange={setVideoOpen}>
        <DialogContent className="max-w-3xl">
          {activeVideo && (
            <iframe
              src={activeVideo}
              title="Video"
              className="aspect-video w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AskMediaView;

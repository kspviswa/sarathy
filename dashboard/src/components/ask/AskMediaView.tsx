import { useState } from "react";
import type { AskMedia } from "@/lib/ask";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/**
 * The answer's media.
 */
export function AskMediaView({
  media,
  variant,
}: {
  media: AskMedia[];
  /** `rail` on desktop (a right column), `strip` on mobile (under the answer). */
  variant: "rail" | "strip";
}) {
  const [videoOpen, setVideoOpen] = useState(false);
  const [activeVideo, setActiveVideo] = useState<string | null>(null);

  if (!media || media.length === 0) return null;

  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");

  if (variant === "rail") {
    return (
      <aside
        className="hidden w-64 shrink-0 lg:block"
        data-testid="ask-media-rail"
        aria-label="Media"
      >
        <div className="sticky top-4 flex flex-col gap-3">
          {images.length > 0 && (
            <div className="flex flex-col gap-2">
              {images.length === 0 && (
                <div className="text-xs text-muted-foreground">No images found</div>
              )}
              <div className="grid grid-cols-2 gap-2">
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
                      <div className="aspect-video w-full overflow-hidden">
                        <img
                          src={src}
                          alt={item.title || ""}
                          title={item.title || ""}
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
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
                      <div className="aspect-video w-full overflow-hidden bg-muted">
                        {src ? (
                          <img
                            src={src}
                            alt={item.title || ""}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform group-hover:scale-105"
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
          {images.length === 0 && videos.length === 0 && (
            <div className="text-xs text-muted-foreground">No media found</div>
          )}
        </div>
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
                  <div className="aspect-video w-full overflow-hidden">
                    <img
                      src={src}
                      alt={item.title || ""}
                      title={item.title || ""}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
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
                    <div className="aspect-video w-full overflow-hidden bg-muted">
                      {src ? (
                        <img
                          src={src}
                          alt={item.title || ""}
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
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

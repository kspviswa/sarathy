import { useCallback, useMemo, useRef, useState } from "react";
import { Images, Loader2, Video } from "lucide-react";
import { buildAskHistory, fetchAskMedia, type AskTurn } from "@/lib/ask";
import { cn } from "@/lib/utils";

interface AskMediaButtonsProps {
  turn: AskTurn;
  turns: AskTurn[];
  threadId: string | null;
  onMediaLoaded: (turnId: string, media: any[]) => void;
}

type MediaState = {
  images: { status: "idle" | "loading" | "loaded" | "error"; items: any[]; error?: string } | null;
  videos: { status: "idle" | "loading" | "loaded" | "error"; items: any[]; error?: string } | null;
};

/**
 * The media of one turn.
 *
 * The buttons are the REFRESH: the media of a turn is fetched on its own
 * when the answer finishes (spec 152 §C — see `fetchAskMediaQuiet` in
 * `@/lib/ask`), so a button here is a retry, never the only way to see the
 * media.
 *
 * The fetch itself lives in `@/lib/ask` — the same call the automatic
 * fetch makes, so the two cannot drift apart.
 *
 * The bar is a single-line segmented action bar (spec 159 §C): ghost buttons
 * with an icon and a label, a spinner while searching, a count when loaded.
 */
export function AskMediaButtons({ turn, turns, threadId, onMediaLoaded }: AskMediaButtonsProps) {
  const [state, setState] = useState<MediaState>(() => {
    const existing = turn.media || [];
    if (!existing.length) return { images: null, videos: null };
    const imgs = existing.filter((m: any) => m.kind === "image");
    const vids = existing.filter((m: any) => m.kind === "video");
    return {
      images: imgs.length ? { status: "loaded", items: imgs } : null,
      videos: vids.length ? { status: "loaded", items: vids } : null,
    };
  });

  /**
   * What this component has loaded, per kind.
   *
   * The two kinds are fetched in PARALLEL, so neither of them can merge
   * into the other's result — the accumulator is the single copy both of
   * them publish from, and the last one to land carries both.
   */
  const loadedRef = useRef<{ images: any[]; videos: any[] }>({
    images: (turn.media || []).filter((m: any) => m.kind === "image"),
    videos: (turn.media || []).filter((m: any) => m.kind === "video"),
  });

  const history = useMemo(() => buildAskHistory(turns), [turns]);

  const fetchMedia = useCallback(
    async (kind: "images" | "videos") => {
      setState((prev) => ({
        ...prev,
        [kind === "images" ? "images" : "videos"]: {
          status: "loading",
          items: [],
        } as any,
      }));

      try {
        const items = await fetchAskMedia(kind, {
          query: turn.query,
          history,
          threadId,
          turnId: turn.id,
        });
        setState((prev) => ({
          ...prev,
          [kind === "images" ? "images" : "videos"]: { status: "loaded", items },
        }));
        // Publish the merged media for this turn — the accumulator holds
        // BOTH kinds, so the two fetches cannot lose each other.
        loadedRef.current[kind === "images" ? "images" : "videos"] = items;
        const merged = [...loadedRef.current.images, ...loadedRef.current.videos];
        onMediaLoaded(turn.id, merged);
      } catch (e: any) {
        setState((prev) => ({
          ...prev,
          [kind === "images" ? "images" : "videos"]: {
            status: "error",
            items: [],
            error: e?.message || "Failed to load media",
          } as any,
        }));
      }
    },
    [turn, history, threadId, onMediaLoaded],
  );

  const imagesLoading = state.images?.status === "loading";
  const videosLoading = state.videos?.status === "loading";
  const imagesLoaded = state.images?.status === "loaded";
  const videosLoaded = state.videos?.status === "loaded";
  const imagesError = state.images?.status === "error" ? state.images.error : null;
  const videosError = state.videos?.status === "error" ? state.videos.error : null;

  const imagesLabel = imagesLoading
    ? "Searching images…"
    : imagesLoaded
      ? `Images · ${state.images?.items.length ?? 0}`
      : "Search images";
  const videosLabel = videosLoading
    ? "Searching videos…"
    : videosLoaded
      ? `Videos · ${state.videos?.items.length ?? 0}`
      : "Search videos";

  const mediaButtonClass = cn(
    "flex h-9 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors hover:bg-accent",
  );

  return (
    <div className="flex flex-col gap-2" data-testid="ask-media-buttons">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="ask-media-images-btn"
          disabled={imagesLoading}
          onClick={() => void fetchMedia("images")}
          aria-pressed={imagesLoaded}
          className={cn(
            mediaButtonClass,
            imagesLoaded && !imagesLoading && "bg-accent text-foreground",
            imagesLoading && "opacity-70",
          )}
        >
          {imagesLoading ? <Loader2 className="size-4 animate-spin" /> : <Images className="size-4" />}
          <span>{imagesLabel}</span>
        </button>
        <button
          type="button"
          data-testid="ask-media-videos-btn"
          disabled={videosLoading}
          onClick={() => void fetchMedia("videos")}
          aria-pressed={videosLoaded}
          className={cn(
            mediaButtonClass,
            videosLoaded && !videosLoading && "bg-accent text-foreground",
            videosLoading && "opacity-70",
          )}
        >
          {videosLoading ? <Loader2 className="size-4 animate-spin" /> : <Video className="size-4" />}
          <span>{videosLabel}</span>
        </button>
      </div>
      {imagesError && <div className="text-xs text-destructive">Could not load images — {imagesError}</div>}
      {videosError && <div className="text-xs text-destructive">Could not load videos — {videosError}</div>}
    </div>
  );
}

export default AskMediaButtons;

import { useCallback, useMemo, useState } from "react";
import { Images, Video } from "lucide-react";
import { buildAskHistory, type AskTurn } from "@/lib/ask";
import { askAuthToken } from "@/lib/ask";
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

function mapImages(data: any): any[] {
  const list = Array.isArray(data?.images) ? data.images : [];
  return list
    .filter((item: any) => item && (item.url || item.img_src))
    .map((item: any) => ({
      kind: "image",
      url: item.url || item.img_src,
      img_src: item.img_src || item.url,
      thumb: item.img_src || item.thumb || item.url,
      title: item.title || "",
    }));
}

function mapVideos(data: any): any[] {
  const list = Array.isArray(data?.videos) ? data.videos : [];
  return list
    .filter((item: any) => item && (item.url || item.iframe_src))
    .map((item: any) => ({
      kind: "video",
      url: item.url,
      img_src: item.img_src || item.thumb,
      thumb: item.img_src || item.thumb,
      title: item.title || "",
      iframe_src: item.iframe_src,
      iframeUrl: item.iframe_src || item.iframeUrl,
    }));
}

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

  const history = useMemo(() => buildAskHistory(turns), [turns]);

  const fetchMedia = useCallback(
    async (kind: "images" | "videos") => {
      if (kind === "images" && state.images?.status === "loaded") {
        // collapse/expand behavior is handled by parent via state; second click shouldn't re-fetch
        return;
      }
      if (kind === "videos" && state.videos?.status === "loaded") {
        return;
      }

      setState((prev) => ({
        ...prev,
        [kind === "images" ? "images" : "videos"]: {
          status: "loading",
          items: [],
        } as any,
      }));

      try {
        const token = askAuthToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;

        const body: Record<string, unknown> = {
          query: turn.query,
          chatHistory: history && history.length ? history : [],
        };

        const res = await fetch(`/api/ask/${kind}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const message = (data as any)?.error || (data as any)?.message || `Request failed (${res.status})`;
          setState((prev) => ({
            ...prev,
            [kind === "images" ? "images" : "videos"]: {
              status: "error",
              items: [],
              error: message,
            } as any,
          }));
          return;
        }

        const data = await res.json();
        const items = kind === "images" ? mapImages(data) : mapVideos(data);
        setState((prev) => ({
          ...prev,
          [kind === "images" ? "images" : "videos"]: { status: "loaded", items },
        }));
        // persist merged media for this turn
        const existing = turn.media || [];
        const others = existing.filter((m: any) => m.kind !== (kind === "images" ? "image" : "video"));
        const merged = [...others, ...items];
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
    [turn, turns, history, state.images?.status, state.videos?.status, onMediaLoaded],
  );

  const imagesLoading = state.images?.status === "loading";
  const videosLoading = state.videos?.status === "loading";
  const imagesLoaded = state.images?.status === "loaded";
  const videosLoaded = state.videos?.status === "loaded";
  const imagesError = state.images?.status === "error" ? state.images?.error : null;
  const videosError = state.videos?.status === "error" ? state.videos?.error : null;

  return (
    <div className="flex flex-col gap-2" data-testid="ask-media-buttons">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="ask-media-images-btn"
          disabled={imagesLoading}
          onClick={() => void fetchMedia("images")}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
            imagesLoading ? "opacity-70" : "hover:bg-accent",
          )}
        >
          <Images className="size-4" />
          {imagesLoading ? "Loading..." : imagesLoaded ? "Images" : "Search images"}
        </button>
        <button
          type="button"
          data-testid="ask-media-videos-btn"
          disabled={videosLoading}
          onClick={() => void fetchMedia("videos")}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
            videosLoading ? "opacity-70" : "hover:bg-accent",
          )}
        >
          <Video className="size-4" />
          {videosLoading ? "Loading..." : videosLoaded ? "Videos" : "Search videos"}
        </button>
      </div>
      {imagesError && <div className="text-sm text-destructive">Could not load images — {imagesError}</div>}
      {videosError && <div className="text-sm text-destructive">Could not load videos — {videosError}</div>}
    </div>
  );
}

export default AskMediaButtons;

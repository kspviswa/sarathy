import { Download, Paperclip } from "lucide-react";

import { cn } from "@/lib/utils";

const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const AUDIO_EXTS = new Set([".ogg", ".mp3", ".m4a", ".wav", ".opus", ".webm"]);

function getMediaKind(p: string): "image" | "audio" | "file" {
  const ext = p.substring(p.lastIndexOf(".")).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "file";
}

function getFileName(p: string): string {
  return p.substring(p.lastIndexOf("/") + 1) || p;
}

/**
 * One chat attachment (spec 175 §E).
 *
 * Images render as a fixed square thumbnail (`object-cover`); audio and file
 * links keep their prior rendering. Shared by both shells so desktop/mobile
 * cannot drift.
 */
export function MediaAttachment({
  path,
  onPrimary = false,
}: {
  path: string;
  /** Inside a primary-filled (user) bubble — border uses primary-foreground. */
  onPrimary?: boolean;
}) {
  const kind = getMediaKind(path);
  const href = `/api/media?path=${encodeURIComponent(path)}`;
  const name = getFileName(path);

  if (kind === "image") {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "block size-20 shrink-0 overflow-hidden rounded-lg border",
          onPrimary ? "border-primary-foreground/25" : "border-border",
        )}
        data-testid="chat-media-thumb"
        title={name}
      >
        <img
          src={href}
          alt={name}
          className="size-full object-cover"
          loading="lazy"
        />
      </a>
    );
  }

  if (kind === "audio") {
    return (
      <audio controls src={href} className="my-1 w-full max-w-xs" />
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground hover:bg-muted"
    >
      <Paperclip className="size-4 shrink-0 sm:hidden" />
      <Download className="hidden size-4 sm:inline" />
      <span className="truncate">{name}</span>
    </a>
  );
}

/** Wrapping row of attachments (images sit as thumbs; others stack naturally). */
export function MediaAttachments({
  paths,
  onPrimary = false,
}: {
  paths: string[];
  onPrimary?: boolean;
}) {
  if (!paths.length) return null;
  return (
    <div
      className="flex flex-wrap gap-1.5"
      data-testid="chat-media-attachments"
    >
      {paths.map((p, i) => (
        <MediaAttachment key={i} path={p} onPrimary={onPrimary} />
      ))}
    </div>
  );
}

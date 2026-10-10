import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { api } from "@/lib/api";
import {
  filterCommands,
  completeSlashCommands,
  shouldSuggestSlash,
  type SlashCommand,
} from "@/lib/palette";
import { cn } from "@/lib/utils";

/**
 * Global Cmd+K / Ctrl+K command palette.
 *
 * Commands are fetched from the backend registry (`GET /api/commands`) rather
 * than hardcoded, so the palette can never advertise a command the agent does
 * not implement. Fetch failures degrade to an empty list instead of breaking
 * the app.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRun: (command: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    void api
      .commands()
      .then((res) => setCommands(res.commands ?? []))
      .catch(() => setCommands([]));
    // Focus after paint so the input is ready for the user immediately.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => setIndex(0), [query]);

  const run = (cmd: SlashCommand) => {
    if (!cmd) return;
    onRun(`/${cmd.name}`);
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 pt-[12vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
      data-testid="command-palette"
    >
      <div
        className="mx-4 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(results[index]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onOpenChange(false);
              }
            }}
            placeholder="Search commands…"
            aria-label="Search commands"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No commands match “{query}”
            </p>
          ) : (
            results.map((cmd, i) => (
              <button
                key={cmd.name}
                onClick={() => run(cmd)}
                onMouseEnter={() => setIndex(i)}
                className={cn(
                  "flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left",
                  i === index ? "bg-accent" : "hover:bg-accent/60",
                )}
                data-testid="palette-item"
              >
                <span className="font-mono text-sm font-medium text-foreground">
                  /{cmd.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {cmd.description}
                </span>
                {cmd.subcommands.length > 0 && (
                  <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
                    {cmd.subcommands.slice(0, 3).join(" · ")}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span className="ml-auto">{results.length} of {commands.length}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * `/` autocomplete shown inside the composer.
 *
 * Deliberately narrow: it only fires for a single `/token` at the very start of
 * the input, so it never fights the user mid-sentence.
 */
export function SlashAutocomplete({
  input,
  commands,
  activeIndex,
  onPick,
}: {
  input: string;
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (command: SlashCommand) => void;
}) {
  if (!shouldSuggestSlash(input) || commands.length === 0) return null;
  const token = input.trim();
  const results = completeSlashCommands(commands, token);

  if (results.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 z-40 mb-2 max-h-64 w-full min-w-[16rem] overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl"
      data-testid="slash-autocomplete"
    >
      {results.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          onMouseDown={(e) => {
            // mousedown, not click: blur would close the composer first.
            e.preventDefault();
            onPick(cmd);
          }}
          onMouseEnter={() => activeIndex}
          className={cn(
            "flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left",
            i === activeIndex && "bg-accent",
          )}
          data-testid="slash-item"
        >
          <span className="font-mono text-sm text-foreground">/{cmd.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  );
}
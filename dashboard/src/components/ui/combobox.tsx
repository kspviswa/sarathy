import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Optional group heading; consecutive options with the same group render under one divider. */
  group?: string;
  hint?: string;
}

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  /** Cap how many rows render for an empty query so huge lists stay fast. */
  maxRows?: number;
}

/**
 * Searchable single-select combobox (shadcn Popover + cmdk).
 *
 * Filtering is done here (not by cmdk) so we can cap the rendered rows: an
 * empty query on a 1000+ model list renders only the first `maxRows` with a
 * "keep typing" hint, while a query narrows instantly. This keeps both the
 * 3-model local list and the 500-model OpenRouter list usable.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  disabled = false,
  loading = false,
  className,
  maxRows = 200,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const matched = q
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q),
      )
    : options;
  const visible = matched.slice(0, maxRows);
  const truncated = matched.length > visible.length;

  const selected = options.find((o) => o.value === value);

  // Group the visible rows for section dividers.
  const groups = React.useMemo(() => {
    const out: { name: string | undefined; items: ComboboxOption[] }[] = [];
    for (const opt of visible) {
      const last = out[out.length - 1];
      if (last && last.name === opt.group) last.items.push(opt);
      else out.push({ name: opt.group, items: [opt] });
    }
    return out;
  }, [visible]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            // `h-auto min-h-9`, not `h-9`: a long selected value — a model id,
            // say — wraps instead of clipping, and the trigger grows to fit it
            // rather than cutting it off (spec 142 §A). With a short value the
            // `min-h-9` keeps the original height exactly.
            "flex h-auto min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span
            className={cn(
              "min-w-0 text-left",
              !selected && "text-muted-foreground",
            )}
          >
            {selected ? selected.label : placeholder}
          </span>
          {loading ? (
            <Loader2 className="size-4 shrink-0 animate-spin opacity-60" />
          ) : (
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 opacity-50" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            spellCheck={false}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {matched.length}
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto overscroll-contain p-1">
          {loading ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              Loading models…
            </p>
          ) : visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {emptyText}
            </p>
          ) : (
            groups.map((g, gi) => (
              <div key={g.name ?? `g${gi}`}>
                {g.name ? (
                  <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.name}
                  </p>
                ) : null}
                {g.items.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                      opt.value === value && "bg-accent/60",
                    )}
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        opt.value === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0">{opt.label}</span>
                    {opt.hint ? (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {opt.hint}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
          {truncated ? (
            <p className="px-2 py-2 text-center text-[11px] text-muted-foreground">
              Showing {visible.length} of {matched.length} — keep typing to
              narrow
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

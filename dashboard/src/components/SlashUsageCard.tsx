/**
 * Rich usage card for slash-command replies (spec 137 §A2/A4).
 *
 * This is a RENDER-TIME transform: the gateway keeps replying with the plain
 * text it always sent, and this component re-shapes that text into something
 * tappable. Every control calls `onSend("/<command> <sub>")` — the exact string
 * the composer would have typed — so nothing here needs a bespoke send path, and
 * a command the gateway later renames simply renders as plain text again.
 *
 * Deliberately NOT named `UsageCard`: that file is the token-usage telemetry
 * card used by StatusView, and the two must never be confused.
 *
 * The whole card lives in this one shared component so desktop and mobile
 * cannot drift — the two ChatViews only decide WHEN to mount it.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Info, Terminal } from "lucide-react";

import {
  matchSlashUsage,
  USAGE_CARD_DESIGN,
  type ParsedKeyValueRow,
  type SlashUsageMatch,
  type UsageExtraAction,
  type UsageControl,
  type UsageOption,
} from "@/lib/slashUsage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Detect a slash-usage reply in `content`.
 *
 * Memoised so a streaming bubble re-detects once per chunk rather than on every
 * render. Returns `null` for ordinary prose — the caller then renders markdown
 * exactly as before.
 */
export function useSlashUsage(content: string): SlashUsageMatch | null {
  return useMemo(() => matchSlashUsage(content), [content]);
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** A tappable row button — 40px tall so it is a real tap target on a phone. */
function OptionButton({
  label,
  sublabel,
  selected,
  onClick,
  testId,
}: {
  label: string;
  sublabel?: string;
  selected?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <Button
      type="button"
      variant={selected ? "default" : "outline"}
      className="h-10 w-full justify-start gap-2 px-3"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={selected}
    >
      {selected && <Check className="size-4" aria-hidden />}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {sublabel && (
        <span className="shrink-0 text-xs font-normal opacity-70">{sublabel}</span>
      )}
    </Button>
  );
}

/** A labelled `Key: value` row — the info card's whole vocabulary. */
function KeyValueRows({ rows }: { rows: ParsedKeyValueRow[] }) {
  return (
    <dl className="divide-y divide-border rounded-lg border border-border" data-testid="usage-rows">
      {rows.map((r, i) => (
        <div key={`${r.key}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{r.key}</dt>
          <dd className="min-w-0 flex-1 break-words text-sm">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A text prompt that sends `<prefix><text>`.
 *
 * Kept as one component because three different cards need it: a command's
 * free-text argument, `/model set …`, and `/provider role <role> …`.
 */
function PromptField({
  prefix,
  placeholder,
  submitLabel,
  testId,
  autoFocus,
  send,
}: {
  prefix: string;
  placeholder?: string;
  submitLabel: string;
  testId?: string;
  autoFocus?: boolean;
  send: (command: string) => void;
}) {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    setValue("");
    send(prefix + text);
  };

  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={`Command starting with ${prefix.trim()}`}
        data-testid={testId}
        onChange={(e) => setValue(e.target.value)}
        className="h-10 flex-1"
      />
      <Button type="submit" className="h-10" disabled={value.trim() === ""} data-testid={testId ? `${testId}-send` : undefined}>
        {submitLabel}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function ChipsControl({
  command,
  options,
  status,
  current,
  send,
}: {
  command: string;
  options: UsageOption[];
  status?: UsageOption;
  current?: string | null;
  send: (cmd: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-testid="usage-chips">
      {status && (
        <Button
          type="button"
          variant="secondary"
          className="h-10"
          onClick={() => send(`/${command} ${status.value}`)}
          data-testid={`usage-status-${command}`}
        >
          {status.label}
        </Button>
      )}
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          variant={current === o.value ? "default" : "outline"}
          aria-pressed={current === o.value}
          className="h-10"
          onClick={() => send(`/${command} ${o.value}`)}
          data-testid={`usage-chip-${o.value}`}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function ToggleControl({
  command,
  design,
  current,
  send,
}: {
  command: string;
  design: Extract<UsageControl, { kind: "toggle" }>;
  current?: string | null;
  send: (cmd: string) => void;
}) {
  const initial = /^on$|^enabled$|^true$|^yes$/i.test(current ?? "");
  const [checked, setChecked] = useState(initial);

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="usage-toggle">
      <span className="text-sm text-muted-foreground">{checked ? design.on.label : design.off.label}</span>
      <Switch
        checked={checked}
        aria-label={`/${command} ${design.on.label}/${design.off.label}`}
        onCheckedChange={(next) => {
          setChecked(next);
          send(`/${command} ${next ? design.on.value : design.off.value}`);
        }}
      />
      {design.status && (
        <Button
          type="button"
          variant="outline"
          className="h-10"
          onClick={() => send(`/${command} ${design.status!.value}`)}
          data-testid={`usage-status-${command}`}
        >
          {design.status.label}
        </Button>
      )}
    </div>
  );
}

function ModelListBody({ match, send }: { match: SlashUsageMatch; send: (cmd: string) => void }) {
  const [prompt, setPrompt] = useState<null | "set">(null);

  if (match.models) {
    return (
      <ul className="flex flex-col gap-2" data-testid="usage-models">
        {match.models.models.map((m) => (
          <li key={m}>
            <OptionButton
              label={m}
              testId={`usage-model-${m}`}
              onClick={() => send(`/model set ${m}`)}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {match.rows && match.rows.length > 0 && <KeyValueRows rows={match.rows} />}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-10" onClick={() => send("/model status")} data-testid="usage-model-status">
          Status
        </Button>
        <Button type="button" variant="outline" className="h-10" onClick={() => send("/model list")} data-testid="usage-model-list">
          List models
        </Button>
        <Button
          type="button"
          variant={prompt ? "default" : "outline"}
          className="h-10"
          onClick={() => setPrompt(prompt ? null : "set")}
          data-testid="usage-model-set"
        >
          Set…
        </Button>
      </div>
      {prompt === "set" && (
        <PromptField
          prefix="/model set "
          placeholder="Model name"
          submitLabel="Set model"
          autoFocus
          testId="usage-model-set-input"
          send={send}
        />
      )}
    </div>
  );
}

function ProviderListBody({ match, send }: { match: SlashUsageMatch; send: (cmd: string) => void }) {
  const [prompt, setPrompt] = useState<null | "models" | "set">(null);
  const [rolePrompt, setRolePrompt] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {match.rows && match.rows.length > 0 && <KeyValueRows rows={match.rows} />}

      {match.providers && (
        <ul className="flex flex-col gap-2" data-testid="usage-providers">
          {match.providers.map((p) => (
            <li key={p.name}>
              <OptionButton
                label={p.name}
                sublabel={p.active ? "active" : undefined}
                selected={p.active}
                testId={`usage-provider-${p.name}`}
                onClick={() => send(`/provider set ${p.name}`)}
              />
            </li>
          ))}
        </ul>
      )}

      {match.roles && (
        <div className="flex flex-col gap-2" data-testid="usage-roles">
          {match.roles.map((r) => (
            <div key={r.role} className="flex flex-col gap-2 rounded-lg border border-border p-2">
              <div className="flex items-center gap-2 px-1">
                <Badge variant="secondary">{r.role}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{r.provider}</span>
                {r.model && <span className="shrink-0 text-xs text-muted-foreground">{r.model}</span>}
              </div>
              {match.providers ? (
                <div className="flex flex-wrap gap-2">
                  {match.providers.map((p) => (
                    <Button
                      key={`${r.role}-${p.name}`}
                      type="button"
                      variant={r.provider === p.name ? "default" : "outline"}
                      className="h-10"
                      onClick={() => send(`/provider role ${r.role} ${p.name}`)}
                      data-testid={`usage-role-${r.role}-${p.name}`}
                    >
                      {p.name}
                    </Button>
                  ))}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 justify-start"
                  onClick={() => setRolePrompt(rolePrompt === r.role ? null : r.role)}
                  data-testid={`usage-role-set-${r.role}`}
                >
                  Set {r.role} provider…
                </Button>
              )}
              {rolePrompt === r.role && (
                <PromptField
                  prefix={`/provider role ${r.role} `}
                  placeholder="Provider name"
                  submitLabel="Set role"
                  autoFocus
                  testId={`usage-role-input-${r.role}`}
                  send={send}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-10" onClick={() => send("/provider status")} data-testid="usage-provider-status">
          Status
        </Button>
        <Button type="button" variant="outline" className="h-10" onClick={() => send("/provider list")} data-testid="usage-provider-list">
          List
        </Button>
        <Button type="button" variant="outline" className="h-10" onClick={() => send("/provider roles")} data-testid="usage-provider-roles">
          Roles
        </Button>
        <Button
          type="button"
          variant={prompt === "models" ? "default" : "outline"}
          className="h-10"
          onClick={() => setPrompt(prompt === "models" ? null : "models")}
          data-testid="usage-provider-models"
        >
          Models…
        </Button>
        <Button
          type="button"
          variant={prompt === "set" ? "default" : "outline"}
          className="h-10"
          onClick={() => setPrompt(prompt === "set" ? null : "set")}
          data-testid="usage-provider-set"
        >
          Set…
        </Button>
      </div>

      {prompt === "models" && (
        <PromptField
          prefix="/provider models "
          placeholder="Provider name"
          submitLabel="List models"
          autoFocus
          testId="usage-provider-models-input"
          send={send}
        />
      )}
      {prompt === "set" && (
        <PromptField
          prefix="/provider set "
          placeholder="Provider name [model]"
          submitLabel="Switch"
          autoFocus
          testId="usage-provider-set-input"
          send={send}
        />
      )}
    </div>
  );
}

function GridControl({ match, send }: { match: SlashUsageMatch; send: (cmd: string) => void }) {
  const commands = match.commands?.commands ?? [];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="usage-grid">
      {commands.map((c) => (
        <button
          key={c.name}
          type="button"
          onClick={() => send(`/${c.name}`)}
          data-testid={`usage-command-${c.name}`}
          className={cn(
            "flex min-h-10 flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2 text-left",
            "transition-colors hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span className="text-sm font-medium">/{c.name}</span>
          {c.description && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{c.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Destructive single action — armed first, so a phone mis-tap cannot restart. */
function DangerControl({ command, label, send }: { command: string; label: string; send: (cmd: string) => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      {armed && (
        <p className="text-xs text-muted-foreground">
          Tap again to confirm — this restarts the gateway service.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          className="h-10"
          onClick={() => {
            if (!armed) {
              setArmed(true);
              return;
            }
            send(`/${command}`);
          }}
          data-testid="usage-danger"
        >
          <AlertTriangle className="size-4" aria-hidden />
          {label}
        </Button>
        {armed && (
          <Button type="button" variant="ghost" className="h-10" onClick={() => setArmed(false)} data-testid="usage-danger-cancel">
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function ActionControl({ command, label, send }: { command: string; label: string; send: (cmd: string) => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-10"
      onClick={() => send(`/${command}`)}
      data-testid="usage-action"
    >
      {label}
    </Button>
  );
}

function PromptControl({
  command,
  design,
  match,
  send,
}: {
  command: string;
  design: Extract<UsageControl, { kind: "prompt" }>;
  match: SlashUsageMatch;
  send: (cmd: string) => void;
}) {
  const [extra, setExtra] = useState<UsageExtraAction | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{design.hint}</p>
      {match.prompt?.examples?.length ? (
        <p className="text-xs text-muted-foreground">{match.prompt.examples.join(" · ")}</p>
      ) : null}
      <PromptField
        prefix={`/${command} `}
        placeholder={design.placeholder}
        submitLabel="Send"
        testId={`usage-prompt-${command}`}
        send={send}
      />
      {design.extras && design.extras.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {design.extras.map((a) => (
            <Button
              key={a.label}
              type="button"
              variant="ghost"
              className="h-10"
              onClick={() => {
                if (a.command) send(a.command);
                else setExtra(extra === a ? null : a);
              }}
              data-testid={`usage-extra-${a.label.replace(/\W+/g, "-").toLowerCase()}`}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {extra?.prefix && (
        <PromptField
          prefix={extra.prefix}
          placeholder="Provider name [model]"
          submitLabel="Apply"
          autoFocus
          testId="usage-extra-input"
          send={send}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * Render the rich usage card for a recognised slash-command reply.
 *
 * Returns `null` when the command has no design entry — the caller keeps today's
 * plain markdown rendering, so an unknown command is never a dead end.
 */
export function SlashUsageCard({
  parsed,
  onSend: sendProp,
}: {
  parsed: SlashUsageMatch;
  onSend?: (message: string) => void;
}) {
  const design = parsed.command ? USAGE_CARD_DESIGN[parsed.command] : undefined;
  if (!design || !sendProp) return null;

  const send = (cmd: string) => sendProp(cmd);
  const command = parsed.command;

  return (
    <div
      className="slash-usage not-prose my-2 flex flex-col gap-3 rounded-xl border border-border bg-card p-3 text-card-foreground shadow-sm"
      data-testid="slash-usage-card"
      data-slash-command={command}
      data-slash-kind={design.kind}
    >
      <div className="flex items-center gap-2">
        <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm font-semibold">{parsed.title || `/${command}`}</span>
        {parsed.kind === "setup" && (
          <Badge variant="destructive" className="ml-auto">
            setup required
          </Badge>
        )}
      </div>

      {parsed.help?.description && (
        <p className="text-sm text-muted-foreground">{parsed.help.description}</p>
      )}
      {parsed.hint && (
        <p className="text-sm text-muted-foreground" data-testid="usage-hint">
          {parsed.hint}
        </p>
      )}

      {design.kind === "chips" && (
        <ChipsControl command={command} options={design.options} status={design.status} current={parsed.current} send={send} />
      )}
      {design.kind === "toggle" && (
        <ToggleControl command={command} design={design} current={parsed.current} send={send} />
      )}
      {design.kind === "list" &&
        (command === "model" ? (
          <ModelListBody match={parsed} send={send} />
        ) : (
          <ProviderListBody match={parsed} send={send} />
        ))}
      {design.kind === "grid" && <GridControl match={parsed} send={send} />}
      {design.kind === "info" && parsed.rows && <KeyValueRows rows={parsed.rows} />}
      {design.kind === "info" && !parsed.rows && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="size-4" aria-hidden /> No details reported.
        </p>
      )}
      {design.kind === "danger" && <DangerControl command={command} label={design.label} send={send} />}
      {design.kind === "action" && <ActionControl command={command} label={design.label} send={send} />}
      {design.kind === "prompt" && <PromptControl command={command} design={design} match={parsed} send={send} />}
    </div>
  );
}

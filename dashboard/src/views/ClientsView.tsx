import { HardDrive, Loader2, Monitor, Plus, RefreshCw, ShieldOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { ScFleetSummary, ScNode } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * ClientsView — the Sarathy Clients fleet (design/SARATHY_CLIENTS_SPEC.md
 * section 9; job spec section H).
 *
 * Scope is deliberately the fleet-management slice only: who is out there, what
 * each node says it can do, what it has been granted, and two human actions
 * (add a node, revoke one). Job submission and sub-agents are later phases and
 * deliberately absent — a fleet view that pretends to be a job console would be
 * worse than one that does not pretend.
 *
 * Two rules the UI has to respect:
 *
 * 1. **Health is derived, not stored.** The gateway computes online/stale/offline
 *    from `last_seen` against the watchdog grace, so the badge is never a cached
 *    opinion that can disagree with reality.
 * 2. **A grant shown here is a mirror.** The authority lives on the node. The
 *    header says so, because "I can see it" easily reads as "I can change it".
 */

/* ------------------------------------------------------------------ helpers */

/** Badge variant for a health value. Exported for the unit tests. */
export function healthBadgeClass(health: string): string {
  switch (health) {
    case "online":
      return "border-green-500/40 bg-green-500/15 text-green-600 dark:text-green-400";
    case "stale":
      return "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400";
    default:
      return "border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-400";
  }
}

/** Badge variant for a risk class. `deny` is shown in red even though it can never
 *  appear on a working node — seeing it is itself information. */
export function riskBadgeClass(risk: string): string {
  switch (risk) {
    case "auto":
      return "border-green-500/40 bg-green-500/15 text-green-600 dark:text-green-400";
    case "ask":
      return "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400";
    default:
      return "border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-400";
  }
}

/**
 * Whether the registry's stored state adds anything to the health badge.
 *
 * `pending` and `pairing` are real states with no health equivalent (a node that
 * has never been seen is `offline` but is also *not yet paired*, which is a
 * different conversation). `revoked` is likewise its own fact. For the steady
 * states — online / offline — the badge would only restate health.
 */
export function showState(node: ScNode): boolean {
  return node.state !== "online" && node.state !== "offline";
}

function stateBadgeClass(state: string): string {
  if (state === "revoked") {
    return "border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-400";
  }
  if (state === "pending") {
    return "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400";
  }
  return "border-border bg-muted text-muted-foreground";
}

function formatRelative(iso: string | null, ageSeconds: number | null): string {
  if (ageSeconds !== null && ageSeconds !== undefined) {
    if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
    if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
    if (ageSeconds < 86400) return `${Math.round(ageSeconds / 3600)}h ago`;
    return `${Math.round(ageSeconds / 86400)}d ago`;
  }
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function platformLabel(node: ScNode): string {
  const parts = [node.platform, node.arch].filter(Boolean);
  return parts.length ? parts.join(" · ") : "unknown platform";
}

/** Sort: healthy and live first, then stale, then offline, then revoked. */
const HEALTH_ORDER: Record<string, number> = { online: 0, stale: 1, offline: 2 };

function sortNodes(nodes: ScNode[]): ScNode[] {
  return [...nodes].sort((a, b) => {
    const health = (HEALTH_ORDER[a.health] ?? 3) - (HEALTH_ORDER[b.health] ?? 3);
    if (health !== 0) return health;
    return a.name.localeCompare(b.name);
  });
}

/* ------------------------------------------------------------------- summary */

function SummaryRow({ summary, grace }: { summary: ScFleetSummary | null; grace: number }) {
  if (!summary) return null;
  const cells: Array<[string, number, string]> = [
    ["Total", summary.total, "text-foreground"],
    ["Online", summary.online, "text-green-600 dark:text-green-400"],
    ["Stale", summary.stale, "text-amber-600 dark:text-amber-400"],
    ["Offline", summary.offline, "text-red-600 dark:text-red-400"],
    ["Revoked", summary.revoked, "text-muted-foreground"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="sc-summary">
      {cells.map(([label, value, tone]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <span className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      ))}
      <span className="ml-auto text-xs text-muted-foreground">
        stale after {Math.round(grace)}s without a heartbeat
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- add form */

function AddNodeCard({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [pairingKey, setPairingKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const id = nodeId.trim();
    if (!id) {
      toast.error("A node id is required");
      return;
    }
    setBusy(true);
    try {
      const res = await api.sc.add({ node_id: id, name: name.trim() || undefined });
      // The key is shown exactly once and is not recoverable — surface it in a way
      // that cannot be mistaken for something still available later.
      setPairingKey(res.pairing_key);
      setNodeId("");
      setName("");
      toast.success(`Added ${res.node.name}`);
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add node");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="sc-add-open">
          <Plus /> Add node
        </Button>
      </div>
    );
  }

  return (
    <Card data-testid="sc-add-card">
      <CardHeader>
        <CardTitle className="text-sm">Add a node</CardTitle>
        <CardDescription>
          Registers the node id and generates a pairing key. Paste it into the node with
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">sc pair --code &lt;key&gt;</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input
            className="w-48"
            placeholder="node id (matches node.id)"
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
            aria-label="Node id"
            data-testid="sc-add-id"
          />
          <Input
            className="w-48"
            placeholder="display name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Display name"
            data-testid="sc-add-name"
          />
          <Button size="sm" onClick={() => void submit()} disabled={busy} data-testid="sc-add-submit">
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Generate pairing key
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            <X /> Close
          </Button>
        </div>

        {pairingKey && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            data-testid="sc-add-key"
          >
            <p className="font-semibold text-amber-700 dark:text-amber-300">
              Pairing key — shown once, not stored
            </p>
            <p className="mt-1 font-mono text-sm break-all">{pairingKey}</p>
            <p className="mt-1 text-muted-foreground">
              The gateway keeps only its SHA-256. If it is lost, revoke the node and add it again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- revoke modal */

function RevokeButton({ node, onDone }: { node: ScNode; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function revoke() {
    setBusy(true);
    try {
      const res = await api.sc.revoke(node.id);
      toast.success(
        res.session_closed
          ? `Revoked ${node.name} and closed its connection`
          : `Revoked ${node.name}`,
      );
      setConfirming(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke node");
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setConfirming(true)}
        data-testid={`sc-revoke-${node.id}`}
      >
        <ShieldOff /> Revoke
      </Button>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2" data-testid={`sc-revoke-confirm-${node.id}`}>
      {/* One string, not three adjacent nodes: JSX collapses the surrounding
          whitespace unpredictably around an inline element, which rendered as
          "Revoke home  mac?" with a doubled space. */}
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {`Revoke ${node.name}?`}
      </span>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => void revoke()}
        disabled={busy}
        data-testid={`sc-revoke-confirm-yes-${node.id}`}
      >
        {busy ? <Loader2 className="animate-spin" /> : <ShieldOff />} Revoke
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </div>
  );
}

/* --------------------------------------------------------------- node table */

function NodeRow({ node, onDone }: { node: ScNode; onDone: () => void }) {
  const capabilities = node.capabilities ?? [];
  return (
    <tr data-testid={`sc-node-${node.id}`} className="align-top">
      <td className="py-3 pr-3">
        <div className="flex items-center gap-2">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate font-medium" title={node.id}>
              {node.name}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">{node.id}</div>
          </div>
        </div>
      </td>

      <td className="py-3 pr-3">
        {/* The health badge is the derived truth; the state badge is only shown when
            it says something health does not. Showing both unconditionally produced
            rows that read "stale" and "offline" side by side — the registry's stored
            state and its derived health are genuinely different facts, but two
            disagreeing badges on one row read as a bug rather than as nuance. */}
        <div className="flex flex-col items-start gap-1">
          <Badge className={cn("w-fit", healthBadgeClass(node.health))} data-testid={`sc-health-${node.id}`}>
            {node.health}
          </Badge>
          {showState(node) && (
            <Badge className={cn("w-fit", stateBadgeClass(node.state))} data-testid={`sc-state-${node.id}`}>
              {node.state}
            </Badge>
          )}
        </div>
      </td>

      <td className="py-3 pr-3 text-xs">
        <div>{formatRelative(node.last_seen, node.last_seen_age_s)}</div>
        <div className="text-muted-foreground">{platformLabel(node)}</div>
      </td>

      <td className="py-3 pr-3">
        {capabilities.length === 0 ? (
          <span className="text-xs text-muted-foreground">none reported</span>
        ) : (
          <ul className="space-y-1" data-testid={`sc-caps-${node.id}`}>
            {capabilities.map((cap) => (
              <li key={cap.name} className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs">{cap.name}</span>
                <Badge className={cn(riskBadgeClass(cap.risk))}>{cap.risk}</Badge>
                <span className="text-xs text-muted-foreground">{cap.state}</span>
                {cap.scopes && cap.scopes.length > 0 && (
                  <span className="font-mono text-[11px] text-muted-foreground" title={cap.scopes.join(", ")}>
                    {cap.scopes.length} scope{cap.scopes.length === 1 ? "" : "s"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </td>

      <td className="py-3 pr-3">
        <div className="text-xs" data-testid={`sc-grants-${node.id}`}>
          <span className="tabular-nums">{node.grant_count ?? node.grants?.length ?? 0}</span>{" "}
          <span className="text-muted-foreground">grant{node.grant_count === 1 ? "" : "s"}</span>
          {node.services && node.services.length > 0 && (
            <div className="mt-1 flex items-center gap-1 text-muted-foreground">
              <HardDrive className="size-3" />
              {node.services.length} service{node.services.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </td>

      <td className="py-3 text-right">
        {node.state === "revoked" ? (
          <span className="text-xs text-muted-foreground">revoked {formatRelative(node.revoked_at, null)}</span>
        ) : (
          <RevokeButton node={node} onDone={onDone} />
        )}
      </td>
    </tr>
  );
}

/* --------------------------------------------------------------------- view */

export function ClientsView() {
  const [nodes, setNodes] = useState<ScNode[]>([]);
  const [summary, setSummary] = useState<ScFleetSummary | null>(null);
  const [grace, setGrace] = useState(90);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    try {
      const res = await api.sc.nodes();
      setNodes(res.nodes ?? []);
      setSummary(res.summary ?? null);
      setGrace(res.watchdog_grace_s ?? 90);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load the SC fleet");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Nodes heartbeat every 30s, so a 15s poll keeps the health badge honest without
  // being chatty. Paused while the tab is hidden.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const ordered = useMemo(() => sortNodes(nodes), [nodes]);

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="sc-clients-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Clients</h2>
          <p className="text-sm text-muted-foreground">
            Sarathy Clients — nodes dial out to this gateway. Allowlist and grants are enforced on
            each node; this view is a mirror of what they reported.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <SummaryRow summary={summary} grace={grace} />
        </CardContent>
      </Card>

      <AddNodeCard onAdded={() => void load(true)} />

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Fleet</CardTitle>
          <CardDescription>
            {loading
              ? "Loading…"
              : `${ordered.length} node${ordered.length === 1 ? "" : "s"} known to this gateway`}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          {loading ? (
            <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading the fleet…
            </div>
          ) : ordered.length === 0 ? (
            <div className="m-5 rounded-lg border border-dashed p-8 text-center" data-testid="sc-empty">
              <p className="font-medium">No nodes yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add one above, or start the gateway listener with{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">sarathy sc listen</code> and let a
                node pair.
              </p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <table className="w-full border-collapse text-sm" data-testid="sc-node-table">
                <thead className="sticky top-0 z-10 bg-card">
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="p-3 pr-3 font-medium">Node</th>
                    <th className="p-3 pr-3 font-medium">Health</th>
                    <th className="p-3 pr-3 font-medium">Last seen</th>
                    <th className="p-3 pr-3 font-medium">Capabilities</th>
                    <th className="p-3 pr-3 font-medium">Policy</th>
                    <th className="p-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((node) => (
                    <NodeRow key={node.id} node={node} onDone={() => void load(true)} />
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

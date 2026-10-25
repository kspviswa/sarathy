import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  LogOut,
  Moon,
  Plug,
  RefreshCw,
  Server,
  Smartphone,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { clearToken, api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import type { StatusResponse } from "@/lib/types";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium">{value}</span>
    </div>
  );
}

/**
 * The Status segment of the Settings surface.
 *
 * ONE component for both shells (spec §B): the gateway card, the channel
 * card, the dashboard card and the logout. The desktop and the mobile used to
 * carry two copies of this; the Settings surface has one now.
 */
/**
 * MCP server health. A skipped server means missing tools, so a failure is
 * shown as a friendly amber warning (not an alarm) with the reason and the
 * consequence spelled out — the user should be able to act on it from here.
 */
function McpCard({ status }: { status: StatusResponse | null }) {
  const mcp = status?.mcp;
  const entries = Object.entries(mcp?.servers ?? {});
  const failing = mcp?.failing ?? [];

  return (
    <Card data-testid="settings-mcp">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4 text-primary" />
          MCP servers
        </CardTitle>
        <CardDescription>Tool servers the assistant connects to</CardDescription>
      </CardHeader>
      <CardContent>
        {!status ? (
          <p className="text-sm text-muted-foreground">Status unavailable</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No MCP servers configured</p>
        ) : (
          <div className="flex flex-col gap-3">
            {failing.length > 0 ? (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
                data-testid="settings-mcp-warning"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
                <div className="text-sm">
                  <p className="font-medium text-amber-600 dark:text-amber-400">
                    {failing.length === 1
                      ? `1 server is unreachable: ${failing[0]}`
                      : `${failing.length} servers are unreachable`}
                  </p>
                  <p className="text-muted-foreground">
                    Their tools were skipped so the assistant stays responsive. Check the
                    endpoint or the config, then restart the gateway.
                  </p>
                </div>
              </div>
            ) : null}
            {entries.map(([name, entry]) => {
              const failed = (mcp?.failing ?? []).includes(name);
              const pending = entry.status === "pending";
              const toolNames = entry.tool_names ?? [];
              return (
                <div key={name} className="flex flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {failed ? (
                        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-hidden />
                      ) : pending ? (
                        <Plug className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
                      )}
                      <span className="truncate text-sm font-medium">{name}</span>
                    </div>
                    <span
                      className={`min-w-0 truncate text-right text-xs ${
                        failed ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                      }`}
                      title={entry.error || undefined}
                    >
                      {failed
                        ? entry.error || entry.status
                        : pending
                          ? "not connected yet"
                          : `${entry.tools ?? 0} tools`}
                    </span>
                  </div>
                  {!failed && !pending && toolNames.length > 0 ? (
                    <div
                      className="flex flex-wrap gap-1 pl-5.5"
                      data-testid={`settings-mcp-tools-${name}`}
                    >
                      {toolNames.map((toolName) => (
                        <span
                          key={toolName}
                          className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                        >
                          {toolName}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {mcp?.checked_at ? (
              <p className="text-xs text-muted-foreground">Last checked {mcp.checked_at}</p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Disk headroom. Viswa's rule: run freely until 6 GiB free, warn at 10 GiB.
 * Shown as a plain figure when healthy and an amber/red warning when not —
 * same visual language as the MCP card, so "something needs attention" reads
 * the same way everywhere on this page.
 */
function DiskCard({ status }: { status: StatusResponse | null }) {
  const disk = status?.disk;
  const level = disk?.level ?? "unknown";
  const warn = level === "warn" || level === "critical";

  return (
    <Card data-testid="settings-disk">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4 text-primary" />
          Disk
        </CardTitle>
        <CardDescription>Free space on the root filesystem</CardDescription>
      </CardHeader>
      <CardContent>
        {!status || !disk ? (
          <p className="text-sm text-muted-foreground">Status unavailable</p>
        ) : level === "unknown" ? (
          <p className="text-sm text-muted-foreground">{disk.error || "Check failed"}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {level === "critical" ? (
                  <AlertTriangle className="size-3.5 shrink-0 text-red-500" aria-hidden />
                ) : level === "warn" ? (
                  <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
                )}
                <span className="text-sm font-medium">
                  {disk.free_gb} GiB free
                  <span className="text-muted-foreground"> of {disk.total_gb} GiB</span>
                </span>
              </div>
              <span
                className={`text-xs ${
                  level === "critical"
                    ? "text-red-600 dark:text-red-400"
                    : level === "warn"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground"
                }`}
              >
                {disk.pct_used}% used
              </span>
            </div>
            {warn ? (
              <div
                className={`flex items-start gap-2 rounded-md border p-3 ${
                  level === "critical"
                    ? "border-red-500/40 bg-red-500/10"
                    : "border-amber-500/40 bg-amber-500/10"
                }`}
                data-testid="settings-disk-warning"
              >
                <AlertTriangle
                  className={`mt-0.5 size-4 shrink-0 ${
                    level === "critical" ? "text-red-500" : "text-amber-500"
                  }`}
                  aria-hidden
                />
                <div className="text-sm">
                  <p
                    className={`font-medium ${
                      level === "critical"
                        ? "text-red-600 dark:text-red-400"
                        : "text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {level === "critical"
                      ? `Below the ${disk.crit_free_gb} GiB red line`
                      : `Below the ${disk.warn_free_gb} GiB warning line`}
                  </p>
                  <p className="text-muted-foreground">
                    Free space before the weekly cleanup runs, or grow the VM disk.
                  </p>
                </div>
              </div>
            ) : null}
            {disk.checked_at ? (
              <p className="text-xs text-muted-foreground">Checked {disk.checked_at}</p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function StatusPanel({
  onLoggedOut,
  variant = "desktop",
}: {
  onLoggedOut: () => void;
  variant?: "desktop" | "mobile";
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : "Failed to load status"),
      );
  }, []);

  async function logout() {
    await api.logout();
    clearToken();
    onLoggedOut();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="settings-status">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Logo size={44} />
          <div>
            <h2 className="text-lg font-bold leading-tight">Sarathy</h2>
            <p className="text-sm text-muted-foreground">v{status?.version ?? "…"}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              api
                .status()
                .then(setStatus)
                .catch(() => toast.error("Failed to refresh"))
            }
            title="Refresh status"
            aria-label="Refresh status"
          >
            <RefreshCw />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title="Appearance" aria-label="Appearance">
                {theme === "light" ? <Sun /> : <Moon />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setTheme("light")}>
                <Sun /> Light
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                <Moon /> Dark
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("system")}>
                <Activity /> System
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {variant === "desktop" ? (
            <Button
              variant="ghost"
              size="icon"
              title="Open the mobile site"
              aria-label="Open the mobile site"
              onClick={() => {
                window.location.href = "/mobile?view=mobile";
              }}
            >
              <Smartphone />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              title="Open desktop site"
              aria-label="Open desktop site"
              onClick={() => {
                window.location.href = "/?view=desktop";
              }}
            >
              <Smartphone className="rotate-90" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void logout()}
            title="Log out"
            aria-label="Log out"
            data-testid="settings-logout"
          >
            <LogOut />
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4 text-primary" />
            Gateway
          </CardTitle>
          <CardDescription>Assistant process status</CardDescription>
        </CardHeader>
        <CardContent>
          {status ? (
            <>
              <div className="flex items-center gap-2 pb-2">
                <span
                  className={`inline-block size-2.5 rounded-full ${status.gateway.running ? "bg-emerald-500" : "bg-destructive"}`}
                />
                <Badge variant={status.gateway.running ? "default" : "destructive"}>
                  {status.gateway.running ? "Running" : "Stopped"}
                </Badge>
                {status.gateway.pid ? (
                  <span className="text-xs text-muted-foreground">pid {status.gateway.pid}</span>
                ) : null}
              </div>
              <Separator />
              <Row label="Model" value={status.model || "—"} />
              <Row label="Provider" value={status.provider || "—"} />
              <Row
                label="Workspace"
                value={<span className="font-mono text-xs">{status.workspace}</span>}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Status unavailable</p>
          )}
        </CardContent>
      </Card>

      <McpCard status={status} />

      <DiskCard status={status} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4 text-primary" />
            Channels
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status && status.channels.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {status.channels.map((c) => (
                <Badge key={c} variant="secondary">
                  {c}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No channels active</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4 text-primary" />
            Dashboard
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status?.dashboard ? (
            <>
              <Row
                label="Address"
                value={
                  <span className="font-mono text-xs">
                    {`${status.dashboard.host}:${status.dashboard.port}`}
                  </span>
                }
              />
              <Row
                label="Streaming"
                value={status.dashboard.streaming ? "Enabled" : "Disabled"}
              />
              <Row label="Pairing keys" value={status.dashboard.pairingKeyCount} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Dashboard info unavailable</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default StatusPanel;

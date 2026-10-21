import { Activity, LogOut, Moon, RefreshCw, Server, Smartphone, Sun } from "lucide-react";
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

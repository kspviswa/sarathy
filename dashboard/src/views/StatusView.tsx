import { Activity, LogOut, Moon, RefreshCw, Server, Sun } from "lucide-react";
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
import type { StatusResponse } from "@/lib/types";
import { useTheme } from "@/lib/theme";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-medium">{value}</span>
    </div>
  );
}

export function StatusView({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load status"));
  }, []);

  async function logout() {
    await api.logout();
    clearToken();
    onLoggedOut();
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo size={44} />
          <div>
            <h1 className="text-lg font-bold leading-tight">Sarathy</h1>
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
          >
            <RefreshCw />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title="Appearance">
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
          <Button variant="ghost" size="icon" onClick={() => void logout()} title="Log out">
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
              <Row label="Workspace" value={<span className="font-mono text-xs">{status.workspace}</span>} />
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
              <Row label="Address" value={<span className="font-mono text-xs">{`${status.dashboard.host}:${status.dashboard.port}`}</span>} />
              <Row label="Streaming" value={status.dashboard.streaming ? "Enabled" : "Disabled"} />
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
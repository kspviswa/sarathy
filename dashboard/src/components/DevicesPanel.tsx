import { Loader2, RefreshCw, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, clearToken } from "@/lib/api";
import {
  deviceShortId,
  formatLastSeen,
  isStaleDevice,
  sortDevices,
} from "@/lib/devices";
import type { DeviceInfo } from "@/lib/types";

/**
 * Shared paired-device panel (spec 128 §B).
 *
 * ONE implementation for both SPAs: the desktop Config tab and the mobile
 * Config card both render this, so the two surfaces cannot diverge in how they
 * list, age, or revoke devices. It renders bare content (no Card wrapper) so
 * each host can place it (tab body vs. card body) without double-chrome.
 */
export function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.devices
      .list()
      .then((res) => setDevices(sortDevices(res.devices ?? [])))
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Failed to load devices");
        setDevices([]);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function revoke(device: DeviceInfo) {
    const label = device.name || deviceShortId(device.id);
    const message = device.current
      ? `Revoke THIS device (${label})? You will be signed out and must pair again.`
      : `Revoke "${label}"? It will need to pair again to reconnect.`;
    if (!window.confirm(message)) return;

    setBusyId(device.id);
    try {
      await api.devices.remove(device.id, device.current);
      if (device.current) {
        // The current token is now dead; drop it and force a re-pair.
        clearToken();
        toast.success("This device was revoked");
        window.location.reload();
        return;
      }
      toast.success(`Revoked ${label}`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke device");
    } finally {
      setBusyId(null);
    }
  }

  if (devices === null) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading devices…
      </div>
    );
  }

  if (devices.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">No paired devices.</p>;
  }

  return (
    <div className="flex flex-col" data-testid="devices-panel">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {devices.length} paired {devices.length === 1 ? "device" : "devices"}
        </p>
        <Button size="sm" variant="ghost" onClick={refresh} aria-label="Refresh devices">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-col divide-y">
        {devices.map((device) => {
          const label = device.name || "Unnamed device";
          const stale = isStaleDevice(device);
          return (
            <div
              key={device.id}
              className="flex items-center justify-between gap-2 py-2"
              data-testid={`device-row-${device.shortId}`}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{label}</span>
                  {device.current ? (
                    <Badge variant="default" className="text-[10px]">
                      this device
                    </Badge>
                  ) : null}
                  {stale ? (
                    <Badge variant="outline" className="text-[10px]">
                      stale
                    </Badge>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{device.shortId}</span>
                  {" · "}
                  {device.notificationsEnabled === false ? "notifications off" : "notifications on"}
                  {" · seen "}
                  {formatLastSeen(device.lastSeen)}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-destructive"
                onClick={() => void revoke(device)}
                disabled={busyId === device.id}
                data-testid={`device-revoke-${device.shortId}`}
              >
                <ShieldOff className="size-3.5" />
                Revoke
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

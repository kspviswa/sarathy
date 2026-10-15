import { Loader2, RefreshCw, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
 *
 * Multi-select + bulk revoke (2026-10-12): every *other* device can be ticked,
 * with a select-all / deselect-all toggle and a bulk "Revoke selected" action.
 * The *current* device is deliberately excluded from bulk selection — revoking
 * it signs you out (backend 409 without `force`), so it keeps its own single
 * Revoke button rather than being swept up in a bulk click.
 */
export function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(() => {
    api.devices
      .list()
      .then((res) => {
        const next = sortDevices(res.devices ?? []);
        setDevices(next);
        // Drop any selected ids that no longer exist (or are now current).
        const selectable = new Set(
          next.filter((d) => !d.current).map((d) => d.id),
        );
        setSelected((prev) => {
          const pruned = new Set([...prev].filter((id) => selectable.has(id)));
          return pruned.size === prev.size ? prev : pruned;
        });
      })
      .catch((err) => {
        toast.error(
          err instanceof Error ? err.message : "Failed to load devices",
        );
        setDevices([]);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Only non-current devices are bulk-selectable.
  const selectable = useMemo(
    () => (devices ?? []).filter((d) => !d.current),
    [devices],
  );
  const selectedCount = selectable.filter((d) => selected.has(d.id)).length;
  const allSelected =
    selectable.length > 0 && selectedCount === selectable.length;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      for (const d of selectable) next.add(d.id);
      return next;
    });
  }

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
      setSelected((prev) => {
        if (!prev.has(device.id)) return prev;
        const next = new Set(prev);
        next.delete(device.id);
        return next;
      });
      refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke device",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function revokeSelected() {
    const ids = selectable.filter((d) => selected.has(d.id)).map((d) => d.id);
    if (ids.length === 0) return;
    const message = `Revoke ${ids.length} selected ${
      ids.length === 1 ? "device" : "devices"
    }? They will need to pair again to reconnect.`;
    if (!window.confirm(message)) return;

    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api.devices.remove(id, false);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    if (failed === 0) {
      toast.success(`Revoked ${ok} ${ok === 1 ? "device" : "devices"}`);
    } else if (ok === 0) {
      toast.error(
        `Failed to revoke ${failed} ${failed === 1 ? "device" : "devices"}`,
      );
    } else {
      toast.error(`Revoked ${ok}, failed ${failed}`);
    }
    refresh();
  }

  if (devices === null) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading devices…
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">No paired devices.</p>
    );
  }

  return (
    <div className="flex flex-col" data-testid="devices-panel">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {devices.length} paired {devices.length === 1 ? "device" : "devices"}
        </p>
        <div className="flex items-center gap-1">
          {selectable.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={toggleAll}
              data-testid="devices-select-all"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={refresh}
            aria-label="Refresh devices"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      {selectedCount > 0 ? (
        <div
          className="mb-2 flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5"
          data-testid="devices-bulk-bar"
        >
          <span className="text-xs text-muted-foreground">
            {selectedCount} selected
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => void revokeSelected()}
            disabled={bulkBusy}
            data-testid="devices-bulk-revoke"
          >
            {bulkBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ShieldOff className="size-3.5" />
            )}
            Revoke selected
          </Button>
        </div>
      ) : null}

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
              <div className="flex min-w-0 items-center gap-2">
                {!device.current ? (
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 cursor-pointer accent-primary"
                    checked={selected.has(device.id)}
                    onChange={() => toggleOne(device.id)}
                    aria-label={`Select ${label}`}
                    data-testid={`device-select-${device.shortId}`}
                  />
                ) : null}
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className="min-w-0">{label}</span>
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
                  {/* Wraps instead of clipping: "b491d2 · notifications on ·
                      seen 14m ago" is a sentence, and one line of it does not fit
                      a 390px row (spec 142 §A). */}
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{device.shortId}</span>
                    {" · "}
                    {device.notificationsEnabled === false
                      ? "notifications off"
                      : "notifications on"}
                    {" · seen "}
                    {formatLastSeen(device.lastSeen)}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-destructive"
                onClick={() => void revoke(device)}
                disabled={busyId === device.id || bulkBusy}
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

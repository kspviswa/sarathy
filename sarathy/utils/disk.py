"""Disk headroom for the root filesystem.

Viswa's standing rule (2026-10-25): Sarathy runs freely until free space on
``/`` drops to 6 GiB; at 10 GiB it is an early warning. The same numbers are
surfaced in three places — the dashboard status card, ``sarathy status``, and
the weekly-cleanup job's marker file — so they live here once.

Levels:

* ``ok``       — free space above the warn threshold
* ``warn``     — free space at or below ``WARN_FREE_GB`` (tell Viswa)
* ``critical`` — free space at or below ``CRIT_FREE_GB`` (act now)
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

GIB = 1024**3

#: Below this much free space, warn (and mention it in the morning digest).
WARN_FREE_GB = 10.0
#: Below this much free space, Viswa wants to know immediately.
CRIT_FREE_GB = 6.0

DISK_STATUS_FILE = "disk_status.json"


def get_disk_status_path() -> Path:
    """Where the weekly job records its marker (``~/.sarathy/disk_status.json``)."""
    data_dir = os.environ.get("SARATHY_DATA_DIR")
    base = Path(data_dir) if data_dir else Path.home() / ".sarathy"
    return base / DISK_STATUS_FILE


def _level(free_gb: float) -> str:
    if free_gb <= CRIT_FREE_GB:
        return "critical"
    if free_gb <= WARN_FREE_GB:
        return "warn"
    return "ok"


def disk_snapshot(path: str | os.PathLike[str] = "/") -> dict[str, Any]:
    """Live filesystem figures for ``path`` (default: the root filesystem).

    Never raises — a status endpoint must answer even if ``statvfs`` fails.
    """
    try:
        usage = shutil.disk_usage(str(path))
    except OSError as exc:  # pragma: no cover - defensive
        return {
            "path": str(path),
            "level": "unknown",
            "error": str(exc),
            "warn_free_gb": WARN_FREE_GB,
            "crit_free_gb": CRIT_FREE_GB,
        }

    total_gb = usage.total / GIB
    used_gb = usage.used / GIB
    free_gb = usage.free / GIB
    return {
        "path": str(path),
        "total_gb": round(total_gb, 1),
        "used_gb": round(used_gb, 1),
        "free_gb": round(free_gb, 1),
        "pct_used": round(used_gb / total_gb * 100, 1) if total_gb else 0.0,
        "level": _level(free_gb),
        "warn_free_gb": WARN_FREE_GB,
        "crit_free_gb": CRIT_FREE_GB,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def write_disk_status(path: str | os.PathLike[str] = "/") -> dict[str, Any]:
    """Record a marker file so out-of-process readers see the last check."""
    snapshot = disk_snapshot(path)
    target = get_disk_status_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
        tmp.replace(target)
    except OSError:
        pass
    return snapshot


def read_disk_status() -> dict[str, Any]:
    """The recorded marker, or a live snapshot when it is missing/corrupt."""
    path = get_disk_status_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "level" in data:
            return data
    except (OSError, ValueError):
        pass
    return disk_snapshot()


def disk_summary_line(snapshot: dict[str, Any] | None = None) -> str:
    """One-line human summary, e.g. ``28.0 GiB free of 60.0 GiB (53% used)``."""
    snap = snapshot if snapshot is not None else disk_snapshot()
    if snap.get("level") == "unknown":
        return f"disk: unknown ({snap.get('error', 'statvfs failed')})"
    return (
        f"{snap['free_gb']} GiB free of {snap['total_gb']} GiB "
        f"({snap['pct_used']}% used)"
    )

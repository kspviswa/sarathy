"""Local control channel for the cron service.

The gateway listens on a unix socket in the data dir (no TCP port). The CLI —
or any local process — sends tiny JSON commands to wake the scheduler after a
change, so config/job edits go live without a gateway restart and without
polling. Commands are one-liners:

    {"op": "ping"}                       -> {"ok": true, "jobs": N}
    {"op": "reschedule"}                 -> {"ok": true}      (re-arm timer)
    {"op": "status"}                     -> {"ok": true, "status": {...}}

The socket is owned by the gateway process, chmod 0600, and removed on stop.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
from pathlib import Path
from typing import Any

from loguru import logger

from sarathy.utils.helpers import get_data_path


def control_socket_path() -> Path:
    """Unix socket path for the cron control channel (~/.sarathy/cron/control.sock)."""
    return get_data_path() / "cron" / "control.sock"


class CronControlServer:
    """Unix-socket control server owned by the gateway's event loop."""

    def __init__(self, service: Any):
        self._service = service
        self._server: asyncio.AbstractServer | None = None
        self._path = control_socket_path()

    async def start(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            pass
        self._server = await asyncio.start_unix_server(self._handle, path=str(self._path))
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass
        logger.info("Cron control channel listening on {}", self._path)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            data = await asyncio.wait_for(reader.read(4096), timeout=5)
            req = json.loads(data.decode("utf-8"))
            resp = self._dispatch(req)
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
        try:
            writer.write(json.dumps(resp).encode("utf-8"))
            await writer.drain()
        except Exception:
            pass
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass

    def _dispatch(self, req: dict) -> dict:
        op = req.get("op")
        if op == "ping":
            try:
                jobs = self._service.store.count()
            except Exception:
                jobs = -1
            return {"ok": True, "jobs": jobs}
        if op == "reschedule":
            self._service.notify_changed()
            return {"ok": True}
        if op == "status":
            try:
                return {"ok": True, "status": self._service.status()}
            except Exception as e:
                return {"ok": False, "error": str(e)}
        return {"ok": False, "error": f"unknown op '{op}'"}

    def close(self) -> None:
        if self._server is not None:
            self._server.close()
            self._server = None
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            pass


def notify_gateway(op: str = "reschedule", timeout: float = 1.0) -> dict | None:
    """Best-effort local RPC to a running gateway.

    Returns the parsed response dict, or None when no gateway is listening
    (socket missing / connect failed / timeout). Callers treat None as
    "gateway not running — the change is durable in the DB regardless".
    """
    path = control_socket_path()
    if not path.exists():
        return None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(str(path))
        s.sendall(json.dumps({"op": op}).encode("utf-8"))
        data = s.recv(4096)
        s.close()
        return json.loads(data.decode("utf-8")) if data else None
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        return None
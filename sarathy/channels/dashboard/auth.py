"""Pairing-key authentication and device token management for the dashboard.

Pairing keys are managed by the CLI and stored in config.json under
``channels.dashboard.pairingKeys``. They are validated against the on-disk
config on every request so that revoking a key (or adding a new one) takes
effect immediately, without a gateway restart.

Devices that successfully pair receive an opaque token whose hash is persisted
in ``~/.sarathy/dashboard_devices.json`` so reconnects (e.g. after a gateway
restart) stay authenticated.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path
from typing import Any

from loguru import logger

DEVICES_FILE = Path.home() / ".sarathy" / "dashboard_devices.json"

SENSITIVE_CONFIG_KEYS = {"apikey", "token", "password", "pairingkeys", "secret"}


def constant_time_eq(a: str, b: str) -> bool:
    """Compare two strings in constant time to avoid timing attacks."""
    return hmac.compare_digest(a.encode("utf-8", errors="ignore"), b.encode("utf-8", errors="ignore"))


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_pairing_keys(config_path: Path | None = None) -> list[str]:
    """Read the current pairing keys directly from the on-disk config.

    Reading from disk (rather than the in-memory config) means CLI key
    additions/revocations are honored immediately by a running gateway.
    """
    path = Path(config_path) if config_path else Path.home() / ".sarathy" / "config.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        keys = data.get("channels", {}).get("dashboard", {}).get("pairingKeys", [])
        return [k for k in keys if isinstance(k, str) and k]
    except Exception:
        return []


def is_valid_pairing_key(key: str, config_path: Path | None = None) -> bool:
    """Return True if ``key`` matches one of the currently configured keys."""
    if not key:
        return False
    return any(constant_time_eq(key, k) for k in load_pairing_keys(config_path))


def redact_config(data: Any) -> Any:
    """Recursively replace non-empty secret values with the ``<set>`` placeholder."""

    if isinstance(data, dict):
        out: dict[str, Any] = {}
        for k, v in data.items():
            sensitive = k.lower() in SENSITIVE_CONFIG_KEYS
            if sensitive and isinstance(v, str) and v:
                out[k] = "<set>"
            elif sensitive and isinstance(v, list) and v:
                out[k] = ["<set>"]
            elif isinstance(v, (dict, list)):
                out[k] = redact_config(v)
            else:
                out[k] = v
        return out

    if isinstance(data, list):
        return [redact_config(v) for v in data]

    return data


def merge_config(current: Any, incoming: Any) -> Any:
    """Merge a client-supplied config into the current one.

    ``"<set>"`` placeholders (returned for secrets) mean "keep the existing
    value", while any other value (including an empty string, which clears a
    secret) is applied.
    """

    if isinstance(current, dict) and isinstance(incoming, dict):
        out = dict(current)
        for k, v in incoming.items():
            if _is_set_placeholder(v) and k in current:
                out[k] = current[k]
            elif isinstance(v, dict) and isinstance(current.get(k), dict):
                out[k] = merge_config(current[k], v)
            else:
                out[k] = v
        return out

    return incoming


def _is_set_placeholder(value: Any) -> bool:
    """Return True for ``<set>`` placeholders (scalar or list form)."""
    return value == "<set>" or value == ["<set>"]


class DeviceRegistry:
    """Persisted store of paired devices, keyed by device id."""

    def __init__(self, path: Path | None = None):
        self.path = path or DEVICES_FILE
        self._devices: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self._devices = data
        except (json.JSONDecodeError, OSError):
            logger.warning("Failed to read dashboard devices file {}", self.path)
            self._devices = {}

    def save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(
                json.dumps(self._devices, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        except OSError:
            logger.warning("Failed to write dashboard devices file {}", self.path)

    def register(self, key: str, device_name: str) -> tuple[str, str]:
        """Create a device for a valid pairing key.

        Returns:
            (token, device_id). The token is returned once to the client; only
            its hash is stored.
        """
        device_id = secrets.token_hex(8)
        token = secrets.token_urlsafe(32)
        self._devices[device_id] = {
            "name": (device_name or "device")[:64],
            "key_fingerprint": _hash(key),
            "token_hash": _hash(token),
            "created_at": int(time.time()),
            "last_seen": int(time.time()),
        }
        self.save()
        return token, device_id

    def validate(self, token: str) -> str | None:
        """Return the device_id if ``token`` is valid, else None."""
        if not token:
            return None
        token_hash = _hash(token)
        for device_id, dev in self._devices.items():
            if constant_time_eq(str(dev.get("token_hash", "")), token_hash):
                dev["last_seen"] = int(time.time())
                self.save()
                return device_id
        return None

    def revoke_by_key(self, key: str) -> int:
        """Remove all devices paired with ``key``. Returns number removed."""
        fp = _hash(key)
        removed = 0
        for device_id, dev in list(self._devices.items()):
            if constant_time_eq(str(dev.get("key_fingerprint", "")), fp):
                del self._devices[device_id]
                removed += 1
        if removed:
            self.save()
        return removed

    def remove_device(self, device_id: str) -> bool:
        """Remove a single device by id (e.g. on logout)."""
        if device_id in self._devices:
            del self._devices[device_id]
            self.save()
            return True
        return False

    def list_devices(self) -> list[dict[str, Any]]:
        return [
            {"id": dev_id, **dev, "token_hash": ""}
            for dev_id, dev in self._devices.items()
        ]

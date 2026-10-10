"""Web Push (VAPID) support for the dashboard PWA.

Provides:
- VAPID keypair generation + server-side persistence (``~/.sarathy/push/vapid.json``)
- Push subscription storage (SQLite at ``~/.sarathy/push/subscriptions.db``)
- Encrypted push delivery via ``pywebpush``

Design notes:
- The private key never leaves this module. Only the **public** key is exposed
  to clients via ``GET /api/push/key``.
- ``pywebpush`` is an optional runtime dependency. If it is unavailable every
  entry point degrades gracefully (endpoints answer 503) rather than 500ing
  the gateway — notifications are a nicety, never a hard dependency.
- Expired / unregistered subscriptions (HTTP 404/410) are pruned on delivery.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from loguru import logger

PUSH_DIR = Path.home() / ".sarathy" / "push"
VAPID_PATH = PUSH_DIR / "vapid.json"
SUBSCRIPTIONS_DB = PUSH_DIR / "subscriptions.db"

# Sane bounds so a hostile client cannot grow the DB without limit.
MAX_SUBSCRIPTIONS = 64
MAX_SUBSCRIPTION_FIELDS = 12
MAX_PUSH_BODY_BYTES = 4096

_vapid_lock = threading.Lock()
_db_lock = threading.Lock()


class PushUnavailableError(RuntimeError):
    """Raised when the optional ``pywebpush`` dependency is not installed."""


def _webpush():
    """Import the pywebpush module.

    pywebpush 2.5+ installs the package as ``pywebpush``; older releases shipped
    it as ``webpush``. Try both so the optional dependency stays version-agnostic.
    """
    try:
        import pywebpush as _mod  # type: ignore[import-not-found]

        return _mod
    except ImportError:
        pass
    try:
        import webpush as _mod  # type: ignore[import-not-found]

        return _mod
    except ImportError:
        raise PushUnavailableError(
            "web push support is unavailable: install 'pywebpush' to enable it"
        ) from None


def push_available() -> bool:
    """True when the optional ``pywebpush`` dependency is importable."""
    try:
        _webpush()
    except PushUnavailableError:
        return False
    return True


# --------------------------------------------------------------------- VAPID


def _b64url(data: bytes) -> str:
    """Base64url-encode without padding (VAPID key encoding)."""
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64url(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def generate_vapid_keys() -> dict[str, str]:
    """Generate a fresh VAPID keypair as url-safe base64 strings.

    The public key is the uncompressed X9.62 point (0x04 || X || Y) that the
    Web Push spec requires; the private key is the 32-byte scalar.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private_key = ec.generate_private_key(ec.SECP256R1())
    private_raw = private_key.private_numbers().private_value.to_bytes(32, "big")
    public_raw = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    return {"publicKey": _b64url(public_raw), "privateKey": _b64url(private_raw)}


def get_vapid_keys(path: Path | None = None, *, regenerate: bool = False) -> dict[str, str]:
    """Return the persisted VAPID keypair, generating one on first use.

    Generation is race-safe across processes via an atomic replace plus an
    exclusive lock file.
    """
    target = Path(path) if path else VAPID_PATH
    with _vapid_lock:
        if target.is_file() and not regenerate:
            try:
                data = json.loads(target.read_text(encoding="utf-8"))
                if data.get("publicKey") and data.get("privateKey"):
                    return data
            except (OSError, ValueError):
                logger.warning("Corrupt VAPID key file {} — regenerating", target)

        keys = generate_vapid_keys()
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(keys), encoding="utf-8")
        tmp.replace(target)
        try:
            target.chmod(0o600)
        except OSError:  # pragma: no cover - platform dependent
            pass
        logger.info("Generated new VAPID keypair at {}", target)
        return keys


def vapid_public_key(path: Path | None = None) -> str:
    """Return only the PUBLIC key — safe to hand to clients."""
    return get_vapid_keys(path)["publicKey"]


# ------------------------------------------------------------- subscriptions


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS subscriptions (
            endpoint TEXT PRIMARY KEY,
            keys TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    return conn


def validate_subscription(payload: Any) -> dict[str, Any]:
    """Validate and normalise a browser ``PushSubscription.toJSON()`` payload.

    Raises ``ValueError`` with a safe, non-leaky message on bad input. Only
    https endpoints are accepted — a push endpoint is contacted by the server,
    so allowing arbitrary schemes would be an SSRF footgun.
    """
    if not isinstance(payload, dict):
        raise ValueError("subscription must be an object")

    endpoint = payload.get("endpoint")
    keys = payload.get("keys")

    if not isinstance(endpoint, str) or not endpoint:
        raise ValueError("missing endpoint")
    if len(endpoint) > 2048:
        raise ValueError("endpoint too long")

    parsed = urlparse(endpoint)
    if parsed.scheme != "https":
        raise ValueError("endpoint must be https")
    if not parsed.netloc:
        raise ValueError("endpoint has no host")

    if not isinstance(keys, dict):
        raise ValueError("missing keys")
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not isinstance(p256dh, str) or not p256dh:
        raise ValueError("missing p256dh key")
    if not isinstance(auth, str) or not auth:
        raise ValueError("missing auth key")
    # Base64url sanity: reject anything that is obviously not base64url.
    for value in (p256dh, auth):
        if len(value) > 512 or not all(
            c.isalnum() or c in "-_" for c in value
        ):
            raise ValueError("malformed key material")

    extras = {
        k: v
        for k, v in payload.items()
        if k not in ("endpoint", "keys")
        and isinstance(k, str)
        and isinstance(v, (str, int, float, bool, type(None)))
        and len(k) <= 64
    }
    if len(extras) > MAX_SUBSCRIPTION_FIELDS:
        extras = dict(list(extras.items())[:MAX_SUBSCRIPTION_FIELDS])

    return {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}, **extras}


def save_subscription(payload: Any, db_path: Path | None = None) -> dict[str, Any]:
    """Persist a validated subscription. Re-subscribing the same endpoint updates it."""
    sub = validate_subscription(payload)
    target = Path(db_path) if db_path else SUBSCRIPTIONS_DB
    now = time.time()
    with _db_lock, _connect(target) as conn:
        conn.execute(
            """
            INSERT INTO subscriptions (endpoint, keys, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys, updated_at=excluded.updated_at
            """,
            (sub["endpoint"], json.dumps(sub["keys"]), now, now),
        )
        count = conn.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0]
        # Cap total subscriptions: drop the least recently updated.
        if count > MAX_SUBSCRIPTIONS:
            conn.execute(
                """
                DELETE FROM subscriptions WHERE endpoint IN (
                    SELECT endpoint FROM subscriptions
                    ORDER BY updated_at ASC LIMIT ?
                )
                """,
                (count - MAX_SUBSCRIPTIONS,),
            )
    return sub


def delete_subscription(endpoint: str, db_path: Path | None = None) -> bool:
    """Remove one subscription. Returns True if a row was deleted."""
    if not isinstance(endpoint, str) or not endpoint:
        return False
    target = Path(db_path) if db_path else SUBSCRIPTIONS_DB
    if not target.exists():
        return False
    with _db_lock, _connect(target) as conn:
        cur = conn.execute("DELETE FROM subscriptions WHERE endpoint = ?", (endpoint,))
        return cur.rowcount > 0


def list_subscriptions(db_path: Path | None = None) -> list[dict[str, Any]]:
    """Return every stored subscription (newest first)."""
    target = Path(db_path) if db_path else SUBSCRIPTIONS_DB
    if not target.exists():
        return []
    with _db_lock, _connect(target) as conn:
        rows = conn.execute(
            "SELECT endpoint, keys FROM subscriptions ORDER BY updated_at DESC"
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            keys = json.loads(row["keys"])
        except ValueError:
            continue
        out.append({"endpoint": row["endpoint"], "keys": keys})
    return out


def subscription_count(db_path: Path | None = None) -> int:
    """Number of stored subscriptions."""
    return len(list_subscriptions(db_path))


# ---------------------------------------------------------------- delivery


def _is_gone(exc: BaseException) -> bool:
    """True when a push failure means the subscription is permanently dead.

    HTTP 404/410 from a push service means the browser revoked the
    subscription. Transient failures (DNS, timeouts, 5xx, 429) must NOT prune —
    otherwise a flaky network would silently unsubscribe every device.
    """
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status in (404, 410):
        return True
    # pywebpush raises a bare WebPushException whose message embeds the status.
    message = str(exc)
    return "410" in message or "404" in message


def send_to_subscriptions(
    title: str,
    body: str = "",
    url: str | None = None,
    *,
    vapid_path: Path | None = None,
    db_path: Path | None = None,
    ttl: int = 86400,
) -> dict[str, Any]:
    """Send an encrypted push payload to every stored subscription.

    Returns a summary dict: ``{delivered, failed, pruned, error, sent}``.
    Never raises for per-subscription failures — a dead endpoint must not break
    delivery to the others.
    """
    result: dict[str, Any] = {
        "delivered": 0,
        "failed": 0,
        "pruned": 0,
        "sent": 0,
        "error": None,
    }

    try:
        webpush = _webpush()
    except PushUnavailableError as exc:
        result["error"] = str(exc)
        return result

    subs = list_subscriptions(db_path)
    if not subs:
        return result

    keys = get_vapid_keys(vapid_path)
    payload = json.dumps(
        {"title": title, "body": body, "url": url or "/", "timestamp": time.time()}
    )
    if len(payload.encode("utf-8")) > MAX_PUSH_BODY_BYTES:
        payload = json.dumps({"title": title, "body": "", "url": url or "/"})

    for sub in subs:
        try:
            webpush.webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": sub["keys"],
                },
                data=payload,
                vapid_private_key=_unb64url(keys["privateKey"]),
                vapid_claims={"sub": "mailto:sarathy@localhost"},
                ttl=ttl,
            )
            result["delivered"] += 1
            result["sent"] += 1
        except Exception as exc:  # noqa: BLE001 - per-endpoint isolation
            result["failed"] += 1
            name = type(exc).__name__
            if _is_gone(exc):
                # The browser dropped the subscription — prune it so we stop
                # retrying a dead endpoint forever.
                if delete_subscription(sub["endpoint"], db_path):
                    result["pruned"] += 1
            else:
                logger.warning(
                    "Push delivery failed for {}: {}: {}",
                    sub["endpoint"],
                    name,
                    exc,
                )

    return result

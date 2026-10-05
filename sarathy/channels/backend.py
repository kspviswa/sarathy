"""Backend channel: the third trigger path for the gateway.

Localhost-only, token-gated HTTP endpoint plus a jobs.db event tailer that
wake Sarathy when backend agents/workers/jobs emit events. Events land in
isolated ``backend:<job_id>`` sessions and are consumed exactly like any
channel message.

Disabled by default; enabled post-deploy with a generated token.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.base import BaseChannel
from sarathy.config.schema import BackendConfig

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# Live Telegram session chat id — the ONLY id relays should ever target.
# (AGENTS.md once showed 8281248569 as an example; that id is stale and
# Telegram returns "Chat not found" for it. See KB #394/#395.)
TG_LIVE_CHAT_ID = "5878545507"


def default_jobs_db_path() -> Path:
    """Default location of the jobs DB (read-only for this channel)."""
    return Path.home() / ".sarathy" / "workspace" / "jobs" / "jobs.db"


def default_watermark_path(jobs_db_path: Path | None = None) -> Path:
    """Default watermark file (workspace sessions dir, next to index.db)."""
    db = Path(jobs_db_path) if jobs_db_path else default_jobs_db_path()
    workspace = db.resolve().parent.parent
    return workspace / "sessions" / "backend_watermark.json"


def format_event_text(
    event_type: str, source: str, job_id: str | None, message: str
) -> str:
    """Human-readable one-line summary of a backend event."""
    message = (message or "").strip()
    if job_id:
        headline = f"[job {job_id} {event_type}]"
    else:
        headline = f"[{source} {event_type}]"
    return f"{headline} {message}".strip() if message else headline


def normalize_envelope(data: Any) -> tuple[dict | None, str | None]:
    """Validate a POST /event body. Returns (envelope, error)."""
    if not isinstance(data, dict):
        return None, "body must be a JSON object"
    event_type = data.get("event_type")
    source = data.get("source")
    if not isinstance(event_type, str) or not event_type.strip():
        return None, "missing required field: event_type"
    if not isinstance(source, str) or not source.strip():
        return None, "missing required field: source"
    job_id = data.get("job_id")
    job_id = str(job_id).strip() if job_id is not None else None
    job_id = job_id or None
    payload = data.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return None, "payload must be a JSON object"
    envelope = {
        "event_type": event_type.strip(),
        "source": source.strip(),
        "job_id": job_id,
        "source_session_id": data.get("source_session_id"),
        "payload": payload,
        "ts": data.get("ts")
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "escalate_to": data.get("escalate_to"),
    }
    return envelope, None


def envelope_to_inbound(envelope: dict) -> InboundMessage:
    """Build the isolated-session InboundMessage for a validated envelope."""
    event_type = envelope["event_type"]
    source = envelope["source"]
    job_id = envelope.get("job_id")
    payload = envelope.get("payload") or {}
    message = payload.get("message", "") if isinstance(payload, dict) else ""
    chat_id = job_id or source
    return InboundMessage(
        channel="backend",
        sender_id=source,
        chat_id=chat_id,
        content=format_event_text(event_type, source, job_id, str(message or "")),
        metadata=dict(envelope),
        session_key_override=f"backend:{chat_id}",
    )


def _load_watermark(path: Path) -> int:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return int(data.get("last_id", 0))
    except Exception:
        return 0


def _save_watermark(path: Path, last_id: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"last_id": last_id}), encoding="utf-8")
    except Exception as e:
        logger.warning("Failed to persist backend watermark {}: {}", path, e)


class BackendChannel(BaseChannel):
    """Localhost HTTP endpoint + jobs.db tailer firing isolated sessions."""

    name = "backend"

    def __init__(
        self,
        config: BackendConfig,
        bus: MessageBus,
        watermark_path: Path | None = None,
        poll_interval: float = 5.0,
    ):
        super().__init__(config, bus)
        self.config: BackendConfig = config
        self._watermark_path = (
            Path(watermark_path)
            if watermark_path
            else default_watermark_path(
                Path(config.jobs_db_path) if config.jobs_db_path else None
            )
        )
        self._poll_interval = poll_interval
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._tailer_task: asyncio.Task | None = None
        self._watermark: int = 0
        self._watermark_ready: bool = False

    # ------------------------------------------------------------------ app

    def _build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/event", self._handle_event)
        app.router.add_get("/health", self._handle_health)
        return app

    @property
    def bound_port(self) -> int | None:
        """Actual bound port (useful when configured with port 0)."""
        try:
            sockets = self._site._server.sockets if self._site else None  # type: ignore[union-attr]
        except Exception:
            return None
        if not sockets:
            return None
        try:
            return int(sockets[0].getsockname()[1])
        except Exception:
            return None

    # ------------------------------------------------------------------ start/stop

    async def start(self) -> None:
        if not self.config.token:
            logger.error(
                "Backend channel refusing to start: no token configured. "
                "Generate one and set channels.backend.token to enable it."
            )
            return
        host = self.config.host
        if host not in _LOOPBACK_HOSTS:
            logger.warning(
                "Backend channel host '{}' is not loopback; forcing 127.0.0.1.",
                host,
            )
            host = "127.0.0.1"

        app = self._build_app()
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, host, self.config.port)
        await self._site.start()
        self._running = True
        logger.info("Backend channel listening on http://{}:{}", host, self.bound_port)

        self._tailer_task = asyncio.create_task(self._tail_loop())
        while self._running:
            await asyncio.sleep(1)

    async def stop(self) -> None:
        self._running = False
        if self._tailer_task:
            self._tailer_task.cancel()
            try:
                await self._tailer_task
            except asyncio.CancelledError:
                pass
            self._tailer_task = None
        if self._runner:
            try:
                await self._runner.cleanup()
            except Exception:
                pass
            self._runner = None
            self._site = None

    # ------------------------------------------------------------------ http

    def _authorized(self, request: web.Request) -> bool:
        token = self.config.token
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            candidate = auth[len("Bearer ") :].strip()
        else:
            candidate = request.headers.get("X-Sarathy-Token", "").strip()
        if not candidate:
            return False
        return hmac.compare_digest(candidate, token)

    async def _handle_health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    async def _handle_event(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)
        envelope, error = normalize_envelope(data)
        if envelope is None:
            return web.json_response({"error": error}, status=400)
        allow_from = getattr(self.config, "allow_from", []) or []
        if allow_from and envelope["source"] not in allow_from:
            return web.json_response({"error": "source not allowed"}, status=403)
        msg = envelope_to_inbound(envelope)
        await self.bus.publish_inbound(msg)
        return web.json_response({"ok": True, "session": msg.session_key_override})

    # ------------------------------------------------------------------ tailer

    def _jobs_db(self) -> Path:
        if self.config.jobs_db_path:
            return Path(self.config.jobs_db_path)
        return default_jobs_db_path()

    def _init_watermark(self) -> None:
        """First-run init: start AFTER existing rows (never replay history)."""
        if self._watermark_path.exists():
            self._watermark = _load_watermark(self._watermark_path)
        else:
            self._watermark = self._current_max_event_id()
            _save_watermark(self._watermark_path, self._watermark)
        self._watermark_ready = True

    def _current_max_event_id(self) -> int:
        path = self._jobs_db()
        if not path.exists():
            return 0
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                row = conn.execute("SELECT MAX(id) FROM job_events").fetchone()
            finally:
                conn.close()
            return int(row[0]) if row and row[0] is not None else 0
        except Exception as e:
            logger.warning("Backend tailer could not read jobs.db max id: {}", e)
            return 0

    def _poll_new_events(self) -> list[dict]:
        """Read-only poll for events after the high-watermark. Advances it."""
        path = self._jobs_db()
        if not path.exists():
            return []
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                rows = conn.execute(
                    "SELECT id, job_id, ts, event_type, level, message, payload"
                    " FROM job_events WHERE id > ? ORDER BY id",
                    (self._watermark,),
                ).fetchall()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("Backend tailer poll failed: {}", e)
            return []
        events = []
        for row in rows:
            event_id, job_id, ts, event_type, level, message, payload = row
            self._watermark = max(self._watermark, int(event_id))
            parsed_payload: Any = {}
            if payload:
                if isinstance(payload, str):
                    try:
                        parsed_payload = json.loads(payload)
                    except Exception:
                        parsed_payload = {"raw": payload}
                else:
                    parsed_payload = payload
            events.append(
                {
                    "id": int(event_id),
                    "job_id": str(job_id),
                    "ts": ts,
                    "event_type": event_type,
                    "level": level,
                    "message": message or "",
                    "payload": parsed_payload,
                }
            )
        if rows:
            _save_watermark(self._watermark_path, self._watermark)
        return events

    def _tail_event_to_inbound(self, event: dict) -> InboundMessage | None:
        """Convert a jobs.db row to an InboundMessage (None when filtered out)."""
        wanted = set(getattr(self.config, "tail_event_types", []) or [])
        if event["event_type"] not in wanted:
            return None
        job_id = event["job_id"]
        sender_id = f"job-{job_id}"
        # Escalation target: allow the event row to carry a session/chat to
        # escalate into (source_session_id), else fall back to the LIVE session
        # chat id so relays always reach the user. Never None.
        payload = event.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {}
        source_session_id = payload.get("source_session_id")
        escalate_to = payload.get("escalate_to")
        if not escalate_to or ":" not in str(escalate_to):
            escalate_to = f"telegram:{TG_LIVE_CHAT_ID}"
        envelope = {
            "event_type": event["event_type"],
            "source": sender_id,
            "job_id": job_id,
            "source_session_id": source_session_id,
            "payload": {"message": event["message"], "extra": event["payload"]},
            "ts": event["ts"],
            "escalate_to": escalate_to,
            "level": event.get("level"),
        }
        return InboundMessage(
            channel="backend",
            sender_id=sender_id,
            chat_id=job_id,
            content=format_event_text(
                event["event_type"], sender_id, job_id, event["message"]
            ),
            metadata=envelope,
            session_key_override=f"backend:job-{job_id}",
        )

    async def _tail_loop(self) -> None:
        try:
            self._init_watermark()
            while self._running:
                try:
                    for event in self._poll_new_events():
                        msg = self._tail_event_to_inbound(event)
                        if msg is not None:
                            await self.bus.publish_inbound(msg)
                except Exception as e:
                    logger.warning("Backend tailer iteration failed: {}", e)
                await asyncio.sleep(self._poll_interval)
        except asyncio.CancelledError:
            raise

    # ------------------------------------------------------------------ send

    async def send(self, msg: OutboundMessage) -> None:
        """Backend has no user-facing surface: log, and escalate if asked.

        Escalation is routed via the bus's outbound dispatch (the channel
        manager routes by channel) — never sent directly from here.
        """
        logger.debug("Backend channel reply for {}: {}", msg.chat_id, msg.content[:200])
        escalate_to = (msg.metadata or {}).get("escalate_to")
        if not escalate_to or ":" not in str(escalate_to):
            return
        channel, _, chat_id = str(escalate_to).partition(":")
        channel, chat_id = channel.strip(), chat_id.strip()
        if not channel or not chat_id:
            return
        await self.bus.publish_outbound(
            OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content=msg.content,
                metadata={"_progress": False, "_tool_hint": False},
            )
        )

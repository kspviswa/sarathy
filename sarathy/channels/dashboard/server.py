"""Dashboard channel: a web UI / PWA for chatting with sarathy, viewing sessions
and workspace files, editing configuration, and restarting the gateway remotely.

Runs an aiohttp server inside the gateway process (same event loop). Chat flows
through the shared MessageBus like any other channel; the REST API operates
directly on sarathy's config, sessions, and workspace.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from typing import Callable

import aiohttp
import aiohttp.web as web
from loguru import logger

from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.base import BaseChannel
from sarathy.channels.dashboard.auth import (
    DeviceRegistry,
    is_valid_pairing_key,
    merge_config,
    redact_config,
)
from sarathy.config.schema import DashboardConfig

DASHBOARD_SESSION_KEY = "dashboard:console"
MAX_FILE_BYTES = 2 * 1024 * 1024  # Workspace file read/write cap
MAX_TREE_ENTRIES = 5000  # Guard against pathological workspaces
_LOGIN_WINDOW_SECONDS = 60
_LOGIN_MAX_FAILURES = 10


class DashboardChannel(BaseChannel):
    """HTTP + WebSocket channel for the sarathy dashboard."""

    name = "dashboard"

    def __init__(
        self,
        config: DashboardConfig,
        bus: MessageBus,
        session_manager=None,
        config_path: Path | None = None,
        devices_path: Path | None = None,
    ):
        super().__init__(config, bus)
        self.config: DashboardConfig = config
        self.session_manager = session_manager
        self.config_path = Path(config_path) if config_path else None
        self._registry = DeviceRegistry(devices_path)
        self._static_dir = Path(__file__).parent / "static"
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._ws_clients: set[web.WebSocketResponse] = set()
        self._login_failures: dict[str, list[float]] = {}

    # ------------------------------------------------------------------ start/stop

    async def start(self) -> None:
        index = self._static_dir / "index.html"
        if not index.is_file():
            logger.warning(
                "Dashboard static assets missing ({}). Build the frontend with "
                "'npm run build' in dashboard/ and commit sarathy/channels/dashboard/static/.",
                index,
            )
            return

        app = self._build_app()

        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.config.host, self.config.port)
        await self._site.start()
        self._running = True

        logger.info("Dashboard channel listening on http://{}:{}", self.config.host, self.config.port)
        if not self.config.pairing_keys:
            logger.warning(
                "Dashboard enabled but no pairing keys. Run 'sarathy dashboard start' "
                "or 'sarathy dashboard key add' to pair a device."
            )

        while self._running:
            await asyncio.sleep(1)

    async def stop(self) -> None:
        self._running = False
        for ws in list(self._ws_clients):
            try:
                await ws.close()
            except Exception:
                pass
        self._ws_clients.clear()
        if self._site:
            try:
                await self._site.stop()
            except Exception:
                pass
        if self._runner:
            try:
                await self._runner.cleanup()
            except Exception:
                pass
        self._site = None
        self._runner = None
        logger.info("Dashboard channel stopped")

    async def send(self, msg: OutboundMessage) -> None:
        """Broadcast an outbound message to all connected dashboard clients."""
        if not self._ws_clients:
            return
        payload = json.dumps(
            {
                "type": "message",
                "channel": msg.channel,
                "chatId": msg.chat_id,
                "content": msg.content,
                "media": msg.media,
                "metadata": msg.metadata or {},
            },
            ensure_ascii=False,
        )
        for ws in list(self._ws_clients):
            try:
                await ws.send_str(payload)
            except Exception:
                self._ws_clients.discard(ws)

    def is_allowed(self, sender_id: str) -> bool:
        # Access control happens at the HTTP layer (pairing key + token).
        return True

    # ------------------------------------------------------------------ helpers

    def _load_full_config(self):
        from sarathy.config.loader import load_config

        return load_config(self.config_path)

    def _workspace_root(self) -> Path:
        return self._load_full_config().workspace_path

    def _safe_workspace_path(self, rel: str) -> Path:
        root = self._workspace_root().resolve()
        p = (root / rel.lstrip("/")).resolve()
        if root != p and root not in p.parents:
            raise ValueError("path escapes workspace")
        return p

    def _extract_token(self, request: web.Request) -> str | None:
        header = request.headers.get("Authorization", "")
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        if request.query.get("token"):
            return request.query["token"].strip()
        return request.headers.get("X-Auth-Token", "").strip() or None

    def _rate_limited(self, ip: str) -> bool:
        import time

        now = time.monotonic()
        failures = self._login_failures.setdefault(ip, [])
        failures = [t for t in failures if now - t < _LOGIN_WINDOW_SECONDS]
        self._login_failures[ip] = failures
        return len(failures) >= _LOGIN_MAX_FAILURES

    def _record_failure(self, ip: str) -> None:
        import time

        self._login_failures.setdefault(ip, []).append(time.monotonic())

    # ------------------------------------------------------------------ middleware

    @web.middleware
    async def _auth_middleware(self, request: web.Request, handler: Callable):
        path = request.path
        public = path == "/api/auth/pair"
        if (path.startswith("/api/") or path == "/ws") and not public:
            token = self._extract_token(request)
            device_id = self._registry.validate(token) if token else None
            if not device_id:
                return web.json_response({"error": "unauthorized"}, status=401)
            request["device_id"] = device_id

            ip = request.remote or ""
            if self.config.allow_from and ip not in self.config.allow_from:
                return web.json_response({"error": "forbidden"}, status=403)

        return await handler(request)

    # ------------------------------------------------------------------ routes

    def _build_app(self) -> web.Application:
        app = web.Application(
            client_max_size=10 * 1024 * 1024, middlewares=[self._auth_middleware]
        )
        self._setup_routes(app)
        return app

    def _setup_routes(self, app: web.Application) -> None:
        app.router.add_get("/", self._index)
        app.router.add_get("/index.html", self._index)
        app.router.add_get("/manifest.webmanifest", self._static_file)
        app.router.add_get("/sw.js", self._static_file)
        app.router.add_get("/favicon.ico", self._static_file)
        app.router.add_get("/favicon.svg", self._static_file)
        assets = self._static_dir / "assets"
        icons = self._static_dir / "icons"
        if assets.is_dir():
            app.router.add_static("/assets/", assets)
        if icons.is_dir():
            app.router.add_static("/icons/", icons)

        app.router.add_post("/api/auth/pair", self._api_pair)
        app.router.add_get("/api/auth/me", self._api_me)
        app.router.add_post("/api/auth/logout", self._api_logout)
        app.router.add_post("/api/chat", self._api_chat)
        app.router.add_post("/api/chat/stop", self._api_chat_stop)
        app.router.add_get("/api/config", self._api_get_config)
        app.router.add_put("/api/config", self._api_put_config)
        app.router.add_post("/api/restart", self._api_restart)
        app.router.add_get("/api/sessions", self._api_sessions)
        app.router.add_get("/api/session", self._api_session_messages)
        app.router.add_get("/api/workspace/tree", self._api_workspace_tree)
        app.router.add_get("/api/workspace/file", self._api_workspace_get)
        app.router.add_put("/api/workspace/file", self._api_workspace_put)
        app.router.add_get("/api/status", self._api_status)
        app.router.add_get("/ws", self._ws_handler)

    async def _index(self, request: web.Request) -> web.Response:
        return web.FileResponse(self._static_dir / "index.html")

    async def _static_file(self, request: web.Request) -> web.Response:
        name = request.path.lstrip("/")
        path = self._static_dir / name
        if path.is_file():
            return web.FileResponse(path)
        return web.json_response({"error": "not found"}, status=404)

    # ------------------------------------------------------------------ auth api

    async def _api_pair(self, request: web.Request) -> web.Response:
        ip = request.remote or ""
        if self._rate_limited(ip):
            return web.json_response({"error": "too many attempts"}, status=429)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)

        key = (data.get("key") or "").strip()
        if not is_valid_pairing_key(key, self.config_path):
            self._record_failure(ip)
            return web.json_response({"error": "invalid pairing key"}, status=401)

        name = (data.get("deviceName") or "").strip()
        token, device_id = self._registry.register(key, name)
        logger.info("Dashboard device paired: {}", device_id)
        return web.json_response({"token": token, "deviceId": device_id})

    async def _api_me(self, request: web.Request) -> web.Response:
        from sarathy import __version__

        device_id = request.get("device_id", "")
        device = next(
            (d for d in self._registry.list_devices() if d.get("id") == device_id), None
        )
        return web.json_response(
            {
                "deviceId": device_id,
                "deviceName": (device or {}).get("name", ""),
                "version": __version__,
            }
        )

    async def _api_logout(self, request: web.Request) -> web.Response:
        device_id = request.get("device_id", "")
        if device_id:
            self._registry.remove_device(device_id)
        return web.json_response({"ok": True})

    # ------------------------------------------------------------------ chat api

    def _inbound(self, content: str, device_id: str) -> InboundMessage:
        return InboundMessage(
            channel=self.name,
            sender_id=f"dashboard:{device_id}",
            chat_id="console",
            content=content,
            metadata={"device_id": device_id},
            session_key_override=DASHBOARD_SESSION_KEY,
        )

    async def _api_chat(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        content = (data.get("content") or "").strip()
        if not content:
            return web.json_response({"error": "empty message"}, status=400)
        await self.bus.publish_inbound(self._inbound(content, request.get("device_id", "")))
        return web.json_response({"ok": True})

    async def _api_chat_stop(self, request: web.Request) -> web.Response:
        await self.bus.publish_inbound(self._inbound("/stop", request.get("device_id", "")))
        return web.json_response({"ok": True})

    # ------------------------------------------------------------------ config api

    async def _api_get_config(self, request: web.Request) -> web.Response:
        cfg = self._load_full_config()
        data = cfg.model_dump(by_alias=True, mode="json")
        return web.json_response(redact_config(data))

    async def _api_put_config(self, request: web.Request) -> web.Response:
        from sarathy.config.loader import save_config
        from sarathy.config.schema import Config

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "invalid body"}, status=400)

        current = self._load_full_config()
        current_data = current.model_dump(by_alias=True, mode="json")
        merged = merge_config(current_data, data)
        try:
            new_cfg = Config.model_validate(merged)
        except Exception as e:
            return web.json_response({"error": f"invalid config: {e}"}, status=400)

        save_config(new_cfg, self.config_path)
        return web.json_response({"ok": True, "restartRequired": True})

    # ------------------------------------------------------------------ restart api

    async def _api_restart(self, request: web.Request) -> web.Response:
        from sarathy.utils.helpers import get_data_path

        flag = get_data_path() / "restart_pending.json"
        flag.write_text(
            json.dumps({"channel": self.name, "chat_id": "console"}), encoding="utf-8"
        )

        async def _do_restart() -> None:
            await asyncio.sleep(0.5)
            try:
                subprocess.Popen(
                    [sys.executable, "-m", "sarathy.cli.commands", "gateway", "restart"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except Exception as e:
                logger.error("Dashboard restart failed: {}", e)

        asyncio.create_task(_do_restart())
        return web.json_response({"ok": True, "message": "Restarting..."})

    # ------------------------------------------------------------------ sessions api

    async def _api_sessions(self, request: web.Request) -> web.Response:
        if not self.session_manager:
            return web.json_response({"error": "sessions unavailable"}, status=503)
        return web.json_response({"sessions": self.session_manager.list_sessions()})

    async def _api_session_messages(self, request: web.Request) -> web.Response:
        if not self.session_manager:
            return web.json_response({"error": "sessions unavailable"}, status=503)
        key = request.query.get("key", "")
        if not key:
            return web.json_response({"error": "missing key"}, status=400)
        session = self.session_manager.read_session(key)
        if session is None:
            return web.json_response({"error": "session not found"}, status=404)
        messages = []
        for m in session.messages:
            messages.append(
                {
                    "role": m.get("role", ""),
                    "content": m.get("content", ""),
                    "timestamp": m.get("timestamp"),
                    "name": m.get("name"),
                }
            )
        return web.json_response(
            {"key": key, "createdAt": session.created_at.isoformat(), "messages": messages}
        )

    # ------------------------------------------------------------------ workspace api

    async def _api_workspace_tree(self, request: web.Request) -> web.Response:
        root = self._workspace_root()
        if not root.exists():
            return web.json_response({"root": str(root), "tree": []})
        try:
            tree = self._build_tree(root, root)
        except RecursionError:
            return web.json_response({"error": "tree too deep"}, status=400)
        return web.json_response({"root": str(root), "tree": tree})

    def _build_tree(self, root: Path, current: Path, _count: list[int] | None = None) -> list[dict]:
        if _count is None:
            _count = [0]
        entries = []
        try:
            children = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return entries
        for child in children:
            if child.name.startswith("."):
                continue
            _count[0] += 1
            if _count[0] > MAX_TREE_ENTRIES:
                raise RecursionError("too many entries")
            rel = child.relative_to(root).as_posix()
            if child.is_dir():
                entries.append(
                    {
                        "name": child.name,
                        "type": "dir",
                        "path": rel,
                        "children": self._build_tree(root, child, _count),
                    }
                )
            else:
                try:
                    size = child.stat().st_size
                except OSError:
                    size = 0
                entries.append({"name": child.name, "type": "file", "path": rel, "size": size})
        return entries

    async def _api_workspace_get(self, request: web.Request) -> web.Response:
        rel = request.query.get("path", "")
        try:
            path = self._safe_workspace_path(rel)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        if not path.is_file():
            return web.json_response({"error": "not found"}, status=404)
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                return web.json_response({"error": "file too large"}, status=413)
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"path": rel, "content": content})

    async def _api_workspace_put(self, request: web.Request) -> web.Response:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid body"}, status=400)
        rel = (data.get("path") or "").strip()
        content = data.get("content")
        if content is None or len(str(content)) > MAX_FILE_BYTES:
            return web.json_response({"error": "invalid content"}, status=400)
        try:
            path = self._safe_workspace_path(rel)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(content), encoding="utf-8")
        except OSError as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"ok": True, "path": rel})

    # ------------------------------------------------------------------ status api

    async def _api_status(self, request: web.Request) -> web.Response:
        from sarathy import __version__
        from sarathy.gateway.manager import get_gateway_status

        cfg = self._load_full_config()
        provider = ""
        try:
            provider = cfg.get_provider_name() or ""
        except Exception:
            pass

        enabled = []
        for name in ("telegram", "discord", "email", "dashboard"):
            ch = getattr(cfg.channels, name, None)
            if ch and getattr(ch, "enabled", False):
                enabled.append(name)

        return web.json_response(
            {
                "version": __version__,
                "gateway": get_gateway_status(),
                "model": cfg.agents.defaults.model,
                "provider": provider,
                "workspace": str(cfg.workspace_path),
                "channels": enabled,
                "dashboard": {
                    "host": self.config.host,
                    "port": self.config.port,
                    "streaming": self.config.streaming,
                    "pairingKeyCount": len(self.config.pairing_keys),
                },
            }
        )

    # ------------------------------------------------------------------ websocket

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self._ws_clients.add(ws)
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if data.get("type") == "ping":
                        await ws.send_str(json.dumps({"type": "pong"}))
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    break
        finally:
            self._ws_clients.discard(ws)
        return ws

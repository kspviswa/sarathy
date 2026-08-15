"""SarathyEngine: the sarathy-specific shell around tau's AgentHarness.

Owns the provider, skills, sessions, memory archivist, cron worker, extension
host and the async event hub the frontends subscribe to.
"""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger
from tau_agent.session import CustomEntry

from sarathy.agent.skills import SkillManager, SkillsLoader
from sarathy.config.loader import load_config
from sarathy.config.schema import Config
from sarathy.cron.service import CronService
from sarathy.cron.types import CronJob
from sarathy.engine.commands import CommandRegistry
from sarathy.engine.context import build_system_prompt
from sarathy.engine.events import EventHub, NotifyEvent, RunEnd, SessionCreated
from sarathy.engine.memory import Memory, MemoryArchivist
from sarathy.engine.provider import build_provider
from sarathy.engine.session import SessionApp
from sarathy.engine.tools import build_default_tools, build_mcp_tools
from sarathy.extensions.host import ExtensionHost
from sarathy.utils.helpers import ensure_dir, get_workspace_path


class SarathyEngine:
    """The single entrypoint connecting tau to the frontends."""

    def __init__(
        self,
        config: Config | None = None,
        *,
        workspace: Path | str | None = None,
        session_window: int | None = None,
        verbose: bool = False,
    ):
        self.config = config or load_config()
        self.verbose = verbose

        ws = Path(workspace).expanduser() if workspace else None
        self.workspace = ws or self.config.workspace_path or get_workspace_path()
        ensure_dir(self.workspace)
        self.session_dir = ensure_dir(self.workspace / "sessions" / "tau")
        self.data_dir = ensure_dir(get_data_dir())

        self.provider, self.provider_name = build_provider(self.config)
        defaults = self.config.agents.defaults
        self.configured = self.provider is not None
        self.model = defaults.model
        self.max_turns = defaults.max_tool_iterations or 40
        self.window = session_window or defaults.memory_window

        self.hub = EventHub()
        self.skills_loader = SkillsLoader(self.workspace)
        self.skill_manager = SkillManager(self.workspace)
        self.skills_summary = ""
        self.always_skills = ""

        self.memory = Memory(self.workspace)
        archival = self.config.agents.memory_archival
        self.archivist = MemoryArchivist(
            memory=self.memory,
            provider=self.provider,
            model=self.model,
            interval_s=archival.interval_seconds,
            enabled=archival.enabled,
        )
        self.archivist._on_sweep.append(self._archival_sweep)

        self.sessions: dict[str, SessionApp] = {}
        self.active_session_id: str | None = None

        self.extensions = ExtensionHost(self)
        self.commands = CommandRegistry(self)
        self.extension_tools_loaded = False
        self.last_heartbeat: float = 0.0
        self._started_at = 0.0

        self._mcp_stack = AsyncExitStack()
        self._default_tools: list = []
        self._mcp_tools: list = []
        self._tasks: list[asyncio.Task] = []
        self._stopping = False

        cron_dir = ensure_dir(self.data_dir / "cron")
        self.cron_service = CronService(
            store_path=cron_dir / "cron_jobs.json",
            on_job=self._on_cron_job,
        )

    # ================================================================== lifecycle
    async def start(self) -> None:
        self._started_at = time.monotonic()
        self._load_extensions()
        self._connect_mcp()
        self._default_tools = build_default_tools(self.config, self.workspace)

        self.archivist.start()
        await self.cron_service.start()

        self._tasks.append(asyncio.create_task(self._heartbeat()))
        self._tasks.append(asyncio.create_task(self._extension_reloader()))

        logger.info(
            "Sarathy engine started: model={} provider={} workspace={} extensions={}",
            self.model,
            self.provider_name,
            self.workspace,
            len(self.extensions._extensions),
        )

    async def stop(self) -> None:
        self._stopping = True
        for session in self.sessions.values():
            session.cancel()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.archivist.stop()
        self.cron_service.stop()
        await self._mcp_stack.aclose()

    # ================================================================== tools / prompt
    def _load_extensions(self) -> None:
        self.extensions.load(self.data_dir)

    def _connect_mcp(self) -> None:
        asyncio.get_event_loop().create_task(
            self._connect_mcp_async()
        )

    async def _connect_mcp_async(self) -> None:
        try:
            self._mcp_tools = await build_mcp_tools(
                self.config, self.workspace, self._mcp_stack
            )
            logger.info("MCP: {} external tools", len(self._mcp_tools))
        except Exception as exc:  # noqa: BLE001
            logger.error("MCP setup failed: {}", exc)

    async def system_prompt(self) -> str:
        self.refresh_skills()
        return build_system_prompt(
            workspace=self.workspace,
            memory_context=self.memory.context_block(),
            skills_summary=self.skills_summary,
            always_skills=self.always_skills,
            tools=await self.tools_for_session(),
            extra_guidelines=self.extensions.guidelines,
        )

    async def tools_for_session(self) -> list:
        return list(self._default_tools) + list(self._mcp_tools) + list(self.extensions.tools)

    def refresh_skills(self) -> None:
        try:
            self.skills_summary = self.skills_loader.build_skills_summary()
            self.always_skills = self.skills_loader.load_skills_for_context(
                self.skills_loader.get_always_skills()
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("skill discovery failed: {}", exc)

    # ================================================================== sessions
    def new_session(self, session_id: str | None = None, *, activate: bool = True) -> SessionApp:
        session_id = session_id or self._default_session_id()
        app = SessionApp(
            self,
            session_id,
            window=self.window,
            max_turns=self.max_turns,
        )
        self.sessions[session_id] = app
        if activate:
            self.active_session_id = session_id
        asyncio.get_event_loop().create_task(
            self.hub.publish(session_id, SessionCreated(session_id=session_id))
        )
        return app

    def get_session(self, session_id: str) -> SessionApp | None:
        return self.sessions.get(session_id)

    async def ensure_session(self, session_id: str) -> SessionApp:
        app = self.get_session(session_id)
        if app is None:
            app = self.new_session(session_id)
        return app

    def active_session(self) -> SessionApp | None:
        if self.active_session_id:
            return self.get_session(self.active_session_id)
        return None

    def delete_session(self, session_id: str) -> None:
        app = self.sessions.pop(session_id, None)
        if app is not None and app.running:
            app.cancel()
        if self.active_session_id == session_id:
            self.active_session_id = None

    async def list_sessions(self) -> list[dict]:
        loaded = [await app.transcript() for app in self.sessions.values()]
        disk_ids = {p.stem for p in self.session_dir.glob("*.jsonl")}
        for session_id in sorted(disk_ids - set(self.sessions)):
            app = await self.ensure_session(session_id)
            loaded.append(await app.transcript())
        loaded.sort(key=lambda s: s.get("created_at", ""), reverse=True)
        return loaded

    def _default_session_id(self) -> str:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        return f"web-{stamp}-{len(self.sessions) + 1}"

    # ================================================================== messaging
    async def send(self, session_id: str, content: str) -> bool:
        """Send a user message; runs input hooks then queues/starts a turn."""
        content, handled = await self.extensions.run_input_hooks(content)
        if handled:
            return False
        if not self.configured:
            await self.notify(
                "Sarathy is not configured yet. Run `sarathy setup` or `sarathy onboard` to configure it.",
                "warning",
            )
            return False
        app = await self.ensure_session(session_id)
        self.active_session_id = session_id
        return await app.send(content)

    def cancel(self, session_id: str) -> None:
        app = self.get_session(session_id)
        if app is not None:
            app.cancel()
        asyncio.get_event_loop().create_task(self.hub.publish(session_id, RunEnd()))

    # ================================================================== event hooks (called by SessionApp)
    async def on_session_event(self, session: SessionApp, event: Any) -> None:
        await self.extensions.dispatch(session.session_id, event)

    # ================================================================== extension delivery
    async def send_user_message(self, content: str, *, deliver_as: str = "steer") -> None:
        app = self.active_session()
        if app is None:
            app = self.new_session(self._default_session_id())
        await app.send(content)

    async def append_entry(self, session_id: str, *, namespace: str, data: dict) -> None:
        app = await self.ensure_session(session_id)
        try:
            await app.storage.append(CustomEntry(namespace=namespace, data=data))
        except Exception as exc:  # noqa: BLE001
            logger.warning("append_entry failed: {}", exc)

    async def notify(self, message: str, level: str = "info") -> None:
        await self.hub.publish("", NotifyEvent(message=message, level=level))

    # ================================================================== cron / heartbeat / archival
    async def _on_cron_job(self, job: CronJob) -> str | None:
        logger.info("cron job '{}' firing", job.name)
        session_id = job.payload.to or f"cron-{job.id}"
        await self.send(session_id, job.payload.message)
        return None

    async def _archival_sweep(self) -> None:
        message_counts = []
        for app in list(self.sessions.values()):
            if app.running:
                continue
            messages = await app.messages()
            if len(messages) >= self.archivist.min_messages:
                excerpt = "".join(_text_of(m) for m in messages[-60:])
                message_counts.append((app.session_id, len(messages)))
                try:
                    await self.archivist.consolidate(excerpt)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("memory consolidation failed: {}", exc)
            else:
                try:
                    await self.archivist.consolidate("")
                except Exception:  # noqa: BLE001
                    pass
        if message_counts:
            logger.info("archival sweep: {}", message_counts)

    async def _heartbeat(self) -> None:
        while not self._stopping:
            self.last_heartbeat = asyncio.get_event_loop().time()
            await asyncio.sleep(10)

    async def _extension_reloader(self) -> None:
        while not self._stopping:
            await asyncio.sleep(5)

    # ================================================================== restart
    def request_restart(self) -> None:
        flag = self.data_dir / "restart.flag"
        flag.write_text(json.dumps({"requested_at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")
        logger.info("restart requested via {} (gateway manager detects & restarts)", flag)

    # ================================================================== health
    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "configured": self.configured,
            "model": self.model,
            "provider": self.provider_name,
            "workspace": str(self.workspace),
            "sessions": len(self.sessions),
            "extensions": len(self.extensions._extensions),
            "uptime_s": round(time.monotonic() - self._started_at, 1) if self._started_at else 0,
            "last_heartbeat": round(self.last_heartbeat, 1),
        }


def _text_of(message) -> str:
    from tau_agent.messages import TextContent

    try:
        return "".join(b.text for b in getattr(message, "content", []) if isinstance(b, TextContent))
    except Exception:  # noqa: BLE001
        return ""


def get_data_dir() -> Path:
    from sarathy.utils.helpers import get_data_path

    return get_data_path()

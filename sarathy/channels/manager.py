"""Channel manager for coordinating chat channels."""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.base import BaseChannel
from sarathy.config.schema import Config

# Bound per-channel outbound queues. Prefer dropping with a WARNING over
# unbounded memory growth when a slow channel falls behind (e.g. satellites
# streaming a long audio track). The router never awaits a full queue, so
# backpressure on one channel cannot stall delivery to others.
_CHANNEL_QUEUE_MAXSIZE = 100


class ChannelManager:
    """
    Manages chat channels and coordinates message routing.

    Responsibilities:
    - Initialize enabled channels (Telegram, WhatsApp, etc.)
    - Start/stop channels
    - Route outbound messages
    """

    def __init__(self, config: Config, bus: MessageBus, command_manager=None, session_manager=None, runtime=None, agent=None):
        self.config = config
        self.bus = bus
        self.command_manager = command_manager
        self.session_manager = session_manager
        self.runtime = runtime
        # Agent handle (spec 127 §A): handed to the dashboard channel so it can
        # read the authoritative turn registry. Optional — the dispatcher and
        # non-dashboard channels never need it.
        self.agent = agent
        self.channels: dict[str, BaseChannel] = {}
        self._dispatch_task: asyncio.Task | None = None
        self._channel_queues: dict[str, asyncio.Queue[OutboundMessage]] = {}
        self._worker_tasks: dict[str, asyncio.Task] = {}

        self._init_channels()

    def _init_channels(self) -> None:
        """Initialize channels based on config."""

        # Telegram channel
        if self.config.channels.telegram.enabled:
            try:
                from sarathy.channels.telegram import TelegramChannel

                self.channels["telegram"] = TelegramChannel(
                    self.config.channels.telegram,
                    self.bus,
                    command_manager=self.command_manager,
                )
                logger.info("Telegram channel enabled")
            except ImportError as e:
                logger.warning("Telegram channel not available: {}", e)

        # Discord channel
        if self.config.channels.discord.enabled:
            try:
                from sarathy.channels.discord import DiscordChannel

                self.channels["discord"] = DiscordChannel(
                    self.config.channels.discord,
                    self.bus,
                    command_manager=self.command_manager,
                )
                logger.info("Discord channel enabled")
            except ImportError as e:
                logger.warning("Discord channel not available: {}", e)

        # Email channel
        if self.config.channels.email.enabled:
            try:
                from sarathy.channels.email import EmailChannel

                self.channels["email"] = EmailChannel(self.config.channels.email, self.bus)
                logger.info("Email channel enabled")
            except ImportError as e:
                logger.warning("Email channel not available: {}", e)

        # Dashboard channel
        if self.config.channels.dashboard.enabled:
            try:
                from sarathy.channels.dashboard import DashboardChannel

                self.channels["dashboard"] = DashboardChannel(
                    self.config.channels.dashboard,
                    self.bus,
                    session_manager=self.session_manager,
                    runtime=self.runtime,
                    agent=self.agent,
                )
                logger.info("Dashboard channel enabled")

                # Voice (spec 173): the dashboard's /ws/voice publishes turns as
                # channel="voice". Register the adapter so the outbound dispatcher
                # routes the agent's answer back to the live socket instead of
                # logging "Unknown channel: voice" and dropping it.
                from sarathy.voice.channel import VoiceChannel

                self.channels["voice"] = VoiceChannel(
                    self.bus, self.channels["dashboard"]._voice
                )
            except ImportError as e:
                logger.warning("Dashboard channel not available: {}", e)

        # Satellites channel (LAN voice pucks) — mounts on the dashboard app.
        if self.config.channels.satellites.enabled:
            try:
                from sarathy.channels.satellites import SatellitesChannel

                sat = SatellitesChannel(
                    self.config.channels.satellites,
                    self.bus,
                    agent=self.agent,
                    session_manager=self.session_manager,
                )
                self.channels["satellites"] = sat
                dashboard = self.channels.get("dashboard")
                if dashboard is not None and hasattr(dashboard, "add_mount"):
                    dashboard.add_mount(sat.mount)
                    logger.info("Satellites channel enabled (mounted on dashboard)")
                else:
                    logger.warning(
                        "Satellites enabled but dashboard channel is off — "
                        "no HTTP listener to mount /satellites/ on"
                    )
            except ImportError as e:
                logger.warning("Satellites channel not available: {}", e)

        # Backend channel (third trigger path: HTTP endpoint + jobs.db tailer)
        if self.config.channels.backend.enabled:
            try:
                from sarathy.channels.backend import BackendChannel

                self.channels["backend"] = BackendChannel(
                    self.config.channels.backend,
                    self.bus,
                )
                logger.info("Backend channel enabled")
            except ImportError as e:
                logger.warning("Backend channel not available: {}", e)

    async def _start_channel(self, name: str, channel: BaseChannel) -> None:
        """Start a channel and log any exceptions."""
        try:
            await channel.start()
        except Exception as e:
            logger.error("Failed to start channel {}: {}", name, e)

    def _ensure_workers(self) -> None:
        """Create one bounded queue + worker task per registered channel."""
        for name, channel in self.channels.items():
            existing = self._worker_tasks.get(name)
            if existing is not None and not existing.done():
                continue
            queue: asyncio.Queue[OutboundMessage] = asyncio.Queue(
                maxsize=_CHANNEL_QUEUE_MAXSIZE
            )
            self._channel_queues[name] = queue
            self._worker_tasks[name] = asyncio.create_task(
                self._channel_worker(name, channel, queue),
                name=f"outbound-{name}",
            )

    async def _channel_worker(
        self,
        name: str,
        channel: BaseChannel,
        queue: asyncio.Queue[OutboundMessage],
    ) -> None:
        """Drain one channel's outbound queue FIFO; stay alive across send errors."""
        while True:
            msg = await queue.get()
            try:
                await channel.send(msg)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error("Error sending to {}: {}", name, e)

    def _enqueue(self, name: str, msg: OutboundMessage) -> None:
        """Put msg on a channel queue; drop with WARNING if the queue is full."""
        queue = self._channel_queues.get(name)
        if queue is None:
            logger.warning("Unknown channel: {}", name)
            return
        try:
            queue.put_nowait(msg)
        except asyncio.QueueFull:
            # Overflow policy: drop the newest message rather than block the
            # shared router (which would re-serialize every channel).
            logger.warning(
                "Outbound queue full for {} (maxsize={}); dropping message",
                name,
                _CHANNEL_QUEUE_MAXSIZE,
            )

    async def _stop_workers(self) -> None:
        """Cancel all per-channel workers and await their termination."""
        tasks = list(self._worker_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._worker_tasks.clear()
        self._channel_queues.clear()

    async def start_all(self) -> None:
        """Start all channels and the outbound dispatcher."""
        if not self.channels:
            logger.warning("No channels enabled")
            return

        # Start outbound dispatcher (spawns per-channel workers)
        self._dispatch_task = asyncio.create_task(self._dispatch_outbound())

        # Start channels
        tasks = []
        for name, channel in self.channels.items():
            logger.info("Starting {} channel...", name)
            tasks.append(asyncio.create_task(self._start_channel(name, channel)))

        # Wait for all to complete (they should run forever)
        await asyncio.gather(*tasks, return_exceptions=True)

    async def stop_all(self) -> None:
        """Stop all channels and the dispatcher."""
        logger.info("Stopping all channels...")

        # Stop dispatcher (its finally block cancels per-channel workers)
        if self._dispatch_task:
            self._dispatch_task.cancel()
            try:
                await self._dispatch_task
            except asyncio.CancelledError:
                pass
            self._dispatch_task = None

        # Belt-and-suspenders: clear any workers left if the router never ran
        await self._stop_workers()

        # Stop all channels
        for name, channel in self.channels.items():
            try:
                await channel.stop()
                logger.info("Stopped {} channel", name)
            except Exception as e:
                logger.error("Error stopping {}: {}", name, e)

    async def _dispatch_outbound(self) -> None:
        """Route outbound messages onto per-channel worker queues."""
        self._ensure_workers()
        logger.info("Outbound dispatcher started")

        try:
            while True:
                try:
                    msg = await asyncio.wait_for(self.bus.consume_outbound(), timeout=1.0)

                    if msg.metadata.get("_progress"):
                        voice_turn = msg.channel == "voice"
                        if (
                            msg.metadata.get("_tool_hint")
                            and not self.config.channels.send_tool_hints
                            and not msg.metadata.get("_phase")
                            and not voice_turn
                        ):
                            continue
                        if (
                            not msg.metadata.get("_tool_hint")
                            and not self.config.channels.send_progress
                            and not voice_turn
                        ):
                            continue

                    # Server-owned turn frames (spec 127 §A.2) are dashboard-only
                    # telemetry: route them to the dashboard channel even when their
                    # target channel differs, and never deliver them as a chat
                    # message on Telegram/Discord/Email (no-flood constraint).
                    if msg.metadata.get("_turn_state"):
                        if "dashboard" in self._channel_queues:
                            self._enqueue("dashboard", msg)
                        continue

                    if msg.channel in self.channels:
                        self._enqueue(msg.channel, msg)
                    else:
                        logger.warning("Unknown channel: {}", msg.channel)

                except asyncio.TimeoutError:
                    continue
                except asyncio.CancelledError:
                    break
        finally:
            await self._stop_workers()

    def get_channel(self, name: str) -> BaseChannel | None:
        """Get a channel by name."""
        return self.channels.get(name)

    def get_status(self) -> dict[str, Any]:
        """Get status of all channels."""
        return {
            name: {"enabled": True, "running": channel.is_running}
            for name, channel in self.channels.items()
        }

    @property
    def enabled_channels(self) -> list[str]:
        """Get list of enabled channel names."""
        return list(self.channels.keys())

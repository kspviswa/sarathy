"""VoiceChannel: bus adapter that routes ``channel="voice"`` outbound to the coordinator.

Voice turns are published onto the bus as ``InboundMessage(channel="voice", ...)``
so they get a full agent turn with their own session key. The agent's reply comes
back on the outbound queue addressed to ``voice`` — without this adapter the
dispatcher logs ``Unknown channel: voice`` and the answer is silently dropped
(the WebSocket never receives text or audio).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sarathy.bus.events import OutboundMessage
from sarathy.channels.base import BaseChannel

if TYPE_CHECKING:
    from sarathy.bus.queue import MessageBus
    from sarathy.voice.coordinator import VoiceCoordinator


class VoiceChannel(BaseChannel):
    """Thin routing shim: outbound ``voice`` messages → live VoiceCoordinator."""

    name = "voice"

    def __init__(self, bus: MessageBus, coordinator: VoiceCoordinator):
        super().__init__(config=None, bus=bus)
        self.coordinator = coordinator
        self._running = True

    async def start(self) -> None:
        # Nothing to consume: inbound voice turns are published by the
        # coordinator itself, and outbound is pushed by the dispatcher.
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def send(self, msg: OutboundMessage) -> None:
        await self.coordinator.handle_outbound(msg)

    def get_status(self) -> dict[str, Any]:
        return {"enabled": True, "running": self._running}

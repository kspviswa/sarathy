"""Spec 182 — per-channel outbound workers in ChannelManager.

A slow channel's ``send()`` must not block delivery to any other channel.
These tests pin the worker/queue redesign: isolation, FIFO ordering,
exception resilience, clean shutdown, and unknown-channel routing.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.manager import ChannelManager
from sarathy.config.schema import Config


class _FakeChannel:
    """Minimal channel stand-in with controllable ``send()`` behaviour."""

    def __init__(self) -> None:
        self.sent: list[OutboundMessage] = []
        self._block: asyncio.Event | None = None
        self._entered: asyncio.Event | None = None
        self._raise_once: Exception | None = None
        self._running = False

    def block_on(self, gate: asyncio.Event, entered: asyncio.Event | None = None) -> None:
        self._block = gate
        self._entered = entered

    def raise_once(self, exc: Exception) -> None:
        self._raise_once = exc

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    @property
    def is_running(self) -> bool:
        return self._running

    async def send(self, msg: OutboundMessage) -> None:
        if self._entered is not None:
            self._entered.set()
        if self._block is not None:
            await self._block.wait()
        if self._raise_once is not None:
            exc, self._raise_once = self._raise_once, None
            raise exc
        self.sent.append(msg)


def _disabled_config() -> Config:
    cfg = Config()
    for ch in ("telegram", "discord", "email", "dashboard", "backend", "satellites"):
        setattr(getattr(cfg.channels, ch), "enabled", False)
    return cfg


def _manager(channels: dict[str, _FakeChannel]) -> ChannelManager:
    bus = MessageBus()
    mgr = ChannelManager(_disabled_config(), bus)
    mgr.channels = channels  # type: ignore[assignment]
    return mgr


def _msg(channel: str, content: str) -> OutboundMessage:
    return OutboundMessage(channel=channel, chat_id="t", content=content)


async def _wait_until(pred, timeout: float = 2.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if pred():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not met before timeout")


@pytest.mark.asyncio
async def test_slow_channel_does_not_block_fast_channel() -> None:
    """Isolation: a blocked send on A must not delay delivery to B."""
    slow = _FakeChannel()
    fast = _FakeChannel()
    gate = asyncio.Event()
    entered = asyncio.Event()
    slow.block_on(gate, entered)

    mgr = _manager({"slow": slow, "fast": fast})
    router = asyncio.create_task(mgr._dispatch_outbound())
    try:
        await mgr.bus.publish_outbound(_msg("slow", "blocked"))
        await entered.wait()  # slow worker is parked inside send()

        await mgr.bus.publish_outbound(_msg("fast", "go"))
        await _wait_until(lambda: len(fast.sent) == 1)

        assert fast.sent[0].content == "go"
        assert slow.sent == []  # still blocked
    finally:
        gate.set()
        router.cancel()
        try:
            await router
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_ordering_preserved_within_channel() -> None:
    """FIFO: N messages to one channel arrive in publish order."""
    ch = _FakeChannel()
    mgr = _manager({"dash": ch})
    router = asyncio.create_task(mgr._dispatch_outbound())
    try:
        for i in range(10):
            await mgr.bus.publish_outbound(_msg("dash", f"m{i}"))
        await _wait_until(lambda: len(ch.sent) == 10)
        assert [m.content for m in ch.sent] == [f"m{i}" for i in range(10)]
    finally:
        router.cancel()
        try:
            await router
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_send_exception_keeps_worker_alive() -> None:
    """A raising send must not kill the worker or stall other channels."""
    boom = _FakeChannel()
    boom.raise_once(RuntimeError("boom"))
    other = _FakeChannel()
    mgr = _manager({"boom": boom, "other": other})
    router = asyncio.create_task(mgr._dispatch_outbound())
    try:
        await mgr.bus.publish_outbound(_msg("boom", "fail"))
        await mgr.bus.publish_outbound(_msg("boom", "ok"))
        await mgr.bus.publish_outbound(_msg("other", "peer"))
        await _wait_until(lambda: len(boom.sent) == 1 and len(other.sent) == 1)
        assert boom.sent[0].content == "ok"
        assert other.sent[0].content == "peer"
    finally:
        router.cancel()
        try:
            await router
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_stop_all_terminates_workers() -> None:
    """stop_all cancels the router and every per-channel worker."""
    a, b = _FakeChannel(), _FakeChannel()
    mgr = _manager({"a": a, "b": b})
    mgr._dispatch_task = asyncio.create_task(mgr._dispatch_outbound())
    await _wait_until(lambda: len(mgr._worker_tasks) == 2)

    workers = list(mgr._worker_tasks.values())
    assert all(not t.done() for t in workers)

    await mgr.stop_all()

    assert mgr._dispatch_task is None
    assert mgr._worker_tasks == {}
    assert mgr._channel_queues == {}
    assert all(t.done() for t in workers)


@pytest.mark.asyncio
async def test_unknown_channel_is_logged_and_ignored() -> None:
    """Unknown channel names are logged; the router keeps running."""
    known = _FakeChannel()
    mgr = _manager({"known": known})
    router = asyncio.create_task(mgr._dispatch_outbound())
    try:
        with patch("sarathy.channels.manager.logger.warning") as warn:
            await mgr.bus.publish_outbound(_msg("nope", "ghost"))
            await mgr.bus.publish_outbound(_msg("known", "alive"))
            await _wait_until(lambda: len(known.sent) == 1)
            await _wait_until(
                lambda: any(
                    "Unknown channel" in str(c) and "nope" in str(c)
                    for c in warn.call_args_list
                )
            )
        assert known.sent[0].content == "alive"
    finally:
        router.cancel()
        try:
            await router
        except asyncio.CancelledError:
            pass

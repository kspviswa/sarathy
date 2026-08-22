"""Tests for /new archival stamping and reviewer pending/retry logic."""

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from conftest import make_test_config

from sarathy.session.manager import SessionManager
from sarathy.session.review import BackgroundReviewer


class FakeProvider:
    """Provider stub that can fail N times, then return canned payloads."""

    def __init__(self, responses=None, fail_times=0):
        self.responses = list(responses or [])
        self.fail_times = fail_times
        self.calls = 0

    async def chat(self, messages=None):
        self.calls += 1
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("provider down")
        payload = self.responses.pop(0) if self.responses else '{"nothing_found": true}'
        return SimpleNamespace(content=payload)


def latest_archive_meta(workspace: Path) -> dict:
    """Read the metadata line of the most recent archived session file."""
    archive_dir = workspace / "archived_sessions"
    files = sorted(archive_dir.glob("session-*.jsonl"))
    assert files, "no archived sessions written"
    with open(files[-1], encoding="utf-8") as f:
        return json.loads(f.readline())


async def wait_until(cond, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        await asyncio.sleep(0.01)
    return False


def make_loop(tmp_path):
    """Build an AgentLoop wired to a real SessionManager in tmp_path."""
    from sarathy.agent.loop import AgentLoop
    from sarathy.bus.queue import MessageBus

    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    sm = SessionManager(config=make_test_config(tmp_path), workspace=tmp_path)
    return AgentLoop(
        bus=bus,
        provider=provider,
        workspace=tmp_path,
        model="test-model",
        memory_window=10,
        session_manager=sm,
    )


class TestArchiveStamping:
    def test_defaults_to_unverified(self, tmp_path: Path) -> None:
        """archive_session() without confirmation stamps archived=False."""
        manager = SessionManager(config=make_test_config(tmp_path), workspace=tmp_path)
        session = manager.get_or_create("telegram:1")
        session.add_message("user", "hello")
        session.archive_session()
        assert latest_archive_meta(tmp_path)["archived"] is False

    def test_learned_stamp_true(self, tmp_path: Path) -> None:
        """archive_session(learned=True) stamps archived=True."""
        manager = SessionManager(config=make_test_config(tmp_path), workspace=tmp_path)
        session = manager.get_or_create("telegram:1")
        session.add_message("user", "hello")
        session.archive_session(learned=True)
        assert latest_archive_meta(tmp_path)["archived"] is True


class TestHasPending:
    @pytest.mark.asyncio
    async def test_queue_and_inflight(self, tmp_path: Path) -> None:
        """has_pending covers both queued and mid-flight snapshots."""
        reviewer = BackgroundReviewer(provider=FakeProvider(), workspace=tmp_path)
        assert not reviewer.has_pending("a:1")

        await reviewer.enqueue([{"role": "user", "content": "hi"}], "a:1")
        assert reviewer.has_pending("a:1")
        assert not reviewer.has_pending("b:2")

        task = reviewer._queue.pop(0)
        reviewer._inflight = task
        assert reviewer.has_pending("a:1")

        reviewer._inflight = None
        assert not reviewer.has_pending("a:1")

    def test_disabled_reviewer_never_pending(self, tmp_path: Path) -> None:
        """A disabled pipeline reports nothing pending."""
        reviewer = BackgroundReviewer(provider=FakeProvider(), workspace=tmp_path, enabled=False)
        reviewer._queue.append({"messages": [], "session_key": "a:1"})
        assert not reviewer.has_pending("a:1")


class TestRetrySemantics:
    @pytest.mark.asyncio
    async def test_failed_review_is_retried_then_saved(self, tmp_path: Path) -> None:
        """A provider failure requeues the snapshot instead of dropping it."""
        fact = '{"memory": ["User likes tea"], "user": [], "skills": []}'
        provider = FakeProvider(responses=[fact], fail_times=1)
        reviewer = BackgroundReviewer(provider=provider, workspace=tmp_path, cooldown_seconds=0)
        await reviewer.start()
        try:
            await reviewer.enqueue([{"role": "user", "content": "I like tea"}], "s:1")

            memory_file = tmp_path / "memory" / "MEMORY.md"
            saved = await wait_until(lambda: memory_file.exists())
            assert saved, "review never succeeded after retry"
            assert "User likes tea" in memory_file.read_text(encoding="utf-8")
            assert provider.calls >= 2, "expected at least one retry"
            drained = await wait_until(
                lambda: not reviewer._queue and reviewer._inflight is None
            )
            assert drained
            assert not reviewer.has_pending("s:1")
        finally:
            await reviewer.stop()

    @pytest.mark.asyncio
    async def test_drops_after_max_retries(self, tmp_path: Path) -> None:
        """A permanently failing review is dropped after exhausting retries."""
        provider = FakeProvider(fail_times=99)
        reviewer = BackgroundReviewer(
            provider=provider,
            workspace=tmp_path,
            cooldown_seconds=0,
            max_retries=1,
        )
        await reviewer.start()
        try:
            await reviewer.enqueue([{"role": "user", "content": "hi"}], "s:1")
            dropped = await wait_until(
                lambda: not reviewer._queue
                and reviewer._inflight is None
                and provider.calls == 2
            )
            assert dropped, (
                f"expected drop after initial attempt + 1 retry, calls={provider.calls}"
            )
        finally:
            await reviewer.stop()

    @pytest.mark.asyncio
    async def test_malformed_json_is_retried(self, tmp_path: Path) -> None:
        """Unparseable LLM output counts as a retryable failure."""
        bad = "this is definitely not json"
        good = '{"nothing_found": true}'
        provider = FakeProvider(responses=[bad, good])
        reviewer = BackgroundReviewer(
            provider=provider,
            workspace=tmp_path,
            cooldown_seconds=0,
            max_retries=2,
        )
        await reviewer.start()
        try:
            await reviewer.enqueue([{"role": "user", "content": "hi"}], "s:1")
            processed = await wait_until(
                lambda: not reviewer._queue
                and reviewer._inflight is None
                and provider.calls == 2
            )
            assert processed, f"expected retry after bad JSON, calls={provider.calls}"
        finally:
            await reviewer.stop()


class TestArchiveSweep:
    def _archive_one(self, tmp_path: Path, key: str = "telegram:1") -> SessionManager:
        manager = SessionManager(config=make_test_config(tmp_path), workspace=tmp_path)
        session = manager.get_or_create(key)
        session.add_message("user", "I like tea")
        session.archive_session()
        return manager

    @pytest.mark.asyncio
    async def test_processes_unverified_and_marks(self, tmp_path: Path) -> None:
        """Sweep extracts facts from unverified archives, then flips the stamp."""
        fact = '{"memory": ["User likes tea"], "user": [], "skills": []}'
        reviewer = BackgroundReviewer(
            provider=FakeProvider(responses=[fact]),
            workspace=tmp_path,
            cooldown_seconds=0,
        )
        manager = self._archive_one(tmp_path)

        processed = await reviewer._archive_sweep(manager)

        assert processed == 1
        memory_file = tmp_path / "memory" / "MEMORY.md"
        assert "User likes tea" in memory_file.read_text(encoding="utf-8")
        assert latest_archive_meta(tmp_path)["archived"] is True
        assert manager.get_unarchived() == []

    @pytest.mark.asyncio
    async def test_failure_leaves_stamp_false(self, tmp_path: Path) -> None:
        """A failing review keeps archived=False for retry on next startup."""
        provider = FakeProvider(fail_times=99)
        reviewer = BackgroundReviewer(provider=provider, workspace=tmp_path)
        manager = self._archive_one(tmp_path)

        processed = await reviewer._archive_sweep(manager)

        assert processed == 0
        assert provider.calls >= 1
        assert len(manager.get_unarchived()) == 1

    @pytest.mark.asyncio
    async def test_marks_all_files_of_same_key(self, tmp_path: Path) -> None:
        """Two unverified archives of one chat both get verified in one sweep."""
        reviewer = BackgroundReviewer(provider=FakeProvider(), workspace=tmp_path)
        manager = self._archive_one(tmp_path)

        # Hand-write a second unverified archive for the SAME key under a
        # distinct filename (simulating an earlier /new).
        archive_dir = tmp_path / "archived_sessions"
        src = sorted(archive_dir.glob("session-*.jsonl"))[0]
        dst = archive_dir / "session-2026-08-22T10-00.jsonl"
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

        processed = await reviewer._archive_sweep(manager)

        assert processed == 2
        stamps = [
            json.loads(open(f, encoding="utf-8").readline())["archived"]
            for f in sorted(archive_dir.glob("session-*.jsonl"))
        ]
        assert stamps == [True, True]
        assert manager.get_unarchived() == []

    @pytest.mark.asyncio
    async def test_disabled_reviewer_noop(self, tmp_path: Path) -> None:
        """Sweep is skipped entirely when review is disabled."""
        reviewer = BackgroundReviewer(
            provider=FakeProvider(), workspace=tmp_path, enabled=False
        )
        manager = self._archive_one(tmp_path)

        processed = await reviewer._archive_sweep(manager)

        assert processed == 0
        assert len(manager.get_unarchived()) == 1

    @pytest.mark.asyncio
    async def test_schedule_respects_enabled_flag(self, tmp_path: Path) -> None:
        """schedule_archive_sweep spawns no task when disabled."""
        reviewer = BackgroundReviewer(
            provider=FakeProvider(), workspace=tmp_path, enabled=False
        )
        manager = self._archive_one(tmp_path)

        reviewer.schedule_archive_sweep(manager)

        assert reviewer._sweep_task is None


class TestNewCommandStamping:
    @pytest.mark.asyncio
    async def test_stamps_true_when_reviewer_idle(self, tmp_path: Path) -> None:
        """/new stamps archived=True when live review finished for the session."""
        from sarathy.bus.events import InboundMessage

        loop = make_loop(tmp_path)
        loop.reviewer = BackgroundReviewer(provider=FakeProvider(), workspace=tmp_path)

        session = loop.sessions.get_or_create("cli:test")
        session.add_message("user", "hello")
        msg = InboundMessage(channel="cli", sender_id="user", chat_id="test", content="/new")

        await loop._handle_new_command(session, msg)

        assert latest_archive_meta(tmp_path)["archived"] is True

    @pytest.mark.asyncio
    async def test_stamps_false_when_snapshots_pending(self, tmp_path: Path) -> None:
        """/new keeps archived=False when the reviewer still owes this session a review."""
        from sarathy.bus.events import InboundMessage

        loop = make_loop(tmp_path)
        reviewer = BackgroundReviewer(provider=FakeProvider(), workspace=tmp_path)
        loop.reviewer = reviewer

        session = loop.sessions.get_or_create("cli:test")
        session.add_message("user", "hello")
        await reviewer.enqueue([{"role": "user", "content": "hello"}], "cli:test")

        msg = InboundMessage(channel="cli", sender_id="user", chat_id="test", content="/new")
        await loop._handle_new_command(session, msg)

        assert latest_archive_meta(tmp_path)["archived"] is False

    @pytest.mark.asyncio
    async def test_stamps_true_without_reviewer(self, tmp_path: Path) -> None:
        """/new without any reviewer has nothing pending to wait for."""
        from sarathy.bus.events import InboundMessage

        loop = make_loop(tmp_path)

        session = loop.sessions.get_or_create("cli:test")
        session.add_message("user", "hello")
        msg = InboundMessage(channel="cli", sender_id="user", chat_id="test", content="/new")

        await loop._handle_new_command(session, msg)

        assert latest_archive_meta(tmp_path)["archived"] is True

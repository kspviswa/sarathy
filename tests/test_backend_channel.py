"""Tests for the BackendChannel third trigger path (job 114)."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

import aiohttp
import pytest

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.backend import BackendChannel
from sarathy.config.schema import BackendConfig, Config


def _make_channel(tmp_path, jobs_db=None, **overrides) -> BackendChannel:
    kwargs = {
        "enabled": True,
        "token": "test-token",
        "port": 0,
    }
    if jobs_db is not None:
        kwargs["jobs_db_path"] = str(jobs_db)
    kwargs.update(overrides)
    config = BackendConfig(**kwargs)
    return BackendChannel(
        config,
        MessageBus(),
        watermark_path=tmp_path / "backend_watermark.json",
        poll_interval=0.05,
    )


async def _started(channel: BackendChannel) -> asyncio.Task:
    task = asyncio.create_task(channel.start())
    for _ in range(100):
        if channel._running:
            break
        await asyncio.sleep(0.05)
    assert channel._running, "backend channel did not start"
    return task


async def _stopped(channel: BackendChannel, task: asyncio.Task) -> None:
    await channel.stop()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def _auth_headers(token: str = "test-token") -> dict:
    return {"Authorization": f"Bearer {token}"}


def _make_jobs_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, status TEXT)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS job_events (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " job_id INTEGER, ts TEXT, event_type TEXT, level TEXT, message TEXT, payload TEXT)"
        )
        conn.commit()
    finally:
        conn.close()


def _insert_event(path: Path, job_id: int, event_type: str, message: str = "hello",
                  payload: dict | None = None) -> int:
    conn = sqlite3.connect(str(path))
    try:
        cur = conn.execute(
            "INSERT INTO job_events (job_id, ts, event_type, level, message, payload)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (job_id, "2026-10-04T20:00:00Z", event_type, "info", message,
             json.dumps(payload or {})),
        )
        conn.commit()
        return int(cur.lastrowid)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# HTTP endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_event_happy_path(tmp_path):
    ch = _make_channel(tmp_path)
    task = await _started(ch)
    try:
        port = ch.bound_port
        assert port
        envelope = {
            "event_type": "job.completed",
            "source": "jobctl",
            "job_id": "42",
            "source_session_id": "telegram:5878545507",
            "payload": {"message": "all done", "extra": {}},
            "ts": "2026-10-04T20:00:00Z",
            "escalate_to": "telegram:5878545507",
        }
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                f"http://127.0.0.1:{port}/event",
                json=envelope,
                headers=_auth_headers(),
            ) as resp:
                assert resp.status == 200
                body = await resp.json()
        assert body["ok"] is True
        assert body["session"] == "backend:42"

        msg = await asyncio.wait_for(ch.bus.consume_inbound(), timeout=2)
        assert msg.channel == "backend"
        assert msg.session_key_override == "backend:42"
        assert msg.chat_id == "42"
        assert "[job 42 job.completed]" in msg.content
        assert "all done" in msg.content
        assert msg.metadata["source_session_id"] == "telegram:5878545507"
        assert msg.metadata["escalate_to"] == "telegram:5878545507"
        assert msg.metadata["payload"] == {"message": "all done", "extra": {}}
    finally:
        await _stopped(ch, task)


@pytest.mark.asyncio
async def test_post_event_auth_variants(tmp_path):
    ch = _make_channel(tmp_path)
    task = await _started(ch)
    try:
        port = ch.bound_port
        envelope = {"event_type": "x.y", "source": "jobctl"}
        async with aiohttp.ClientSession() as sess:
            async with sess.post(f"http://127.0.0.1:{port}/event", json=envelope) as resp:
                assert resp.status == 401
            async with sess.post(
                f"http://127.0.0.1:{port}/event", json=envelope,
                headers=_auth_headers("wrong"),
            ) as resp:
                assert resp.status == 401
            # Alternate header works.
            async with sess.post(
                f"http://127.0.0.1:{port}/event", json=envelope,
                headers={"X-Sarathy-Token": "test-token"},
            ) as resp:
                assert resp.status == 200
        # Health needs no auth.
        async with aiohttp.ClientSession() as sess:
            async with sess.get(f"http://127.0.0.1:{port}/health") as resp:
                assert resp.status == 200
                assert (await resp.json()) == {"ok": True}
    finally:
        await _stopped(ch, task)


@pytest.mark.asyncio
async def test_post_event_allow_from_403(tmp_path):
    ch = _make_channel(tmp_path, allow_from=["jobctl"])
    task = await _started(ch)
    try:
        port = ch.bound_port
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                f"http://127.0.0.1:{port}/event",
                json={"event_type": "x.y", "source": "intruder"},
                headers=_auth_headers(),
            ) as resp:
                assert resp.status == 403
    finally:
        await _stopped(ch, task)


@pytest.mark.asyncio
async def test_post_event_malformed_400(tmp_path):
    ch = _make_channel(tmp_path)
    task = await _started(ch)
    try:
        port = ch.bound_port
        async with aiohttp.ClientSession() as sess:
            # Missing event_type.
            async with sess.post(
                f"http://127.0.0.1:{port}/event",
                json={"source": "jobctl"},
                headers=_auth_headers(),
            ) as resp:
                assert resp.status == 400
            # Missing source.
            async with sess.post(
                f"http://127.0.0.1:{port}/event",
                json={"event_type": "x.y"},
                headers=_auth_headers(),
            ) as resp:
                assert resp.status == 400
            # Not JSON.
            async with sess.post(
                f"http://127.0.0.1:{port}/event",
                data="not json",
                headers={**_auth_headers(), "Content-Type": "application/json"},
            ) as resp:
                assert resp.status == 400
    finally:
        await _stopped(ch, task)


@pytest.mark.asyncio
async def test_refuse_start_without_token(tmp_path):
    ch = _make_channel(tmp_path, token="")
    await ch.start()  # returns without binding
    assert not ch._running
    await ch.stop()


# ---------------------------------------------------------------------------
# jobs.db tailer
# ---------------------------------------------------------------------------


def test_tailer_publishes_and_advances_watermark(tmp_path):
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db, tail_event_types=["completed"])

    # Pre-existing rows are NOT replayed on first init.
    _insert_event(jobs_db, 1, "completed", "old news")
    ch._init_watermark()
    assert ch._poll_new_events() == []

    row_id = _insert_event(jobs_db, 7, "completed", "fresh result")
    events = ch._poll_new_events()
    assert len(events) == 1
    assert events[0]["job_id"] == "7"

    msg = ch._tail_event_to_inbound(events[0])
    assert msg is not None
    assert msg.session_key_override == "backend:job-7"
    assert msg.chat_id == "7"
    assert "[job 7 completed]" in msg.content

    watermark = json.loads((tmp_path / "backend_watermark.json").read_text())
    assert watermark["last_id"] >= row_id

    # Non-tailed event types are filtered but still advance the watermark.
    _insert_event(jobs_db, 7, "heartbeat-tick", "noise")
    assert ch._poll_new_events() != []  # consumed (filtered downstream)
    assert ch._tail_event_to_inbound(
        {"job_id": "7", "event_type": "heartbeat-tick", "message": "n",
         "payload": {}, "ts": "t"}
    ) is None


def test_tailer_no_refire_after_restart(tmp_path):
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db)
    ch._init_watermark()
    _insert_event(jobs_db, 3, "crash", "boom")
    assert len(ch._poll_new_events()) == 1

    # Simulate a restart: new instance, same watermark file.
    ch2 = _make_channel(tmp_path, jobs_db=jobs_db)
    ch2._init_watermark()
    assert ch2._poll_new_events() == []


# ---------------------------------------------------------------------------
# escalate_to
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_escalate_to_routed_via_bus(tmp_path):
    ch = _make_channel(tmp_path)
    await ch.send(
        OutboundMessage(
            channel="backend", chat_id="42", content="job finished",
            metadata={"escalate_to": "telegram:5878545507"},
        )
    )
    out = await asyncio.wait_for(ch.bus.consume_outbound(), timeout=2)
    assert out.channel == "telegram"
    assert out.chat_id == "5878545507"
    assert out.content == "job finished"


@pytest.mark.asyncio
async def test_send_without_escalate_only_logs(tmp_path):
    ch = _make_channel(tmp_path)
    await ch.send(OutboundMessage(channel="backend", chat_id="42", content="quiet"))
    assert ch.bus.outbound_size == 0


def test_tailer_prefers_stamped_escalation_over_fallback(tmp_path):
    """jobctl stamps source_session onto every event payload (KB #396): the
    tailer must prefer that stamped escalate_to over the live-chat fallback."""
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db, tail_event_types=["completed"])
    ch._init_watermark()
    _insert_event(jobs_db, 10, "completed", "done",
                  payload={"pid": 123, "escalate_to": "telegram:9876543210",
                           "source_session_id": "9876543210"})
    events = ch._poll_new_events()
    msg = ch._tail_event_to_inbound(events[0])
    assert msg.metadata["escalate_to"] == "telegram:9876543210"
    assert msg.metadata["source_session_id"] == "9876543210"


def test_tailer_escalates_to_live_chat_by_default(tmp_path):
    """Tailer events must carry an escalate_to so relays reach the live chat,
    even when the event row has no session info (KB #395)."""
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db, tail_event_types=["completed"])
    ch._init_watermark()
    _insert_event(jobs_db, 9, "completed", "done")
    events = ch._poll_new_events()
    assert len(events) == 1
    msg = ch._tail_event_to_inbound(events[0])
    assert msg is not None
    assert msg.metadata["escalate_to"] == "telegram:5878545507"
    assert msg.metadata["source_session_id"] is None  # no session info on row
    # And the escalation is routable through send() via the bus.
    import asyncio as _aio

    async def _route():
        await ch.send(
            OutboundMessage(
                channel="backend", chat_id="9", content="job finished",
                metadata={"escalate_to": msg.metadata["escalate_to"]},
            )
        )
        out = await _aio.wait_for(ch.bus.consume_outbound(), timeout=2)
        return out

    out = _aio.run(_route())
    assert out.channel == "telegram"
    assert out.chat_id == "5878545507"


def test_tailer_ignores_notification_only_events_by_default(tmp_path):
    """completed/verified are notification-only: the monitor pings them. The
    tailer must NOT wake the agent for them — that was the job 118 noise
    (2 completed events → 2 wakes → 4 pings). Only actionable events
    (needs_input, crash, stalled) wake the agent + fire the ack."""
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db)  # default tail types
    ch._init_watermark()
    _insert_event(jobs_db, 1, "completed", "done marker found")
    _insert_event(jobs_db, 2, "completed", "job finished")
    _insert_event(jobs_db, 3, "stalled", "no log growth")
    events = ch._poll_new_events()
    msgs = [ch._tail_event_to_inbound(e) for e in events]
    # Only the stalled event wakes the agent; both completed events are dropped.
    assert msgs[0] is None
    assert msgs[1] is None
    assert msgs[2] is not None
    assert "stalled" in msgs[2].content


# ---------------------------------------------------------------------------
# config schema
# ---------------------------------------------------------------------------


def test_backend_config_defaults_and_migration():
    cfg = Config()
    assert cfg.channels.backend.enabled is False
    assert cfg.channels.backend.host == "127.0.0.1"
    assert cfg.channels.backend.port == 18791
    assert cfg.channels.backend.token == ""
    assert cfg.channels.backend.tail_event_types == [
        "needs_input", "crash", "stalled",
    ]
    # Old configs without the backend key validate with defaults.
    legacy = Config.model_validate({"agents": {}, "channels": {"telegram": {}}, "tools": {}})
    assert legacy.channels.backend.enabled is False


# ---------------------------------------------------------------------------
# trigger ack (canned 'engaged, investigating' — fired in code, no LLM)
# ---------------------------------------------------------------------------


def test_tailer_fires_trigger_ack_to_live_chat(tmp_path):
    """A tailed event must publish BOTH the inbound wake AND a canned ack to
    the escalation target (live chat by default) — before any agent turn."""
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db)
    ch._init_watermark()
    _insert_event(jobs_db, 116, "crash", "Process 535195 is dead — job likely crashed.",
                  payload={"pid": 535195})
    events = ch._poll_new_events()
    msg = ch._tail_event_to_inbound(events[0])
    assert msg is not None

    async def _run():
        await ch.bus.publish_inbound(msg)
        await ch._publish_trigger_ack(msg)
        out = await asyncio.wait_for(ch.bus.consume_outbound(), timeout=2)
        return out

    out = asyncio.run(_run())
    assert out.channel == "telegram"
    assert out.chat_id == "5878545507"
    assert "🛠️" in out.content
    assert "[job 116 crash]" in out.content
    assert "engaged" in out.content
    assert "Full report shortly" in out.content
    assert out.metadata == {"_progress": False, "_tool_hint": False}


def test_tail_loop_publishes_ack_for_each_triggered_event(tmp_path):
    """End-to-end: the real _tail_loop fires the ack per triggered event."""
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db, tail_event_types=["crash"])
    ch._init_watermark()
    _insert_event(jobs_db, 116, "crash", "boom", payload={})
    _insert_event(jobs_db, 117, "crash", "bang", payload={})

    async def _run():
        # Drive the loop body manually (single iteration, no sleep).
        acks = []
        for event in ch._poll_new_events():
            msg = ch._tail_event_to_inbound(event)
            if msg is not None:
                await ch.bus.publish_inbound(msg)
                await ch._publish_trigger_ack(msg)
                acks.append(msg)
        outs = []
        for _ in range(len(acks)):
            outs.append(await asyncio.wait_for(ch.bus.consume_outbound(), timeout=2))
        return outs

    outs = asyncio.run(_run())
    assert len(outs) == 2
    assert all(o.channel == "telegram" and o.chat_id == "5878545507" for o in outs)
    assert "[job 116 crash]" in outs[0].content
    assert "[job 117 crash]" in outs[1].content


@pytest.mark.asyncio
async def test_http_event_fires_trigger_ack(tmp_path):
    """POST /event publishes the inbound wake AND the canned ack."""
    ch = _make_channel(tmp_path)
    task = await _started(ch)
    try:
        port = ch.bound_port
        envelope = {
            "event_type": "completed",
            "source": "jobctl",
            "job_id": "42",
            "source_session_id": "telegram:5878545507",
            "payload": {"message": "all done"},
            "ts": "2026-10-05T20:00:00Z",
            "escalate_to": "telegram:5878545507",
        }
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                f"http://127.0.0.1:{port}/event",
                json=envelope,
                headers=_auth_headers(),
            ) as resp:
                assert resp.status == 200
        inbound = await asyncio.wait_for(ch.bus.consume_inbound(), timeout=2)
        outbound = await asyncio.wait_for(ch.bus.consume_outbound(), timeout=2)
        assert inbound.session_key_override == "backend:42"
        assert outbound.channel == "telegram"
        assert outbound.chat_id == "5878545507"
        assert "🛠️" in outbound.content
        assert "[job 42 completed]" in outbound.content
    finally:
        await _stopped(ch, task)


def test_trigger_ack_respects_stamped_escalate_to(tmp_path):
    """The ack targets the event's stamped escalation target, not the fallback."""
    jobs_db = tmp_path / "jobs.db"
    _make_jobs_db(jobs_db)
    ch = _make_channel(tmp_path, jobs_db=jobs_db, tail_event_types=["completed"])
    ch._init_watermark()
    _insert_event(jobs_db, 10, "completed", "done",
                  payload={"pid": 123, "escalate_to": "telegram:9876543210"})
    events = ch._poll_new_events()
    msg = ch._tail_event_to_inbound(events[0])
    assert msg.metadata["escalate_to"] == "telegram:9876543210"

    async def _run():
        await ch.bus.publish_inbound(msg)
        await ch._publish_trigger_ack(msg)
        out = await asyncio.wait_for(ch.bus.consume_outbound(), timeout=2)
        return out

    out = asyncio.run(_run())
    assert out.channel == "telegram"
    assert out.chat_id == "9876543210"


def test_send_does_not_escalate_progress_chatter(tmp_path):
    """Progress/thinking messages must NOT reach the user — that was the
    'one wake = 12 pings' bug (job 116, 2026-10-05). Only final responses
    escalate; progress stays in the session stream."""
    ch = _make_channel(tmp_path)

    async def _run():
        # Progress message must be swallowed (no outbound published).
        await ch.send(OutboundMessage(
            channel="backend", chat_id="116",
            content="Process is alive...",
            metadata={"escalate_to": "telegram:5878545507", "_progress": True},
        ))
        # Thinking message must also be swallowed.
        await ch.send(OutboundMessage(
            channel="backend", chat_id="116",
            content="hmm...", metadata={"escalate_to": "telegram:5878545507", "_thinking": True},
        ))
        # Final response MUST escalate.
        await ch.send(OutboundMessage(
            channel="backend", chat_id="116",
            content="Job 116 root-caused and relaunched, sir.",
            metadata={"escalate_to": "telegram:5878545507", "_final": True},
        ))
        out = await asyncio.wait_for(ch.bus.consume_outbound(), timeout=2)
        # Ensure no second outbound is waiting (progress/thinking were dropped).
        try:
            extra = await asyncio.wait_for(ch.bus.consume_outbound(), timeout=0.3)
        except asyncio.TimeoutError:
            extra = None
        return out, extra

    out, extra = asyncio.run(_run())
    assert out.channel == "telegram"
    assert out.chat_id == "5878545507"
    assert "root-caused and relaunched" in out.content
    assert extra is None

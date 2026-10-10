"""Notification parity: TG→dashboard fan-out (job 125).

Three layers are covered, matching spec 125 §A:

* ``jobctl.emit()`` writes a FAN-OUT ``escalate_to`` list so a job event always
  reaches Telegram *and* the dashboard console (§A1);
* the backend channel escalates to every target, flagging the dashboard copy so
  it renders as an in-app notification instead of a chat message (§A2/§A3);
* ``DashboardChannel.send()`` turns that flag into a ``notification`` frame and
  leaves every other message exactly as it was (§A2).
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path

import pytest

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.backend import (
    BackendChannel,
    escalation_metadata,
    resolve_escalate_targets,
)
from sarathy.config.schema import BackendConfig
from sarathy.core.notify import DASHBOARD_CHAT_ID, DASHBOARD_CHANNEL, TG_LIVE_CHAT_ID

WORKSPACE = Path(os.environ.get("SARATHY_WORKSPACE", "/home/kspviswa/.sarathy/workspace"))
JOBCTL = Path(os.environ.get("SARATHY_JOBCTL", WORKSPACE / "scripts" / "jobctl.py"))

# The canonical fan-out, restated here so a stale id in either implementation
# fails the test rather than silently pinging nobody.
LIVE_TG = "5878545507"
assert TG_LIVE_CHAT_ID == LIVE_TG
assert (DASHBOARD_CHANNEL, DASHBOARD_CHAT_ID) == ("dashboard", "console")


# ---------------------------------------------------------------------------
# §A1 jobctl: job events carry a fan-out list
# ---------------------------------------------------------------------------


def _load_jobctl(tmp_path, monkeypatch):
    """Import the stdlib-only workspace script against a scratch DB."""
    if not JOBCTL.exists():
        pytest.skip(f"jobctl.py not found at {JOBCTL}")
    monkeypatch.setenv("JOBS_DB", str(tmp_path / "jobs.db"))
    monkeypatch.setenv("JOBS_DIR", str(tmp_path / "jobs"))
    spec = importlib.util.spec_from_file_location("sarathy_jobctl_under_test", JOBCTL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _add_job(conn, job_id: int, source_session: str) -> None:
    conn.execute(
        "INSERT INTO jobs (id, kind, title, status, source_session, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (job_id, "sdd", f"job {job_id}", "running", source_session, "t0", "t0"),
    )
    conn.commit()


def _event_payload(conn, job_id: int) -> dict:
    row = conn.execute(
        "SELECT payload FROM job_events WHERE job_id=? ORDER BY id DESC LIMIT 1", (job_id,)
    ).fetchone()
    return json.loads(row["payload"])


def test_emit_fans_out_to_telegram_and_dashboard(tmp_path, monkeypatch):
    jobctl = _load_jobctl(tmp_path, monkeypatch)
    conn = jobctl.connect()
    _add_job(conn, 1, f"telegram:{LIVE_TG}")

    jobctl.emit(conn, 1, "milestone", "halfway there")

    payload = _event_payload(conn, 1)
    assert payload["escalate_to"] == [f"telegram:{LIVE_TG}", "dashboard:console"]
    assert payload["source_session_id"] == LIVE_TG
    # AC1: the live chat id, never the stale one.
    assert "8281248569" not in json.dumps(payload)


def test_emit_prepends_the_origin_session_and_dedupes(tmp_path, monkeypatch):
    jobctl = _load_jobctl(tmp_path, monkeypatch)
    conn = jobctl.connect()
    _add_job(conn, 2, "dashboard:console")

    jobctl.emit(conn, 2, "completed", "done")

    # Origin already in the fan-out → no duplicate entry.
    assert _event_payload(conn, 2)["escalate_to"] == [
        "dashboard:console",
        f"telegram:{LIVE_TG}",
    ]


def test_emit_keeps_a_third_origin_session_in_front(tmp_path, monkeypatch):
    jobctl = _load_jobctl(tmp_path, monkeypatch)
    conn = jobctl.connect()
    _add_job(conn, 3, "cli:direct")

    jobctl.emit(conn, 3, "note", "hi")

    assert _event_payload(conn, 3)["escalate_to"] == [
        "cli:direct",
        f"telegram:{LIVE_TG}",
        "dashboard:console",
    ]


def test_emit_bare_source_session_is_treated_as_telegram(tmp_path, monkeypatch):
    jobctl = _load_jobctl(tmp_path, monkeypatch)
    conn = jobctl.connect()
    _add_job(conn, 4, "5878545507")

    jobctl.emit(conn, 4, "note", "hi")

    assert _event_payload(conn, 4)["escalate_to"] == [
        f"telegram:{LIVE_TG}",
        "dashboard:console",
    ]


def test_explicit_escalate_to_still_wins(tmp_path, monkeypatch):
    """A caller-supplied target must not be overwritten by the fan-out."""
    jobctl = _load_jobctl(tmp_path, monkeypatch)
    conn = jobctl.connect()
    _add_job(conn, 5, "dashboard:console")

    jobctl.emit(conn, 5, "note", "hi", payload={"escalate_to": "telegram:999"})

    assert _event_payload(conn, 5)["escalate_to"] == "telegram:999"


def test_jobctl_fan_out_matches_the_gateway_helper(tmp_path, monkeypatch):
    """The mirrored constant must not drift from sarathy.core.notify."""
    from sarathy.core.notify import default_notify_targets

    jobctl = _load_jobctl(tmp_path, monkeypatch)
    assert jobctl.escalate_targets_for(None) == [
        f"telegram:{LIVE_TG}",
        "dashboard:console",
    ]
    expected = [f"{c}:{i}" for c, i in default_notify_targets(("dashboard", "console"))]
    assert jobctl.escalate_targets_for("dashboard:console") == expected


# ---------------------------------------------------------------------------
# §A2/§A3 backend: fan out, and flag the dashboard copy as a notification
# ---------------------------------------------------------------------------


def _make_channel(tmp_path, **overrides) -> BackendChannel:
    kwargs = {"enabled": True, "token": "t", "port": 0}
    kwargs.update(overrides)
    return BackendChannel(
        BackendConfig(**kwargs),
        MessageBus(),
        watermark_path=tmp_path / "wm.json",
        poll_interval=0.05,
    )


FAN_OUT = [f"telegram:{LIVE_TG}", "dashboard:console"]


def test_escalation_metadata_flags_only_the_dashboard():
    assert escalation_metadata("telegram") == {"_progress": False, "_tool_hint": False}
    dash = escalation_metadata("dashboard", title="Sarathy engaged")
    assert dash["notify"] is True
    assert dash["tab"] == "jobs"
    assert dash["notify_title"] == "Sarathy engaged"


def test_resolve_escalate_targets_reads_the_fan_out_list():
    assert resolve_escalate_targets(FAN_OUT) == [
        ("telegram", LIVE_TG),
        ("dashboard", "console"),
    ]
    # Unset keeps the legacy single-target fallback for the ack path (KB #391).
    assert resolve_escalate_targets(None) == [("telegram", LIVE_TG)]
    # ...and no escalation at all for the reply path (job 116: no flood).
    assert resolve_escalate_targets(None, fallback_to_live=False) == []


def _drain(channel: BackendChannel, n: int) -> list[OutboundMessage]:
    """Consume ``n`` outbound messages, failing fast if fewer are queued."""

    async def _run():
        return [
            await asyncio.wait_for(channel.bus.consume_outbound(), timeout=2)
            for _ in range(n)
        ]

    return asyncio.run(_run())


def test_trigger_ack_fans_out_to_every_target(tmp_path):
    ch = _make_channel(tmp_path)
    msg = type(
        "M",
        (),
        {
            "content": "[job 125 milestone] halfway",
            "metadata": {"escalate_to": FAN_OUT},
        },
    )()

    asyncio.run(ch._publish_trigger_ack(msg))
    tg, dash = _drain(ch, 2)

    assert (tg.channel, tg.chat_id) == ("telegram", LIVE_TG)
    # Telegram keeps getting a plain chat message.
    assert "notify" not in tg.metadata
    assert "engaged" in tg.content

    assert (dash.channel, dash.chat_id) == ("dashboard", "console")
    # The dashboard gets the SAME escalation as an in-app notification.
    assert dash.metadata["notify"] is True
    assert dash.metadata["tab"] == "jobs"
    assert dash.content == tg.content


@pytest.mark.asyncio
async def test_trigger_ack_without_escalate_still_hits_telegram_only(tmp_path):
    """KB #391: unset escalate_to → the live chat, and nothing else."""
    ch = _make_channel(tmp_path)
    msg = type("M", (), {"content": "[job 1 crash] boom", "metadata": {}})()

    await ch._publish_trigger_ack(msg)

    tg = await asyncio.wait_for(ch.bus.consume_outbound(), timeout=2)
    assert (tg.channel, tg.chat_id) == ("telegram", LIVE_TG)
    assert ch.bus.outbound_size == 0


def test_send_fans_out_and_marks_the_dashboard_copy(tmp_path):
    ch = _make_channel(tmp_path)
    asyncio.run(
        ch.send(
            OutboundMessage(
                channel="backend", chat_id="125", content="job finished",
                metadata={"escalate_to": FAN_OUT},
            )
        )
    )
    tg, dash = _drain(ch, 2)

    assert (tg.channel, tg.chat_id) == ("telegram", LIVE_TG)
    assert "notify" not in tg.metadata
    assert (dash.channel, dash.chat_id) == ("dashboard", "console")
    assert dash.metadata["notify"] is True
    assert dash.content == "job finished"


@pytest.mark.asyncio
async def test_send_without_escalate_sends_nothing(tmp_path):
    """Job 116: an unset escalate_to must not ping Telegram per turn."""
    ch = _make_channel(tmp_path)
    await ch.send(OutboundMessage(channel="backend", chat_id="125", content="quiet"))
    assert ch.bus.outbound_size == 0


@pytest.mark.asyncio
async def test_send_still_skips_progress_chatter(tmp_path):
    ch = _make_channel(tmp_path)
    await ch.send(
        OutboundMessage(
            channel="backend", chat_id="125", content="hmm",
            metadata={"escalate_to": FAN_OUT, "_progress": True},
        )
    )
    await ch.send(
        OutboundMessage(
            channel="backend", chat_id="125", content="hmm",
            metadata={"escalate_to": FAN_OUT, "_thinking": True},
        )
    )
    assert ch.bus.outbound_size == 0


# ---------------------------------------------------------------------------
# §A2 dashboard: notify metadata → notification frame, everything else intact
# ---------------------------------------------------------------------------


class _FakeWS:
    """Minimal stand-in for an aiohttp WebSocket response."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed = False

    async def send_str(self, data: str) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        self.closed = True

    def frame(self, index: int = 0) -> dict:
        return json.loads(self.sent[index])


@pytest.fixture
def dash_channel():
    from sarathy.channels.dashboard.server import DashboardChannel

    ch = DashboardChannel.__new__(DashboardChannel)
    ch._ws_clients = []
    return ch


@pytest.mark.asyncio
async def test_dashboard_send_emits_a_notification_frame(dash_channel):
    ws = _FakeWS()
    dash_channel._ws_clients = [ws]

    await dash_channel.send(
        OutboundMessage(
            channel="dashboard", chat_id="console", content="[job 125 completed] done",
            metadata={"notify": True, "tab": "jobs", "notify_title": "Sarathy update"},
        )
    )

    assert len(ws.sent) == 1
    frame = ws.frame()
    assert frame["type"] == "notification"
    # Contract is unchanged: title/body/tab/timestamp only.
    assert set(frame["payload"]) == {"title", "body", "tab", "timestamp"}
    assert frame["payload"]["title"] == "Sarathy update"
    assert frame["payload"]["body"] == "[job 125 completed] done"
    assert frame["payload"]["tab"] == "jobs"
    assert "chatId" not in frame and "content" not in frame


@pytest.mark.asyncio
async def test_dashboard_send_without_notify_is_unchanged(dash_channel):
    ws = _FakeWS()
    dash_channel._ws_clients = [ws]

    await dash_channel.send(
        OutboundMessage(channel="dashboard", chat_id="console", content="streamed!")
    )

    frame = ws.frame()
    assert frame["type"] == "message"
    assert frame["content"] == "streamed!"
    assert frame["metadata"] == {}


@pytest.mark.asyncio
async def test_dashboard_send_fans_out_to_every_client(dash_channel):
    ws1, ws2 = _FakeWS(), _FakeWS()
    dash_channel._ws_clients = [ws1, ws2]

    await dash_channel.send(
        OutboundMessage(
            channel="dashboard", chat_id="console", content="relay",
            metadata={"notify": True, "tab": "jobs"},
        )
    )

    assert ws1.frame()["type"] == "notification"
    assert ws2.frame()["type"] == "notification"


def test_notification_parts_caps_a_runaway_body():
    from sarathy.channels.dashboard.server import notification_parts

    title, body = notification_parts("x" * 5000, {"notify_title": "Sarathy"})
    assert title == "Sarathy"
    assert len(body) < 5000
    assert body.endswith("…")

    # No title supplied → a sane default, never empty.
    assert notification_parts("hi", {})[0] == "Sarathy"

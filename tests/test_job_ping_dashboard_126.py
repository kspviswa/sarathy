"""Spec 126 §C(a) — job pings reach the dashboard surface, not just Telegram.

``jobctl`` builds one ping per event and delivers it twice: directly to Telegram
(via ``send_tg``) and, on the event row as ``notify_html``, through the backend
channel to the dashboard. Before this, the dashboard had no copy of the ping at
all — and because it rendered markdown only, the Telegram HTML would have shown
as literal ``<b>`` text anyway.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

from sarathy.channels.backend import BackendChannel
from sarathy.config.schema import BackendConfig
from sarathy.bus.queue import MessageBus

JOBCTL = Path("/home/kspviswa/.sarathy/workspace/scripts/jobctl.py")

PING_HTML = (
    "<b>Job 126 [feature]</b> — completed\n"
    "All tests green.\n\n"
    '<a href="https://skandpriya.com/dashboard/#/jobs/126">Open in dashboard</a>'
)


def _channel(tmp_path) -> BackendChannel:
    return BackendChannel(
        BackendConfig(enabled=True, token="t", port=0),
        MessageBus(),
        watermark_path=tmp_path / "wm.json",
        poll_interval=0.05,
    )


def _event(tmp_path, payload=None, event_type="completed") -> dict:
    return {
        "id": 1,
        "job_id": 126,
        "ts": "2026-10-10T00:00:00Z",
        "event_type": event_type,
        "level": "action",
        "message": "All tests green.",
        "payload": payload if payload is not None else {},
    }


# ---------------------------------------------------------------------------
# _event_ping — extracting the ping off an event row
# ---------------------------------------------------------------------------


class TestEventPingExtraction:
    def test_returns_title_and_html(self, tmp_path):
        ch = _channel(tmp_path)
        ping = ch._event_ping(
            _event(tmp_path, {"notify_html": PING_HTML, "notify_title": "Job 126 · completed"})
        )
        assert ping == ("Job 126 · completed", PING_HTML)

    def test_title_falls_back_to_job_id(self, tmp_path):
        ch = _channel(tmp_path)
        assert ch._event_ping(_event(tmp_path, {"notify_html": PING_HTML}))[0] == "Job 126"

    def test_event_without_notify_html_yields_none(self, tmp_path):
        ch = _channel(tmp_path)
        assert ch._event_ping(_event(tmp_path, {"escalate_to": ["telegram:1"]})) is None

    def test_blank_notify_html_yields_none(self, tmp_path):
        ch = _channel(tmp_path)
        assert ch._event_ping(_event(tmp_path, {"notify_html": "   "})) is None

    def test_non_dict_payload_yields_none(self, tmp_path):
        ch = _channel(tmp_path)
        assert ch._event_ping(_event(tmp_path, ["not", "a", "dict"])) is None

    def test_json_encoded_payload_is_parsed(self, tmp_path):
        """jobctl stores the payload as a JSON string in the DB column."""
        ch = _channel(tmp_path)
        event = _event(tmp_path)
        event["payload"] = json.dumps({"notify_html": PING_HTML, "notify_title": "T"})
        assert ch._event_ping(event) == ("T", PING_HTML)


# ---------------------------------------------------------------------------
# _publish_event_ping — routing it to the dashboard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestPublishEventPing:
    async def test_ping_reaches_the_dashboard_as_a_notification(self, tmp_path):
        ch = _channel(tmp_path)
        payload = {
            "notify_html": PING_HTML,
            "notify_title": "Job 126 · completed",
            "escalate_to": ["telegram:5878545507", "dashboard:console"],
        }
        await ch._publish_event_ping(_event(tmp_path, payload))

        assert ch.bus.outbound_size == 1
        out = await ch.bus.consume_outbound()
        assert (out.channel, out.chat_id) == ("dashboard", "console")
        assert out.content == PING_HTML
        assert out.metadata["notify"] is True
        assert out.metadata["tab"] == "jobs"
        assert out.metadata["notify_title"] == "Job 126 · completed"

    async def test_telegram_is_never_double_pinged(self, tmp_path):
        """jobctl already sends this ping to TG via send_tg(); escalating it
        again here would duplicate every job event (the job 116 flood)."""
        ch = _channel(tmp_path)
        payload = {
            "notify_html": PING_HTML,
            "escalate_to": ["telegram:5878545507", "dashboard:console"],
        }
        await ch._publish_event_ping(_event(tmp_path, payload))

        out = await ch.bus.consume_outbound()
        assert out.channel == "dashboard"
        assert ch.bus.outbound_size == 0

    async def test_falls_back_to_the_dashboard_when_escalate_is_telegram_only(
        self, tmp_path
    ):
        ch = _channel(tmp_path)
        payload = {"notify_html": PING_HTML, "escalate_to": ["telegram:5878545507"]}
        await ch._publish_event_ping(_event(tmp_path, payload))

        out = await ch.bus.consume_outbound()
        assert (out.channel, out.chat_id) == ("dashboard", "console")

    async def test_event_without_a_ping_publishes_nothing(self, tmp_path):
        ch = _channel(tmp_path)
        await ch._publish_event_ping(_event(tmp_path, {"escalate_to": ["dashboard:console"]}))
        assert ch.bus.outbound_size == 0

    async def test_completed_events_ping_even_though_they_do_not_wake_the_agent(
        self, tmp_path
    ):
        """`completed` is not in the default tail_event_types, so the tailer
        ignores it for agent wakes. The dashboard ping must still fire — a
        notification is not gated on whether an LLM turn is worth running."""
        ch = _channel(tmp_path)
        assert ch.config.tail_event_types  # sanity: the default filter exists
        assert "completed" not in ch.config.tail_event_types

        await ch._publish_event_ping(
            _event(tmp_path, {"notify_html": PING_HTML}, event_type="completed")
        )
        assert ch.bus.outbound_size == 1

        # ...and the agent-wake path still filters it out.
        assert ch._tail_event_to_inbound(
            _event(tmp_path, {"notify_html": PING_HTML}, event_type="completed")
        ) is None


# ---------------------------------------------------------------------------
# End-to-end through a real jobs.db, as the tailer reads it
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestTailerDeliversPing:
    async def test_ping_from_a_real_job_event_row_reaches_the_dashboard(
        self, tmp_path, monkeypatch
    ):
        db = tmp_path / "jobs.db"
        conn = sqlite3.connect(db)
        conn.execute(
            "CREATE TABLE jobs (id INTEGER PRIMARY KEY, source_session TEXT)"
        )
        conn.execute(
            "CREATE TABLE job_events (id INTEGER PRIMARY KEY, job_id INTEGER, ts TEXT,"
            " event_type TEXT, level TEXT, message TEXT, payload TEXT)"
        )
        conn.execute(
            "INSERT INTO jobs (id, source_session) VALUES (126, 'telegram:5878545507')"
        )
        conn.execute(
            "INSERT INTO job_events (job_id, ts, event_type, level, message, payload)"
            " VALUES (126, '2026-10-10T00:00:00Z', 'completed', 'action', ?, ?)",
            (
                "All tests green.",
                json.dumps(
                    {
                        "notify_html": PING_HTML,
                        "notify_title": "Job 126 · completed",
                        "escalate_to": ["telegram:5878545507", "dashboard:console"],
                        "source_session_id": "5878545507",
                    }
                ),
            ),
        )
        conn.commit()
        conn.close()

        ch = BackendChannel(
            BackendConfig(enabled=True, token="t", port=0, jobs_db_path=str(db)),
            MessageBus(),
            watermark_path=tmp_path / "wm.json",
            poll_interval=0.05,
        )
        monkeypatch.setattr(type(ch), "_jobs_db", lambda self: db)

        ch._watermark = 0  # as if the tailer had never seen this db
        events = ch._poll_new_events()
        assert len(events) == 1

        for event in events:
            await ch._publish_event_ping(event)

        out = await ch.bus.consume_outbound()
        assert (out.channel, out.chat_id) == ("dashboard", "console")
        assert out.content == PING_HTML
        assert out.metadata["notify"] is True


# ---------------------------------------------------------------------------
# jobctl emits a ping both surfaces can use
# ---------------------------------------------------------------------------


class TestJobctlPingShape:
    def _jobctl(self):
        if not JOBCTL.is_file():
            pytest.skip(f"jobctl not present at {JOBCTL}")
        import importlib.util

        spec = importlib.util.spec_from_file_location("jobctl126", JOBCTL)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_stays_stdlib_only(self):
        """The script must keep running without the package on sys.path."""
        src = JOBCTL.read_text()
        assert "import sarathy" not in src
        assert "from sarathy" not in src

    def test_builds_bold_header_and_anchor(self):
        mod = self._jobctl()
        html = mod.build_ping_html(126, "feature", "completed", "All tests green.")
        assert html.startswith("<b>Job 126 [feature]</b> — completed")
        assert '<a href="https://skandpriya.com/dashboard/#/jobs/126">' in html
        assert html.endswith("</a>")

    def test_escapes_angle_brackets_and_ampersands(self):
        """Telegram's HTML parse mode rejects a raw `<` in message text."""
        mod = self._jobctl()
        html = mod.build_ping_html(7, "fix", "crash", "a < b && c > d")
        assert "a &lt; b &amp;&amp; c &gt; d" in html
        # No unescaped tag other than the ones we emit.
        import re as _re

        tags = set(_re.findall(r"<(/?[a-z]+)[ >]", html))
        assert tags <= {"b", "a", "/b", "/a"}

    def test_ping_payload_carries_title_and_link(self):
        mod = self._jobctl()
        p = mod.ping_payload(126, "feature", "completed", "done")
        assert set(p) == {"notify_html", "notify_title", "job_link"}
        assert p["notify_title"] == "Job 126 · completed"
        assert p["job_link"].endswith("/#/jobs/126")

    def test_action_and_notify_emit_notify_html(self):
        """All three delivery sites attach the ping to the event row.

        Call sites: ``cmd_notify``, the monitor's ``action()``, and the
        monitor-start health heartbeat.
        """
        src = JOBCTL.read_text()
        assert src.count("ping_payload(") == 4, (
            "expected build/ping call sites: ping_payload() definition + "
            "cmd_notify + monitor action() + monitor-start note"
        )
        # And every one of them hands it to emit(), not just Telegram.
        assert src.count("emit(") >= 3
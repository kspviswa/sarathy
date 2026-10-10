"""Spec 124 — transcript durability + dual-channel restart notify.

Covers:
  * A: the ``/restart`` turn is persisted BEFORE the process is killed.
  * C: the restart flag is a LIST of targets, fanned out on boot, with the
    legacy single-target shape still honored.
  * C5: the backend channel's ``escalate_to`` accepts a list and still defaults
    to the Telegram live chat when unset (KB #391).
"""

from __future__ import annotations

import json

import pytest

from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.core.notify import (
    TG_LIVE_CHAT_ID,
    build_restart_flag,
    default_notify_targets,
    normalize_targets,
    read_restart_targets,
    targets_from_escalate,
)


def _config_for_status():
    """Minimal config object for `build_restart_status`."""
    from unittest.mock import MagicMock

    config = MagicMock()
    config.agents.defaults.model = "test-model"
    config.get_provider_name.return_value = "ollama"
    config.providers = {}
    config.tools.web.search.enabled = False
    return config


async def _drain(bus: MessageBus, expected: int, timeout: float = 2.0) -> list[OutboundMessage]:
    out: list[OutboundMessage] = []
    for _ in range(expected):
        out.append(await bus.consume_outbound())
    return out


# ---------------------------------------------------------------------------
# normalize_targets — every accepted shape
# ---------------------------------------------------------------------------


class TestNormalizeTargets:
    def test_none_is_empty(self):
        assert normalize_targets(None) == []

    def test_legacy_single_string(self):
        assert normalize_targets("telegram:123") == [("telegram", "123")]

    def test_legacy_single_dict(self):
        assert normalize_targets({"channel": "telegram", "chat_id": "123"}) == [
            ("telegram", "123")
        ]

    def test_wrapper_dict_with_targets(self):
        assert normalize_targets(
            {"targets": [{"channel": "telegram", "chat_id": "1"},
                         {"channel": "dashboard", "chat_id": "console"}]}
        ) == [("telegram", "1"), ("dashboard", "console")]

    def test_list_of_strings_and_dicts(self):
        assert normalize_targets(
            ["telegram:1", {"channel": "dashboard", "chat_id": "console"}]
        ) == [("telegram", "1"), ("dashboard", "console")]

    def test_dedupes_and_preserves_order(self):
        assert normalize_targets(
            ["dashboard:console", "telegram:1", "dashboard:console"]
        ) == [("dashboard", "console"), ("telegram", "1")]

    def test_drops_unusable_entries_without_raising(self):
        assert normalize_targets([None, "", {}, 42, "telegram:1"]) == [("telegram", "1")]


class TestDefaultTargets:
    def test_fans_out_to_telegram_and_dashboard(self):
        assert default_notify_targets() == [
            ("telegram", TG_LIVE_CHAT_ID),
            ("dashboard", "console"),
        ]

    def test_origin_is_prepended_and_deduped(self):
        assert default_notify_targets(("dashboard", "console")) == [
            ("dashboard", "console"),
            ("telegram", TG_LIVE_CHAT_ID),
        ]

    def test_telegram_origin_is_not_duplicated(self):
        assert default_notify_targets(("telegram", TG_LIVE_CHAT_ID)) == [
            ("telegram", TG_LIVE_CHAT_ID),
            ("dashboard", "console"),
        ]

    def test_cli_origin_is_kept(self):
        assert default_notify_targets(("cli", "direct")) == [
            ("cli", "direct"),
            ("telegram", TG_LIVE_CHAT_ID),
            ("dashboard", "console"),
        ]


class TestBuildRestartFlag:
    def test_flag_carries_both_targets(self):
        flag = build_restart_flag("dashboard", "console")
        pairs = [(t["channel"], t["chat_id"]) for t in flag["targets"]]
        assert ("dashboard", "console") in pairs
        assert ("telegram", TG_LIVE_CHAT_ID) in pairs
        assert len(pairs) == 2

    def test_flag_keeps_legacy_keys_for_old_gateways(self):
        flag = build_restart_flag("discord", "chan", sender_id="u1")
        assert flag["channel"] == "discord"
        assert flag["chat_id"] == "chan"
        assert flag["sender_id"] == "u1"

    def test_flag_from_cli_also_pings_both(self):
        flag = build_restart_flag("cli", "direct")
        pairs = [(t["channel"], t["chat_id"]) for t in flag["targets"]]
        assert pairs[0] == ("cli", "direct")
        assert ("telegram", TG_LIVE_CHAT_ID) in pairs
        assert ("dashboard", "console") in pairs


# ---------------------------------------------------------------------------
# C1/C2 — the boot-time fan-out
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestPublishRestartStatus:
    async def test_list_targets_publishes_to_everyone(self, tmp_path):
        """The reported bug: a redeploy pinged Telegram only. Both must fire."""
        from sarathy.gateway.run import publish_restart_status

        flag = tmp_path / "restart_pending.json"
        flag.write_text(
            json.dumps({
                "targets": [
                    {"channel": "telegram", "chat_id": TG_LIVE_CHAT_ID},
                    {"channel": "dashboard", "chat_id": "console"},
                ]
            })
        )

        bus = MessageBus()
        await publish_restart_status(bus, _config_for_status(), flag_path=flag)

        assert bus.outbound_size == 2
        msgs = await _drain(bus, 2)
        pairs = sorted((m.channel, m.chat_id) for m in msgs)
        assert pairs == [("dashboard", "console"), ("telegram", TG_LIVE_CHAT_ID)]
        # Every target gets the same boot status.
        assert len({m.content for m in msgs}) == 1
        assert "Gateway restarted successfully" in msgs[0].content

    async def test_legacy_single_target_still_works(self, tmp_path):
        from sarathy.gateway.run import publish_restart_status

        flag = tmp_path / "restart_pending.json"
        flag.write_text(json.dumps({"channel": "telegram", "chat_id": "42"}))

        bus = MessageBus()
        await publish_restart_status(bus, _config_for_status(), flag_path=flag)

        msgs = await _drain(bus, 1)
        assert (msgs[0].channel, msgs[0].chat_id) == ("telegram", "42")

    async def test_flag_is_consumed_after_publish(self, tmp_path):
        from sarathy.gateway.run import publish_restart_status

        flag = tmp_path / "restart_pending.json"
        flag.write_text(
            json.dumps({"targets": ["telegram:1", "dashboard:console"]})
        )

        bus = MessageBus()
        await publish_restart_status(bus, _config_for_status(), flag_path=flag)
        assert not flag.exists()

    async def test_missing_flag_is_a_noop(self, tmp_path):
        from sarathy.gateway.run import publish_restart_status

        bus = MessageBus()
        await publish_restart_status(
            bus, _config_for_status(), flag_path=tmp_path / "nope.json"
        )
        assert bus.outbound_size == 0

    async def test_one_failing_target_does_not_swallow_the_others(self, tmp_path):
        from sarathy.gateway.run import publish_restart_status

        flag = tmp_path / "restart_pending.json"
        flag.write_text(
            json.dumps({"targets": ["telegram:1", "dashboard:console"]})
        )

        bus = MessageBus()
        real_publish = bus.publish_outbound
        calls: list[tuple[str, str]] = []

        async def flaky(msg: OutboundMessage):
            calls.append((msg.channel, msg.chat_id))
            if msg.channel == "telegram":
                raise RuntimeError("telegram down")
            return await real_publish(msg)

        bus.publish_outbound = flaky  # type: ignore[method-assign]
        await publish_restart_status(bus, _config_for_status(), flag_path=flag)

        assert sorted(calls) == [("dashboard", "console"), ("telegram", "1")]
        assert bus.outbound_size == 1

    async def test_corrupt_flag_is_consumed_not_replayed(self, tmp_path):
        from sarathy.gateway.run import publish_restart_status

        flag = tmp_path / "restart_pending.json"
        flag.write_text("{not json")

        bus = MessageBus()
        await publish_restart_status(bus, _config_for_status(), flag_path=flag)
        assert bus.outbound_size == 0
        assert not flag.exists()


def test_read_restart_targets_falls_back_to_cli():
    assert read_restart_targets({"unrecognizable": True}) == [("cli", "direct")]

# ---------------------------------------------------------------------------
# A1/A2 — the /restart turn must be durable BEFORE the process dies
# ---------------------------------------------------------------------------


def _restart_agent_loop(tmp_path, monkeypatch, channel="dashboard", chat_id="console"):
    """Wire a minimal AgentLoop + SessionManager, with Popen and the data dir
    redirected so a test can drive /restart without touching the real gateway."""
    import subprocess

    from sarathy.agent.loop import AgentLoop
    from sarathy.session.manager import SessionManager
    from tests.conftest import make_test_config

    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    monkeypatch.setattr("sarathy.utils.helpers.get_data_path", lambda: data_dir)
    # `_handle_restart_command` does a function-local `import subprocess`, so
    # the module object itself is what has to be patched.
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: None)

    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    sessions = SessionManager(config=make_test_config(workspace), workspace=workspace)

    bus = MessageBus()
    loop = AgentLoop.__new__(AgentLoop)
    loop.bus = bus
    loop.sessions = sessions
    return loop, sessions, bus, data_dir


def _restart_msg(channel="dashboard", chat_id="console"):
    return InboundMessage(
        channel=channel,
        sender_id="viswa",
        chat_id=chat_id,
        content="/restart",
        metadata={},
    )


@pytest.mark.asyncio
class TestRestartCommandDurability:
    async def test_turn_is_persisted_to_the_session_file(self, tmp_path, monkeypatch):
        """A restart mid-turn must not drop the "/restart" ask or its ack."""
        from sarathy.agent.loop import AgentLoop

        loop, sessions, _bus, _data = _restart_agent_loop(tmp_path, monkeypatch)
        session = sessions.get_or_create("dashboard:console")

        await AgentLoop._handle_restart_command(loop, session, _restart_msg())

        # Read back from disk: this is exactly what the dashboard loads after
        # the old process was killed.
        reloaded = sessions.read_session("dashboard:console")
        assert reloaded is not None
        assert [m.get("role") for m in reloaded.messages[-2:]] == ["user", "assistant"]
        assert reloaded.messages[-2]["content"] == "/restart"
        assert "restart requested" in reloaded.messages[-1]["content"]

        # Timestamps are present (schema unchanged, no new fields invented).
        assert reloaded.messages[-2].get("timestamp")
        assert reloaded.messages[-1].get("timestamp")

    async def test_ack_is_also_published_outbound(self, tmp_path, monkeypatch):
        from sarathy.agent.loop import AgentLoop

        loop, sessions, bus, _data = _restart_agent_loop(tmp_path, monkeypatch)
        result = await AgentLoop._handle_restart_command(
            loop, sessions.get_or_create("dashboard:console"), _restart_msg()
        )
        assert result is None

        out = await bus.consume_outbound()
        assert (out.channel, out.chat_id) == ("dashboard", "console")
        assert "restart requested" in out.content

    async def test_flag_lists_telegram_and_dashboard(self, tmp_path, monkeypatch):
        from sarathy.agent.loop import AgentLoop

        loop, sessions, _bus, data_dir = _restart_agent_loop(tmp_path, monkeypatch)
        await AgentLoop._handle_restart_command(
            loop, sessions.get_or_create("dashboard:console"), _restart_msg()
        )

        flag = json.loads((data_dir / "restart_pending.json").read_text())
        pairs = [(t["channel"], t["chat_id"]) for t in flag["targets"]]
        assert ("dashboard", "console") in pairs
        assert ("telegram", TG_LIVE_CHAT_ID) in pairs
        assert len(pairs) == 2

    async def test_originating_channel_is_kept_and_pinged_too(self, tmp_path, monkeypatch):
        from sarathy.agent.loop import AgentLoop

        loop, sessions, _bus, data_dir = _restart_agent_loop(tmp_path, monkeypatch)
        await AgentLoop._handle_restart_command(
            loop,
            sessions.get_or_create("discord:chan"),
            _restart_msg("discord", "chan"),
        )

        flag = json.loads((data_dir / "restart_pending.json").read_text())
        pairs = [(t["channel"], t["chat_id"]) for t in flag["targets"]]
        assert pairs[0] == ("discord", "chan")
        assert ("telegram", TG_LIVE_CHAT_ID) in pairs
        assert ("dashboard", "console") in pairs

    async def test_a_save_failure_does_not_block_the_restart(self, tmp_path, monkeypatch):
        """Persistence is best-effort: the user's ask was to restart, and a
        broken session store must not turn /restart into a no-op."""
        from sarathy.agent.loop import AgentLoop

        loop, sessions, bus, data_dir = _restart_agent_loop(tmp_path, monkeypatch)

        def boom(_session):
            raise RuntimeError("disk full")

        monkeypatch.setattr(sessions, "save", boom)

        assert await AgentLoop._handle_restart_command(
            loop, sessions.get_or_create("dashboard:console"), _restart_msg()
        ) is None
        # The flag was still written and the ack still published.
        assert (data_dir / "restart_pending.json").exists()
        out = await bus.consume_outbound()
        assert "restart requested" in out.content


# ---------------------------------------------------------------------------
# C5 — backend escalate_to list fan-out, telegram default preserved
# ---------------------------------------------------------------------------


class TestEscalateTargets:
    def test_unset_defaults_to_telegram_live(self):
        assert targets_from_escalate(None) == [("telegram", TG_LIVE_CHAT_ID)]
        assert targets_from_escalate("") == [("telegram", TG_LIVE_CHAT_ID)]

    def test_single_string_unchanged(self):
        assert targets_from_escalate("telegram:9876543210") == [
            ("telegram", "9876543210")
        ]

    def test_list_fans_out(self):
        assert targets_from_escalate(["telegram:1", "dashboard:console"]) == [
            ("telegram", "1"),
            ("dashboard", "console"),
        ]

    def test_list_of_dicts_fans_out(self):
        assert targets_from_escalate(
            [{"channel": "telegram", "chat_id": "1"},
             {"channel": "dashboard", "chat_id": "console"}]
        ) == [("telegram", "1"), ("dashboard", "console")]

    def test_live_chat_id_is_never_the_stale_one(self):
        assert TG_LIVE_CHAT_ID == "5878545507"
        assert TG_LIVE_CHAT_ID != "8281248569"


def test_backend_module_still_exports_live_chat_id():
    import sarathy.channels.backend as backend

    # The constant moved to sarathy.core.notify but the backend module keeps
    # re-exporting it, so existing importers do not break.
    assert backend.TG_LIVE_CHAT_ID == TG_LIVE_CHAT_ID


@pytest.mark.asyncio
class TestBackendEscalationFanOut:
    def _channel(self, tmp_path):
        from sarathy.channels.backend import BackendChannel
        from sarathy.config.schema import BackendConfig

        return BackendChannel(
            BackendConfig(enabled=True, token="t", port=0),
            MessageBus(),
            watermark_path=tmp_path / "wm.json",
            poll_interval=0.05,
        )

    async def test_send_fans_out_to_every_list_target(self, tmp_path):
        ch = self._channel(tmp_path)
        await ch.send(
            OutboundMessage(
                channel="backend",
                chat_id="7",
                content="job finished",
                metadata={"escalate_to": ["telegram:1", "dashboard:console"]},
            )
        )
        assert ch.bus.outbound_size == 2
        pairs = set()
        for _ in range(2):
            m = await ch.bus.consume_outbound()
            pairs.add((m.channel, m.chat_id))
        assert pairs == {("telegram", "1"), ("dashboard", "console")}

    async def test_send_without_escalate_stays_silent(self, tmp_path):
        ch = self._channel(tmp_path)
        await ch.send(OutboundMessage(channel="backend", chat_id="7", content="quiet"))
        assert ch.bus.outbound_size == 0

    async def test_trigger_ack_fans_out_to_every_list_target(self, tmp_path):
        ch = self._channel(tmp_path)
        await ch._publish_trigger_ack(
            InboundMessage(
                channel="backend",
                sender_id="job-7",
                chat_id="7",
                content="[job 7 crash] boom",
                metadata={"escalate_to": ["telegram:1", "dashboard:console"]},
            )
        )
        assert ch.bus.outbound_size == 2
        pairs = set()
        for _ in range(2):
            m = await ch.bus.consume_outbound()
            pairs.add((m.channel, m.chat_id))
        assert pairs == {("telegram", "1"), ("dashboard", "console")}

    async def test_trigger_ack_defaults_to_telegram_live(self, tmp_path):
        ch = self._channel(tmp_path)
        await ch._publish_trigger_ack(
            InboundMessage(
                channel="backend",
                sender_id="job-8",
                chat_id="8",
                content="[job 8 crash] boom",
                metadata={},
            )
        )
        m = await ch.bus.consume_outbound()
        assert (m.channel, m.chat_id) == ("telegram", TG_LIVE_CHAT_ID)

    async def test_resolve_helper_keeps_send_silent_on_unset(self, tmp_path):
        from sarathy.channels.backend import resolve_escalate_targets

        assert resolve_escalate_targets(None, fallback_to_live=False) == []
        assert resolve_escalate_targets(None) == [("telegram", TG_LIVE_CHAT_ID)]

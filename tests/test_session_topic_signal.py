"""Tests for Session Topics: LLM piggyback signal, rules, footer, /topic (job 114)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from sarathy.agent.loop import (
    apply_topic_signal,
    strip_topic_marker,
)
from sarathy.bus.events import InboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.config.schema import Config
from sarathy.providers.base import LLMResponse
from sarathy.session.manager import SessionManager

# ---------------------------------------------------------------------------
# marker extraction / stripping
# ---------------------------------------------------------------------------


def test_strip_present():
    content = 'Here is your answer.\n<topic>{"set": "pi durable research"}</topic>'
    cleaned, raw = strip_topic_marker(content)
    assert cleaned == "Here is your answer."
    assert raw == '{"set": "pi durable research"}'


def test_strip_tolerates_trailing_newline():
    content = "Hi there\n<topic>{\"set\": null}</topic>\n\n"
    cleaned, raw = strip_topic_marker(content)
    assert cleaned == "Hi there"
    assert raw == '{"set": null}'


def test_strip_absent():
    content = "Just a normal reply."
    cleaned, raw = strip_topic_marker(content)
    assert cleaned == content
    assert raw is None


def test_strip_only_matches_trailing_marker():
    # A marker buried mid-text is not a signal; leave the content alone.
    content = '<topic>{"set": "x"}</topic>\nSome more visible text.'
    cleaned, raw = strip_topic_marker(content)
    assert raw is None
    assert cleaned == content


def test_strip_does_not_span_earlier_literal_marker():
    # KB #457: a literal example marker earlier in the reply must NOT make the
    # strip run from it all the way to the trailing marker (which truncated the
    # whole reply). Only the genuine trailing marker is removed.
    content = (
        'The machine line looks like <topic>{"set": "x"}</topic> in prose.\n'
        "More visible text follows.\n\n"
        '<topic>{"set": "real topic"}</topic>'
    )
    cleaned, raw = strip_topic_marker(content)
    assert raw == '{"set": "real topic"}'
    assert cleaned == (
        'The machine line looks like <topic>{"set": "x"}</topic> in prose.\n'
        "More visible text follows."
    )


def test_strip_handles_backticked_example_marker():
    # The exact 2026-10-10 truncation shape: an inline code example marker.
    content = (
        'ReactMarkdown renders `<topic>{"set": "x"}</topic>` literally.\n\n'
        "The rest of the answer survives.\n\n"
        '<topic>{"set": "topic marker leak"}</topic>'
    )
    cleaned, raw = strip_topic_marker(content)
    assert raw == '{"set": "topic marker leak"}'
    assert cleaned.endswith("The rest of the answer survives.")
    assert '`<topic>{"set": "x"}</topic>`' in cleaned



# ---------------------------------------------------------------------------
# rules
# ---------------------------------------------------------------------------


def test_rule_null_no_change():
    meta: dict = {}
    assert apply_topic_signal(meta, '{"set": null}') == "none"
    assert meta == {}


def test_rule_new_topic_set():
    meta: dict = {}
    assert apply_topic_signal(meta, '{"set": "pi durable research"}') == "set"
    assert meta["topic"] == "pi durable research"


def test_rule_same_topic_noop():
    meta: dict = {"topic": "pi durable research"}
    assert apply_topic_signal(meta, '{"set": "pi durable research"}') == "none"
    assert meta["topic"] == "pi durable research"


def test_rule_case_insensitive_repeat_noop():
    meta: dict = {"topic": "Pi Durable Research"}
    assert apply_topic_signal(meta, '{"set": "pi durable research"}') == "none"


def test_rule_drift_merged_title_changed():
    meta: dict = {"topic": "pi durable research"}
    assert apply_topic_signal(meta, '{"set": "pi research plus dashboard"}') == "changed"
    assert meta["topic"] == "pi research plus dashboard"


def test_rule_user_locked_ignored():
    meta: dict = {"topic": "my locked topic", "topic_user_set": True}
    assert apply_topic_signal(meta, '{"set": "something else"}') == "none"
    assert meta["topic"] == "my locked topic"


def test_rule_malformed_json_ignored():
    meta: dict = {}
    assert apply_topic_signal(meta, "not json at all") == "none"
    assert meta == {}


def test_rule_missing_set_key_ignored():
    meta: dict = {}
    assert apply_topic_signal(meta, '{"title": "x"}') == "none"
    assert meta == {}


def test_rule_hard_cap_eight_words():
    meta: dict = {}
    long_title = "one two three four five six seven eight nine ten"
    assert apply_topic_signal(meta, f'{{"set": "{long_title}"}}') == "set"
    assert meta["topic"] == "one two three four five six seven eight"


def test_rule_none_raw_no_change():
    meta: dict = {"topic": "existing"}
    assert apply_topic_signal(meta, None) == "none"
    assert meta["topic"] == "existing"


# ---------------------------------------------------------------------------
# loop-level: footer + skip rules + /topic (harness mirrors test_steer_btw)
# ---------------------------------------------------------------------------


class FakeProvider:
    def __init__(self, responses):
        self.responses = [responses] if isinstance(responses, LLMResponse) else responses
        self.calls: list[dict] = []

    def get_default_model(self) -> str:
        return "test-model"

    async def chat(self, messages: list[dict] | None = None, **kwargs: Any) -> LLMResponse:
        self.calls.append({"messages": list(messages or []), **kwargs})
        return self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]


def _fake_add_assistant(messages, content, tool_calls=None, reasoning_content=None):
    messages.append({"role": "assistant", "content": content})
    return messages


def _fake_add_tool_result(messages, tool_id, name, result):
    messages.append({"role": "tool", "tool_call_id": tool_id, "name": name, "content": str(result)})
    return messages


def _make_loop(tmp_path, session_manager, provider):
    from sarathy.agent.loop import AgentLoop

    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    bus = MessageBus()
    with patch("sarathy.agent.loop.ContextBuilder"), patch(
        "sarathy.agent.loop.SubagentManager"
    ) as mock_submgr:
        mock_submgr.return_value.cancel_by_session = AsyncMock(return_value=0)
        loop = AgentLoop(
            bus=bus, provider=provider, workspace=workspace,
            model="test-model", session_manager=session_manager,
        )
    context = loop.context
    context.build_messages.return_value = [{"role": "user", "content": "hi"}]
    context.add_assistant_message.side_effect = _fake_add_assistant
    context.add_tool_result.side_effect = _fake_add_tool_result
    return loop, bus


def _user_msg(key: str, content: str) -> InboundMessage:
    channel, chat_id = key.split(":", 1)
    return InboundMessage(channel=channel, sender_id="u1", chat_id=chat_id, content=content)


@pytest.mark.asyncio
async def test_loop_strips_marker_sets_topic_and_footers_once(tmp_path):
    sm = SessionManager(Config(), workspace=tmp_path / "sessions")
    provider = FakeProvider(LLMResponse(content='Hello!\n<topic>{"set": "pi durable research"}</topic>'))
    loop, _ = _make_loop(tmp_path, sm, provider)

    out = await loop._process_message_inner(_user_msg("test:c1", "hi"))
    assert out is not None
    assert "<topic>" not in out.content
    assert out.content == "Hello!\n\n📌 pi durable research"
    assert sm.get_or_create("test:c1").metadata["topic"] == "pi durable research"


@pytest.mark.asyncio
async def test_loop_steady_turn_no_footer(tmp_path):
    sm = SessionManager(Config(), workspace=tmp_path / "sessions")
    provider = FakeProvider(
        [
            LLMResponse(content='Hi.\n<topic>{"set": "pi research"}</topic>'),
            LLMResponse(content='Sure.\n<topic>{"set": "pi research"}</topic>'),
        ]
    )
    loop, _ = _make_loop(tmp_path, sm, provider)

    first = await loop._process_message_inner(_user_msg("test:c1", "hi"))
    assert first is not None and first.content.endswith("📌 pi research")
    second = await loop._process_message_inner(_user_msg("test:c1", "ok"))
    assert second is not None
    assert "📌" not in second.content
    assert "<topic>" not in second.content


@pytest.mark.asyncio
async def test_loop_cron_and_backend_skip_topic_machinery(tmp_path):
    sm = SessionManager(Config(), workspace=tmp_path / "sessions")
    provider = FakeProvider(
        LLMResponse(content='Done.\n<topic>{"set": "cron topic"}</topic>')
    )
    loop, _ = _make_loop(tmp_path, sm, provider)

    out = await loop._process_message_inner(
        InboundMessage(channel="cli", sender_id="cron", chat_id="job1",
                       content="run", metadata={}),
        session_key="cron:job1",
    )
    assert out is not None
    assert "<topic>" not in out.content  # stripped for hygiene
    assert "📌" not in out.content  # ...but no topic machinery
    assert "topic" not in sm.get_or_create("cron:job1").metadata

    out2 = await loop._process_message_inner(
        InboundMessage(channel="backend", sender_id="jobctl", chat_id="42",
                       content="event", metadata={}),
    )
    assert out2 is not None
    assert "📌" not in out2.content
    assert "topic" not in sm.get_or_create("backend:42").metadata


@pytest.mark.asyncio
async def test_topic_command_set_show_lock_and_clear(tmp_path):
    sm = SessionManager(Config(), workspace=tmp_path / "sessions")
    loop, _ = _make_loop(tmp_path, sm, FakeProvider(LLMResponse(content="x")))

    shown = await loop._process_message_inner(_user_msg("test:c1", "/topic"))
    assert shown is not None and "No topic" in shown.content

    set_out = await loop._process_message_inner(_user_msg("test:c1", "/topic My Custom Thing"))
    assert set_out is not None and "My Custom Thing" in set_out.content
    meta = sm.get_or_create("test:c1").metadata
    assert meta["topic"] == "My Custom Thing"
    assert meta["topic_user_set"] is True

    # Lock persists and suppresses the LLM signal.
    assert apply_topic_signal(dict(meta), '{"set": "other"}') == "none"

    shown2 = await loop._process_message_inner(_user_msg("test:c1", "/topic"))
    assert shown2 is not None and "My Custom Thing" in shown2.content

    cleared = await loop._process_message_inner(_user_msg("test:c1", "/topic clear"))
    assert cleared is not None
    meta2 = sm.get_or_create("test:c1").metadata
    assert "topic" not in meta2
    assert meta2.get("topic_user_set") is False


@pytest.mark.asyncio
async def test_save_turn_strips_marker_from_persisted_history(tmp_path):
    # KB #456: the marker must never land on disk. The outbound copy is stripped
    # by _apply_topic_marker, but _save_turn persisted the RAW assistant message
    # (marker included), which then leaked into the dashboard/mobile history view.
    sm = SessionManager(Config(), workspace=tmp_path / "sessions")
    loop, _ = _make_loop(tmp_path, sm, FakeProvider(LLMResponse(content="x")))
    session = sm.get_or_create("test:c1")

    msgs = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": 'Answer here.\n<topic>{"set": "leaked"}</topic>'},
    ]
    loop._save_turn(session, msgs, 0)

    assistant = [m for m in session.messages if m.get("role") == "assistant"]
    assert assistant and assistant[-1]["content"] == "Answer here."
    assert all("<topic>" not in (m.get("content") or "") for m in session.messages)


def test_system_prompt_contains_topic_signal(tmp_path):
    from sarathy.agent.context import ContextBuilder

    builder = ContextBuilder(tmp_path / "ws")
    text = builder.build_system_prompt()
    assert "## Session Topic Signal" in text
    assert "<topic>" in text
    assert '{"set": null' in text

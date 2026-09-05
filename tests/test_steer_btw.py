"""Tests for /steer mid-turn injection and /btw concurrent side questions (job 65)."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sarathy.agent.loop import STEER_PROMPT_TEMPLATE
from sarathy.agent.tools.message import MessageTool
from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.config.schema import Config
from sarathy.providers.base import LLMResponse, ToolCallRequest
from sarathy.session.manager import SessionManager


def _noop_response(content: str = "done") -> LLMResponse:
    return LLMResponse(content=content)


def _tool_call_response(name: str = "read_file", arguments: dict | None = None) -> LLMResponse:
    return LLMResponse(
        content="calling tool",
        tool_calls=[ToolCallRequest(id="tc-1", name=name, arguments=arguments or {"path": "/tmp/x"})],
        finish_reason="tool_calls",
    )


def _fake_add_assistant(messages: list[dict], content: str | None,
                        tool_calls=None, reasoning_content: str | None = None) -> list[dict]:
    messages.append({"role": "assistant", "content": content})
    return messages


def _fake_add_tool_result(messages: list[dict], tool_id: str, name: str, result: Any) -> list[dict]:
    messages.append({"role": "tool", "tool_call_id": tool_id, "name": name, "content": str(result)})
    return messages


class FakeProvider:
    """Canned LLM provider. Responses returned in call order.

    Optionally blocks on an asyncio.Event for `block_first` calls so tests can
    observe a turn while it's paused mid-flight.
    """

    def __init__(self, responses, block_on: asyncio.Event | None = None, block_first: int = 0):
        self.responses = [responses] if isinstance(responses, LLMResponse) else responses
        self.calls: list[dict] = []
        self.block_on = block_on
        self.block_first = block_first

    def get_default_model(self) -> str:
        return "test-model"

    async def chat(self, messages: list[dict] | None = None, **kwargs: Any) -> LLMResponse:
        self.calls.append({"messages": list(messages or []), **kwargs})
        idx = len(self.calls) - 1
        if self.block_on is not None and idx < self.block_first:
            await self.block_on.wait()
        return self.responses[min(idx, len(self.responses) - 1)]


def _make_loop(tmp_path, session_manager: SessionManager, provider: FakeProvider, reviewer=None):
    """Build an AgentLoop with mocked ContextBuilder/SubagentManager (mirrors test_task_cancel)."""
    from sarathy.agent.loop import AgentLoop

    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    bus = MessageBus()
    with patch("sarathy.agent.loop.ContextBuilder"), \
         patch("sarathy.agent.loop.SubagentManager") as mock_submgr:
        mock_submgr.return_value.cancel_by_session = AsyncMock(return_value=0)
        loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=workspace,
            model="test-model",
            session_manager=session_manager,
            reviewer=reviewer,
        )
    context = loop.context
    context.build_messages.return_value = [{"role": "user", "content": "hi"}]
    context.add_assistant_message.side_effect = _fake_add_assistant
    context.add_tool_result.side_effect = _fake_add_tool_result
    context.get_history.return_value = []
    return loop, bus


def _make_session_manager(tmp_path) -> SessionManager:
    return SessionManager(Config(), workspace=tmp_path / "sessions")


def _user_msg(key: str = "test:c1", content: str = "hello") -> InboundMessage:
    channel, chat_id = key.split(":", 1)
    return InboundMessage(channel=channel, sender_id="u1", chat_id=chat_id, content=content)


async def _consume_final(bus: MessageBus, predicate) -> OutboundMessage | None:
    for _ in range(20):
        try:
            out = await asyncio.wait_for(bus.consume_outbound(), timeout=0.3)
        except asyncio.TimeoutError:
            return None
        if predicate(out):
            return out
    return None


# ---------------------------------------------------------------------------
# /steer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_steer_idle_prefix_stripped_and_dispatched(tmp_path):
    """Steering an idle session strips the prefix and runs the text normally."""
    sm = _make_session_manager(tmp_path)
    provider = FakeProvider([_noop_response("hi")])
    loop, _ = _make_loop(tmp_path, sm, provider)

    dispatched = []
    loop._spawn_dispatch = lambda msg: (dispatched.append(msg.content), msg)[1]

    await loop._handle_steer(_user_msg("test:c1", content="/steer actually say hi"))

    assert dispatched == ["actually say hi"]
    # No steer queue was created for an idle session.
    assert sm.get_or_create("test:c1").steer_queue is None


@pytest.mark.asyncio
async def test_steer_active_enqueues_and_acks(tmp_path):
    """Steering an active turn enqueues the text and acks rather than dispatching."""
    sm = _make_session_manager(tmp_path)
    provider = FakeProvider([_noop_response("hi")])
    loop, bus = _make_loop(tmp_path, sm, provider)

    loop._active_main_turns.add("test:c1")
    dispatched = []
    loop._spawn_dispatch = lambda msg: (dispatched.append(msg.content), msg)[1]

    await loop._handle_steer(_user_msg("test:c1", content="/steer change direction now"))

    assert dispatched == []
    session = sm.get_or_create("test:c1")
    assert session.steer_queue is not None
    queued = await asyncio.wait_for(session.steer_queue.get(), timeout=1.0)
    assert queued == "change direction now"
    out = await asyncio.wait_for(bus.consume_outbound(), timeout=1.0)
    assert "Steer noted" in out.content


@pytest.mark.asyncio
async def test_steer_injected_at_boundary(tmp_path):
    """A steer arriving mid-turn is injected right after the running tool call finishes."""
    sm = _make_session_manager(tmp_path)
    provider = FakeProvider(
        [_tool_call_response("read_file", {"path": "a"}), _noop_response("final after steer")]
    )
    loop, bus = _make_loop(tmp_path, sm, provider)
    loop.context.build_messages.return_value = [{"role": "user", "content": "summarize this"}]
    session = sm.get_or_create("test:c1")

    async def execute_with_steer(name: str, arguments: dict) -> str:
        # The steer arrives while the first tool call is still running.
        await session.steer_queue.put("please wrap in bullets")
        return "file contents"

    session.steer_queue = asyncio.Queue()
    loop.tools.execute = execute_with_steer

    result = await loop._process_message(_user_msg("test:c1", content="summarize this"))

    # Two model calls: pre-steer (no steer) and post-boundary (with steer).
    assert len(provider.calls) == 2
    first_user_contents = [m.get("content") for m in provider.calls[0]["messages"]]
    assert not any("please wrap in bullets" in str(c) for c in first_user_contents)

    second_user_contents = [m.get("content") for m in provider.calls[1]["messages"]]
    assert any(
        c == STEER_PROMPT_TEMPLATE.format(steer="please wrap in bullets")
        for c in second_user_contents
    )

    # The steer progress marker was emitted after the tool finished.
    steer_progress = await _consume_final(
        bus, lambda o: o.metadata.get("_progress") and "Steer injected" in o.content
    )
    assert steer_progress is not None

    assert result is not None
    assert "final after steer" in result.content


@pytest.mark.asyncio
async def test_steer_late_leftovers_trigger_followup(tmp_path):
    """Steers that arrive during final response generation spawn a follow-up turn."""
    sm = _make_session_manager(tmp_path)
    provider = FakeProvider([_noop_response("done")])
    loop, bus = _make_loop(tmp_path, sm, provider)

    session = sm.get_or_create("test:c1")
    session.steer_queue = asyncio.Queue()
    await session.steer_queue.put("late steer ask again")

    # Simulate final-generation already having happened (loop returns without
    # consuming the steer), so the leftover drain in _process_message takes over.
    loop._run_agent_loop = AsyncMock(return_value=("final answer", [], [], {"total_tokens": 0}))

    dispatched = []
    loop._spawn_dispatch = lambda msg: (dispatched.append(msg.content), msg)[1]

    result = await loop._process_message(_user_msg("test:c1", content="summarize this"))

    assert result is not None and result.content == "final answer"
    # Leftover steer was drained and dispatched as a follow-up normal turn.
    assert dispatched == ["late steer ask again"]
    assert session.steer_queue.empty()


@pytest.mark.asyncio
async def test_steer_usage_when_empty(tmp_path):
    sm = _make_session_manager(tmp_path)
    provider = FakeProvider([_noop_response("x")])
    loop, bus = _make_loop(tmp_path, sm, provider)
    await loop._handle_steer(_user_msg("test:c1", content="/steer"))
    out = await asyncio.wait_for(bus.consume_outbound(), timeout=1.0)
    assert "Usage: /steer" in out.content


# ---------------------------------------------------------------------------
# /btw
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_btw_concurrent_early_delivery(tmp_path):
    """A /btw turn runs concurrently and its answer arrives while the main turn is busy."""
    sm = _make_session_manager(tmp_path)

    main_block = asyncio.Event()
    provider = FakeProvider(
        [_noop_response("main answer"), _noop_response("side answer here")],
        block_on=main_block,
        block_first=1,
    )
    loop, bus = _make_loop(tmp_path, sm, provider)

    # Start the main turn and wait until its LLM call is mid-flight (blocked).
    main_msg = _user_msg("test:c1", content="long task")
    main_task = asyncio.create_task(loop._process_message(main_msg))
    while len(provider.calls) < 1:
        await asyncio.sleep(0)

    assert "test:c1" in loop._active_main_turns

    # Fire /btw while the main turn is still running.
    await loop._handle_btw(_user_msg("test:c1", content="/btw what is 2+2?"))

    ack = await asyncio.wait_for(bus.consume_outbound(), timeout=1.0)
    assert "BTW noted" in ack.content

    # The btw final is delivered even though the main turn is still blocked.
    btw_final = await _consume_final(
        bus, lambda o: o.metadata.get("_final") and o.metadata.get("_btw")
    )
    assert btw_final is not None
    assert btw_final.content == "side answer here"
    assert main_block.is_set() is False, "main turn should still be blocked"

    # The btw exchange was persisted into a dedicated side session.
    side_keys = [k for k in sm._cache if "##btw##" in k]
    assert side_keys, "expected a ##btw## side session"
    side = sm.get_or_create(side_keys[0])
    assert any("side answer here" in (m.get("content") or "") for m in side.messages)

    # Active btw marker is cleaned up once the side turn finishes.
    while "test:c1" in loop._active_btw_turns:
        await asyncio.sleep(0)

    # Main session history is untouched by the side turn.
    main_session = sm.get_or_create("test:c1")
    assert not any("side answer here" in (m.get("content") or "") for m in main_session.messages)

    # Release the main turn and confirm it completes normally.
    main_block.set()
    result = await main_task
    assert result is not None and "main answer" in result.content
    assert "test:c1" not in loop._active_main_turns


@pytest.mark.asyncio
async def test_btw_message_tool_state_restored(tmp_path):
    """The btw turn snapshots and restores MessageTool per-turn state."""
    sm = _make_session_manager(tmp_path)
    provider = FakeProvider(
        [_tool_call_response("message", {"content": "side note"}), _noop_response("side answer")]
    )
    loop, bus = _make_loop(tmp_path, sm, provider)

    mt: MessageTool = loop.tools.get("message")
    assert mt is not None
    mt.start_turn()
    mt.set_context("telegram", "main-chat", "main-msg")
    mt._turn_sends = [("email", "other")]
    mt._response_metadata = {"_verbose": True}

    saved = (
        mt._default_channel,
        mt._default_chat_id,
        mt._default_message_id,
        list(mt.get_turn_sends()),
        dict(mt._response_metadata),
    )

    await loop._run_btw_turn(_user_msg("test:c1", content="/btw hi"), "hi there")

    # MessageTool state was fully restored after the side turn.
    assert (mt._default_channel, mt._default_chat_id, mt._default_message_id) == saved[:3]
    assert list(mt.get_turn_sends()) == saved[3]
    assert mt._response_metadata == saved[4]

    # The side turn's message-tool send went out, then the final.
    side_send = await _consume_final(bus, lambda o: o.content == "side note")
    assert side_send is not None


@pytest.mark.asyncio
async def test_btw_usage_when_empty(tmp_path):
    sm = _make_session_manager(tmp_path)
    provider = FakeProvider([_noop_response("x")])
    loop, bus = _make_loop(tmp_path, sm, provider)
    await loop._handle_btw(_user_msg("test:c1", content="/btw"))
    out = await asyncio.wait_for(bus.consume_outbound(), timeout=1.0)
    assert "Usage: /btw" in out.content


# ---------------------------------------------------------------------------
# Reviewer busy counter (concurrent /btw racing the main turn)
# ---------------------------------------------------------------------------


def test_reviewer_busy_counter(tmp_path):
    from sarathy.session.review import BackgroundReviewer

    reviewer = BackgroundReviewer(provider=MagicMock(), workspace=tmp_path)

    assert reviewer._llm_busy_count == 0
    assert reviewer._llm_idle.is_set()

    # Two concurrent LLM calls (main + btw) both call mark_busy.
    reviewer.mark_busy()
    reviewer.mark_busy()
    assert reviewer._llm_busy_count == 2
    assert not reviewer._llm_idle.is_set()

    # One finishes -> still one active LLM call, reviewer stays gated.
    reviewer.mark_idle()
    assert reviewer._llm_busy_count == 1
    assert not reviewer._llm_idle.is_set()

    # Both finished -> reviewer can run.
    reviewer.mark_idle()
    assert reviewer._llm_busy_count == 0
    assert reviewer._llm_idle.is_set()

    # Extra mark_idle (imbalance) is guarded at zero.
    reviewer.mark_idle()
    assert reviewer._llm_busy_count == 0
    assert reviewer._llm_idle.is_set()


# ---------------------------------------------------------------------------
# Command registry + telegram draft bypass
# ---------------------------------------------------------------------------


def test_builtin_commands_include_steer_and_btw():
    from sarathy.agent.builtin_commands import BUILTIN_COMMANDS

    assert "steer" in BUILTIN_COMMANDS and not BUILTIN_COMMANDS["steer"].subcommands
    assert "btw" in BUILTIN_COMMANDS and not BUILTIN_COMMANDS["btw"].subcommands


@pytest.mark.asyncio
async def test_telegram_btw_draft_bypass():
    """A btw final is sent standalone and never finalizes the main turn's draft."""
    from sarathy.channels.telegram import TelegramChannel
    from sarathy.config.schema import TelegramConfig

    channel = TelegramChannel(TelegramConfig(), MessageBus())
    channel._app = MagicMock()
    channel._app.bot.send_message = AsyncMock(return_value=MagicMock())
    channel._app.bot.send_message_draft = AsyncMock(return_value=MagicMock())

    # Seed a main-turn draft so we can assert the btw final ignores it.
    channel._active_drafts[123] = 777

    # btw progress must not touch the per-chat streaming draft at all.
    await channel._send_progress(
        OutboundMessage(
            channel="telegram", chat_id="123", content="side working...",
            metadata={"_btw": True, "_progress": True},
        )
    )
    channel._app.bot.send_message_draft.assert_not_awaited()

    # btw final is delivered standalone; the main draft stays alive.
    await channel._send_final(
        OutboundMessage(
            channel="telegram", chat_id="123", content="side answer",
            metadata={"_btw": True, "_final": True},
        )
    )
    channel._app.bot.send_message.assert_awaited()
    assert channel._active_drafts[123] == 777

    # A normal (non-btw) final finalizes the draft.
    await channel._send_final(
        OutboundMessage(
            channel="telegram", chat_id="123", content="main answer",
            metadata={"_final": True},
        )
    )
    channel._app.bot.send_message.assert_awaited()
    assert channel._active_drafts.get(123) is None

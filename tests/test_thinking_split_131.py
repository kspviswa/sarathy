"""Spec 131 — reasoning never becomes the visible message.

Two reasoning sources reach Sarathy (131 §A):

  A. a dedicated delta field (``reasoning_content`` / ``reasoning`` / ``thinking``)
  B. inline ``<think>...</think>`` tags inside the normal ``content`` string

Both must be normalized at the provider boundary so that downstream ``content``
is ALWAYS visible prose. Before this fix the splitter did not exist (inline
blocks were never stripped), and ``AgentLoop._strip_think`` fell back to
``reasoning_content`` when content was empty — publishing the private monologue
as the assistant message while the same text also streamed into the collapse.

Covered here:
  §A  ThinkSplitter state machine + restored ``strip_think`` / ``_strip_think``
  §A  ``CustomProvider._stream_chat`` routing both sources to the right channel
  §B  reasoning + tool call publishes NO narration
  §C  genuine prose + tool call publishes a SEALED bubble; answer + memory-log
      tool call yields exactly two bubbles (never one per tool call)
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from sarathy.agent.loop import AgentLoop
from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.config.schema import Config
from sarathy.providers.base import LLMResponse, ToolCallRequest
from sarathy.providers.custom_provider import CustomProvider
from sarathy.providers.thinking import ThinkSplitter, strip_think
from sarathy.session.manager import SessionManager

# ---------------------------------------------------------------------------
# §A — the streaming think-splitter
# ---------------------------------------------------------------------------


def _split(chunks: list[str]) -> tuple[str, str]:
    """Run a chunk sequence through the splitter; return (visible, thinking)."""
    splitter = ThinkSplitter()
    visible, thinking = [], []
    for chunk in chunks:
        v, t = splitter.feed(chunk)
        visible.append(v)
        thinking.append(t)
    assert splitter.flush() == "", "a dangling partial tag must never be emitted"
    return "".join(visible), "".join(thinking)


def test_splitter_passes_through_content_without_tags() -> None:
    assert _split(["Hello ", "there", ", world"]) == ("Hello there, world", "")


def test_splitter_routes_inline_block_to_thinking() -> None:
    visible, thinking = _split(["<think>secret plan</think>The answer is 42"])
    assert visible == "The answer is 42"
    assert thinking == "secret plan"


def test_splitter_handles_tag_split_across_chunk_boundaries() -> None:
    # The exact case from the spec: open tag, prose, close tag, then a close tag
    # whose own characters arrive split across two more deltas.
    visible, thinking = _split(["<think>Le", " me", "</think>", "</thi", "nk>more"])
    assert visible == "more"
    assert thinking == "Le me"


def test_splitter_holds_back_a_split_open_tag() -> None:
    # `<think>` arrives as `<thi` + `nk>` — neither half may leak into the message.
    visible, thinking = _split(["<thi", "nk>hidden", "</think>", "shown"])
    assert visible == "shown"
    assert thinking == "hidden"


def test_splitter_never_emits_a_partial_tag_as_visible_text() -> None:
    # Stream ends mid-tag: the fragment is dropped, not shown.
    splitter = ThinkSplitter()
    visible, thinking = splitter.feed("answer then <thi")
    assert visible == "answer then "
    assert thinking == ""
    assert splitter.flush() == "<thi"


def test_splitter_unterminated_block_is_thinking_only() -> None:
    splitter = ThinkSplitter()
    visible, thinking = splitter.feed("<think>the model never closed it")
    assert visible == ""
    assert thinking == "the model never closed it"
    assert splitter.inside is True
    assert splitter.flush() == ""


def test_splitter_mixed_text_and_blocks_in_one_stream() -> None:
    visible, thinking = _split(
        ["before <think>a</think> middle <think>b</think> after"]
    )
    assert visible == "before  middle  after"
    assert thinking == "ab"


def test_splitter_swallows_a_stray_close_tag() -> None:
    assert _split(["done</think>"]) == ("done", "")


def test_splitter_empty_deltas_are_inert() -> None:
    splitter = ThinkSplitter()
    assert splitter.feed("") == ("", "")
    assert splitter.feed("ok") == ("ok", "")


# ---------------------------------------------------------------------------
# §A — strip_think / AgentLoop._strip_think
# ---------------------------------------------------------------------------


def test_strip_think_removes_inline_block() -> None:
    assert strip_think("<think>monologue</think>Hello there") == "Hello there"


def test_strip_think_think_only_is_none() -> None:
    assert strip_think("<think>only a monologue</think>") is None


def test_strip_think_none_and_empty_are_none() -> None:
    assert strip_think(None) is None
    assert strip_think("") is None
    assert strip_think("   ") is None


def test_strip_think_plain_text_passes_through() -> None:
    assert strip_think("no tags here") == "no tags here"


def test_strip_think_drops_unterminated_tail() -> None:
    assert strip_think("the answer <think>cut off here") == "the answer"


def test_loop_strip_think_signature_takes_no_reasoning_argument() -> None:
    """The fallback that leaked the monologue is gone for good (131 §B)."""
    assert AgentLoop._strip_think("<think>monologue</think>Visible") == "Visible"
    assert AgentLoop._strip_think("<think>monologue</think>") is None
    with pytest.raises(TypeError):
        AgentLoop._strip_think("<think>x</think>y", "reasoning")  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# §A — the provider normalizes both sources before they leave the boundary
# ---------------------------------------------------------------------------


class _Delta:
    def __init__(self, content=None, reasoning_content=None):
        self.content = content
        self.reasoning = None
        self.thinking = None
        self.reasoning_content = reasoning_content
        self.tool_calls = None


class _Choice:
    def __init__(self, delta, finish_reason=None):
        self.delta = delta
        self.finish_reason = finish_reason


class _Chunk:
    def __init__(self, choices=None, usage=None):
        self.choices = choices if choices is not None else []
        self.usage = usage


def _provider() -> CustomProvider:
    return CustomProvider(api_key="test", api_base="http://localhost:8000/v1")


async def _run_stream(provider: CustomProvider, deltas: list[tuple[str | None, str | None]]):
    """Stream ``(content, reasoning_content)`` deltas; record both channels."""
    progress: list[str] = []
    thinking: list[str] = []

    async def gen():
        for content, reasoning in deltas:
            yield _Chunk(
                choices=[_Choice(_Delta(content=content, reasoning_content=reasoning))]
            )
        yield _Chunk(choices=[_Choice(_Delta(), finish_reason="stop")])

    provider._client.chat.completions.create = AsyncMock(return_value=gen())

    async def on_progress(text: str) -> None:
        progress.append(text)

    async def on_thinking(text: str) -> None:
        thinking.append(text)

    resp = await provider.chat(
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
        on_progress=on_progress,
        on_thinking=on_thinking,
    )
    return resp, progress, thinking


@pytest.mark.asyncio
async def test_stream_splits_inline_think_out_of_content() -> None:
    resp, progress, thinking = await _run_stream(
        _provider(),
        [
            ("<think>I should ", None),
            ("answer simply</think>", None),
            ("Hello!", None),
        ],
    )
    assert resp.content == "Hello!"
    assert progress == ["Hello!"], "only visible prose reaches on_progress"
    assert thinking[-1] == "I should answer simply"


@pytest.mark.asyncio
async def test_stream_routes_both_sources_to_the_thinking_channel() -> None:
    """Source A (dedicated field) + Source B (inline tags) merge into one channel."""
    resp, progress, thinking = await _run_stream(
        _provider(),
        [
            (None, "first reasoning"),  # Source A
            ("<think>inline reasoning</think>", None),  # Source B
            ("The answer", None),
        ],
    )
    assert resp.content == "The answer"
    assert resp.reasoning_content == "first reasoninginline reasoning"
    assert progress == ["The answer"]
    assert thinking[-1] == "first reasoninginline reasoning"


@pytest.mark.asyncio
async def test_stream_without_on_thinking_still_keeps_tags_out_of_content() -> None:
    """Telegram never receives thinking frames — content must still be clean."""
    provider = _provider()
    progress: list[str] = []

    async def gen():
        yield _Chunk(choices=[_Choice(_Delta(content="<think>hush</think>"))])
        yield _Chunk(choices=[_Choice(_Delta(content="Answer"), finish_reason="stop")])

    provider._client.chat.completions.create = AsyncMock(return_value=gen())
    resp = await provider.chat(
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
        on_progress=lambda c: progress.append(c),
    )
    assert resp.content == "Answer"
    assert progress == ["Answer"]


# ---------------------------------------------------------------------------
# §B/§C — the loop: reasoning never bubbles, genuine prose seals
# ---------------------------------------------------------------------------


class _StubTool:
    def __init__(self, name: str):
        self.name = name


class _FakeProvider:
    """Returns a scripted response per call."""

    def __init__(self, responses):
        self.responses = responses if isinstance(responses, list) else [responses]
        self.calls = 0

    def get_default_model(self) -> str:
        return "test-model"

    async def chat(self, messages=None, **kwargs):
        resp = self.responses[min(self.calls, len(self.responses) - 1)]
        self.calls += 1
        return resp


def _fake_add_assistant(messages, content, tool_calls=None, reasoning_content=None):
    messages.append({"role": "assistant", "content": content})
    return messages


def _fake_add_tool_result(messages, tool_id, name, result):
    messages.append({"role": "tool", "tool_call_id": tool_id, "content": str(result)})
    return messages


def _make_loop(tmp_path, responses) -> tuple[AgentLoop, MessageBus]:
    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    bus = MessageBus()
    with (
        patch("sarathy.agent.loop.ContextBuilder"),
        patch("sarathy.agent.loop.SubagentManager") as mock_submgr,
    ):
        mock_submgr.return_value.cancel_by_session = AsyncMock(return_value=0)
        loop = AgentLoop(
            bus=bus,
            provider=_FakeProvider(responses),
            workspace=workspace,
            model="test-model",
            session_manager=SessionManager(Config(), workspace=tmp_path / "sessions"),
        )
    loop.context.build_messages.return_value = [{"role": "user", "content": "hi"}]
    loop.context.add_assistant_message.side_effect = _fake_add_assistant
    loop.context.add_tool_result.side_effect = _fake_add_tool_result
    loop.context.get_history.return_value = []
    loop.tools.execute = AsyncMock(return_value="saved")
    return loop, bus


async def _drain(bus: MessageBus, timeout: float = 0.3) -> list[OutboundMessage]:
    """Every frame the turn published on the bus, in order."""
    frames: list[OutboundMessage] = []
    while True:
        try:
            frames.append(await asyncio.wait_for(bus.consume_outbound(), timeout=timeout))
        except asyncio.TimeoutError:
            return frames


def _recorder(
    prose: list[str], hints: list[tuple[str, bool]]
):
    """An ``on_progress`` that files prose and tool hints apart."""

    async def on_progress(text: str, *, tool_hint: bool = False, seal: bool = False) -> None:
        if tool_hint:
            hints.append((text, seal))
        else:
            prose.append(text)

    return on_progress


@pytest.mark.asyncio
async def test_reasoning_with_tool_call_publishes_no_narration(tmp_path) -> None:
    """§B — DeepSeek-style: monologue in reasoning, tool call, no content."""
    responses = [
        LLMResponse(
            content=None,
            reasoning_content="I should call the memory tool",
            tool_calls=[ToolCallRequest(id="t1", name="memory_log", arguments={})],
        ),
        LLMResponse(content="Done, I noted that."),
    ]
    loop, _ = _make_loop(tmp_path, responses)
    prose: list[str] = []
    hints: list[tuple[str, bool]] = []

    final, _, _, _ = await loop._run_agent_loop(
        [{"role": "user", "content": "remember I like tea"}],
        on_progress=_recorder(prose, hints),
        session_metadata={"streaming": True},
    )

    assert prose == [], "reasoning must never be narrated as content"
    assert [h for h, _ in hints], "the tool hint still publishes"
    assert final == "Done, I noted that."


@pytest.mark.asyncio
async def test_prose_with_tool_call_publishes_a_sealed_bubble(tmp_path) -> None:
    """§C — genuine prose alongside a tool call is sealed, never overwritten."""
    responses = [
        LLMResponse(
            content="Noted — I will remember that.",
            tool_calls=[ToolCallRequest(id="t1", name="memory_log", arguments={})],
        ),
        LLMResponse(content="Anything else?"),
    ]
    loop, _ = _make_loop(tmp_path, responses)
    prose: list[str] = []
    hints: list[tuple[str, bool]] = []

    final, _, _, _ = await loop._run_agent_loop(
        [{"role": "user", "content": "remember"}],
        on_progress=_recorder(prose, hints),
        session_metadata={"streaming": True},
    )

    assert prose == ["Noted — I will remember that."]
    assert final == "Anything else?"


@pytest.mark.asyncio
async def test_answer_plus_memory_log_tool_call_yields_exactly_two_bubbles(tmp_path) -> None:
    """§C — the req-4 case: an answer AND a memory write → sealed answer + final."""
    responses = [
        LLMResponse(
            content="Noted — I will remember that you like tea.",
            tool_calls=[ToolCallRequest(id="t1", name="memory_log", arguments={"fact": "tea"})],
        ),
        LLMResponse(content="Anything else?"),
    ]
    loop, bus = _make_loop(tmp_path, responses)
    msg = InboundMessage(
        channel="dashboard", sender_id="u", chat_id="console", content="remember tea"
    )
    final = await loop._process_message(msg)
    frames = await _drain(bus)

    sealed = [f for f in frames if f.metadata.get("_seal")]
    assert len(sealed) == 1, "one sealed bubble, never one per tool call"
    assert sealed[0].content == "Noted — I will remember that you like tea."
    assert sealed[0].metadata["_progress"] is True

    # The tool hint rides the sealed bubble's thinking section.
    hints = [f for f in frames if f.metadata.get("_tool_hint") is True]
    assert len(hints) == 1 and not hints[0].metadata.get("_seal")

    # ...and the turn's final is a separate message, so the SPA opens bubble #2.
    assert final is not None
    assert final.metadata["_final"] is True
    assert final.content == "Anything else?"
    assert final.metadata.get("turn_id") == sealed[0].metadata.get("turn_id")

    # Exactly one narration frame for the whole turn: the sealed prose.
    narration = [
        f
        for f in frames
        if f.metadata.get("_progress") and not f.metadata.get("_tool_hint")
    ]
    assert len(narration) == 1


@pytest.mark.asyncio
async def test_tool_call_with_reasoning_only_never_publishes_a_sealed_frame(tmp_path) -> None:
    """§B/§C — reasoning + tool call alone produces zero message bubbles."""
    responses = [
        LLMResponse(
            content=None,
            reasoning_content="private monologue",
            tool_calls=[ToolCallRequest(id="t1", name="memory_log", arguments={})],
        ),
        LLMResponse(content="Here you go."),
    ]
    loop, bus = _make_loop(tmp_path, responses)
    msg = InboundMessage(channel="dashboard", sender_id="u", chat_id="console", content="do it")
    final = await loop._process_message(msg)
    frames = await _drain(bus)

    assert not [f for f in frames if f.metadata.get("_seal")]
    assert not [
        f
        for f in frames
        if f.metadata.get("_progress") and "private monologue" in (f.content or "")
    ]
    assert final is not None and final.content == "Here you go."


@pytest.mark.asyncio
async def test_two_prose_tool_iterations_seal_twice_then_final(tmp_path) -> None:
    """Two prose-bearing iterations → two sealed bubbles, then the final."""
    responses = [
        LLMResponse(
            content="First.",
            tool_calls=[ToolCallRequest(id="t1", name="memory_log", arguments={})],
        ),
        LLMResponse(
            content="Second.",
            tool_calls=[ToolCallRequest(id="t2", name="memory_log", arguments={})],
        ),
        LLMResponse(content="Done."),
    ]
    loop, bus = _make_loop(tmp_path, responses)
    msg = InboundMessage(channel="dashboard", sender_id="u", chat_id="console", content="go")
    final = await loop._process_message(msg)
    frames = await _drain(bus)

    sealed = [f.content for f in frames if f.metadata.get("_seal")]
    assert sealed == ["First.", "Second."], "one sealed bubble per PROSE-bearing iteration"
    assert final is not None and final.content == "Done."
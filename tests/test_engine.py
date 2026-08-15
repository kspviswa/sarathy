"""Engine lifecycle + session behavior against a FakeProvider."""

from __future__ import annotations

import asyncio

from tau_agent.messages import AssistantMessage, TextContent, UserMessage

from sarathy.engine.events import RunEnd, SessionCreated
from sarathy.engine.session import message_to_dict


def test_message_to_dict_user() -> None:
    msg = UserMessage(content=[TextContent(text="hi")])
    d = message_to_dict(msg)
    assert d["role"] == "user"
    assert d["content"] == "hi"


def test_message_to_dict_assistant() -> None:
    msg = AssistantMessage(role="assistant", content=[TextContent(text="hello")])
    d = message_to_dict(msg)
    assert d["role"] == "assistant"
    assert d["content"] == "hello"


async def test_new_session_publishes_session_created(engine) -> None:
    hub_events = []
    engine.hub.subscribe(lambda sid, ev: hub_events.append((sid, ev)))
    sid = "abc"
    app = engine.new_session(sid)
    await asyncio.sleep(0)
    assert engine.get_session(sid) is app
    assert isinstance(hub_events[0][1], SessionCreated)
    assert hub_events[0][0] == sid


async def test_ensure_session_reuses_existing(engine) -> None:
    app = engine.new_session("s1")
    assert await engine.ensure_session("s1") is app


async def test_delete_session(engine) -> None:
    engine.new_session("s1", activate=False)
    engine.delete_session("s1")
    assert engine.get_session("s1") is None


async def test_list_sessions_roundtrip_disk(engine, tmp_path) -> None:
    from tau_agent.session import MessageEntry

    app = engine.new_session("s1")
    await app.storage.append(
        MessageEntry(message=UserMessage(content=[TextContent(text="stored")]))
    )
    sessions = await engine.list_sessions()
    assert any(s["session_id"] == "s1" for s in sessions)


async def test_send_roundtrip_with_fake_provider(make_engine, tmp_path) -> None:
    engine = await make_engine(tmp_path, reply=["howdy!"])
    app = engine.new_session("s1")

    done = asyncio.Event()

    async def on_event(sid, event):
        if isinstance(event, RunEnd):
            done.set()

    engine.hub.subscribe(on_event)
    await engine.send("s1", "hello there")
    await asyncio.wait_for(done.wait(), timeout=5)

    messages = await app.messages()
    text = "".join(m.content[0].text for m in messages if isinstance(m, AssistantMessage))
    assert text == "howdy!"


async def test_run_start_and_end_published(make_engine, tmp_path) -> None:
    engine = await make_engine(tmp_path, reply=["ok"])
    events = []

    async def on_event(sid, event):
        events.append(type(event).__name__)

    engine.hub.subscribe(on_event)
    app = engine.new_session("s1")
    done = asyncio.Event()
    engine.hub.subscribe(lambda sid, e: done.set() if isinstance(e, RunEnd) else None)
    await app.send("go")
    await asyncio.wait_for(done.wait(), timeout=5)

    assert "RunStart" in events
    assert "RunEnd" in events


async def test_queued_message_while_running(make_engine, tmp_path) -> None:
    """A second send() while a turn runs should queue, not start a new turn."""
    engine = await make_engine(tmp_path, reply=["first", "second"])
    app = engine.new_session("q1")

    queued1 = await app.send("m1")
    queued2 = await app.send("m2")
    assert queued1 is False
    assert queued2 is True

    done = asyncio.Event()
    engine.hub.subscribe(lambda sid, e: done.set() if isinstance(e, RunEnd) else None)
    await asyncio.wait_for(done.wait(), timeout=5)

    final = await app.messages()
    assistant_text = "".join(
        m.content[0].text for m in final if isinstance(m, AssistantMessage)
    )
    assert "first" in assistant_text
    assert "second" in assistant_text


def test_message_to_dict_tool() -> None:
    from tau_agent.messages import ToolResultMessage

    msg = ToolResultMessage(
        tool_call_id="call_1",
        tool_name="read_file",
        is_error=False,
        content=[TextContent(text="file contents")],
    )
    d = message_to_dict(msg)
    assert d["role"] == "tool"
    assert d["toolName"] == "read_file"
    assert d["isError"] is False


async def test_health_shape(engine) -> None:
    h = engine.health()
    assert h["ok"] is True
    assert h["model"]
    assert "sessions" in h
    assert "uptime_s" in h


def test_unconfigured_engine(tmp_path) -> None:
    """An engine built from a default (no-provider) config boots as unconfigured."""
    from sarathy.config.schema import Config
    from sarathy.engine.engine import SarathyEngine

    config = Config()
    config.agents.defaults.workspace = str(tmp_path)
    engine = SarathyEngine(config)

    assert engine.configured is False
    assert engine.provider is None
    h = engine.health()
    assert h["configured"] is False
    assert h["provider"] is None


def test_build_provider_unconfigured_returns_none() -> None:
    from sarathy.config.schema import Config
    from sarathy.engine.provider import build_provider

    config = Config()
    provider, name = build_provider(config)
    assert provider is None
    assert name is None

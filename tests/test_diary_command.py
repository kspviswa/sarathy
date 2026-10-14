"""Tests for the `/diary` capture command (spec 138).

`/diary <prose>` runs a side turn on the `local` role, but — unlike `/local`,
which inherits the full ~19k-token prompt and all 8 tools — it hands the model a
narrow biographer prompt and `exec` alone. That narrowing is the whole point:
a 12B local model answers `/local` conversationally with zero tool calls, so the
`diary.py add` call never fires. What is under test here:

  * registration (`BUILTIN_COMMANDS`, `/help`, `GET /api/commands`);
  * empty args     → usage notice, no turn;
  * no local role  → canned refusal, NO turn;
  * local role set → ack, then `_run_btw_turn(provider_role="local",
    side_tag="diary")` carrying the narrow prompt + exec-only tools;
  * `build_messages(system_prompt_override=…)` uses the override verbatim and
    `build_messages(media=…)` appends `[attached media: …]` — the only way a
    turn can still name its files after the image pipeline rewrites them;
  * `_build_diary_system_prompt()` content, and its embedded fallback;
  * `_run_agent_loop(tools_override=…)` forwards exactly that tool set.
"""

from __future__ import annotations

import asyncio
import base64
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sarathy.agent.builtin_commands import BUILTIN_COMMANDS, get_help_text
from sarathy.agent.context import ContextBuilder
from sarathy.agent.loop import DIARY_CLI, AgentLoop
from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.config.schema import Config
from sarathy.providers.base import LLMResponse
from sarathy.session.manager import SessionManager

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


class FakeProvider:
    """Canned LLM provider that records every call it serves."""

    def __init__(self, name: str = "main", reply: str = "answer"):
        self.name = name
        self.reply = reply
        self.calls: list[dict] = []
        self.provider_name = name

    def get_default_model(self) -> str:
        return f"{self.name}-model"

    async def chat(self, messages: list[dict] | None = None, **kwargs: Any) -> LLMResponse:
        self.calls.append({"messages": list(messages or []), **kwargs})
        return LLMResponse(content=f"{self.reply} from {self.name}")


class FakeRuntime:
    """RuntimeProvider stand-in: returns a provider per role, records lookups."""

    def __init__(self, local_provider=None, image_provider=None):
        self.main_provider = FakeProvider("main")
        self.local_provider = local_provider
        self.image_provider = image_provider
        self.lookups: list[str] = []

    def provider_for(self, role: str):
        self.lookups.append(role)
        if role == "local":
            return self.local_provider
        if role == "image":
            return self.image_provider
        return self.main_provider

    def apply_to(self, agent) -> bool:
        return False


def _make_loop(tmp_path, provider, runtime=None, patch_context: bool = True):
    """Build an AgentLoop. ``patch_context=False`` keeps the real ContextBuilder."""
    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    bus = MessageBus()
    sm = SessionManager(Config(), workspace=tmp_path / "sessions")
    patches = [patch("sarathy.agent.loop.SubagentManager")]
    if patch_context:
        patches.append(patch("sarathy.agent.loop.ContextBuilder"))
    for p in patches:
        p.start()
    try:
        loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=workspace,
            model="main-model",
            session_manager=sm,
        )
    finally:
        for p in patches:
            p.stop()
    loop.runtime = runtime
    if patch_context:
        loop.context.build_messages.return_value = [{"role": "user", "content": "hi"}]
        loop.context.add_assistant_message.side_effect = (
            lambda msgs, content=None, tool_calls=None, reasoning_content=None: (
                msgs.append({"role": "assistant", "content": content}),
                msgs,
            )[1]
        )
        loop.context.add_tool_result.side_effect = (
            lambda msgs, tool_id, name, result: (
                msgs.append(
                    {"role": "tool", "tool_call_id": tool_id, "name": name, "content": str(result)}
                ),
                msgs,
            )[1]
        )
    loop.channels_config = Config().channels
    return loop, bus, sm


def _msg(content: str, key: str = "test:c1", media: list[str] | None = None) -> InboundMessage:
    channel, chat_id = key.split(":", 1)
    return InboundMessage(
        channel=channel,
        sender_id="u1",
        chat_id=chat_id,
        content=content,
        media=media or [],
    )


async def _next(bus: MessageBus, timeout: float = 1.0) -> OutboundMessage:
    return await asyncio.wait_for(bus.consume_outbound(), timeout=timeout)


async def _drain_until(bus: MessageBus, predicate, tries: int = 40):
    """Consume frames until one satisfies `predicate`; return it or None."""
    for _ in range(tries):
        try:
            out = await asyncio.wait_for(bus.consume_outbound(), timeout=0.3)
        except asyncio.TimeoutError:
            return None
        if predicate(out):
            return out
    return None


async def _let_task_start() -> None:
    """Let a `create_task`-spawned side turn reach its first await."""
    for _ in range(5):
        await asyncio.sleep(0)


def _write_png(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PNG_1X1)
    return path


def _user_text(messages: list[dict]) -> str:
    """Flatten every user message's text parts (string or multimodal list)."""
    chunks: list[str] = []
    for m in messages:
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            chunks.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    chunks.append(str(part.get("text", "")))
    return "\n".join(chunks)


# ---------------------------------------------------------------------------
# Registry (spec 138 §A / §5 AC1)
# ---------------------------------------------------------------------------


def test_diary_is_registered_as_a_builtin_command():
    assert "diary" in BUILTIN_COMMANDS
    cmd = BUILTIN_COMMANDS["diary"]
    assert cmd.name == "diary"
    assert cmd.subcommands == []
    assert cmd.has_status is False
    assert "diary" in cmd.description.lower()
    assert "local" in cmd.description.lower()


def test_diary_has_no_subcommand_help_block():
    """No subcommands → a bare `/diary` must reach its own usage notice, not
    the generic `📖` subcommand help."""
    assert "Subcommands:" not in get_help_text(
        BUILTIN_COMMANDS["diary"].name,
        BUILTIN_COMMANDS["diary"].description,
        BUILTIN_COMMANDS["diary"].subcommands,
    )


def test_diary_listed_by_help_command():
    """`/help` enumerates the registry, so /diary is discoverable there too."""
    names = [f"/{c.name}" for c in BUILTIN_COMMANDS.values()]
    assert "/diary" in names


@pytest.mark.asyncio
async def test_diary_appears_in_api_commands_payload():
    """`GET /api/commands` serialises BUILTIN_COMMANDS, so /diary reaches the
    palette and `/` autocomplete with no server edit at all."""
    import json

    from sarathy.channels.dashboard.server import DashboardChannel

    channel = DashboardChannel.__new__(DashboardChannel)
    resp = await DashboardChannel._api_commands(channel, MagicMock())

    payload = json.loads(resp.body)
    assert payload["count"] == len(BUILTIN_COMMANDS)

    by_name = {c["name"]: c for c in payload["commands"]}
    assert "diary" in by_name, "/diary must be advertised to the SPA"
    diary = by_name["diary"]
    assert diary["subcommands"] == []
    assert diary["hasStatus"] is False
    assert diary["description"] == BUILTIN_COMMANDS["diary"].description


# ---------------------------------------------------------------------------
# Empty args → usage, no turn (spec 138 §A)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_diary_empty_args_returns_usage_and_runs_no_turn(tmp_path):
    local = FakeProvider("local")
    runtime = FakeRuntime(local_provider=local)
    main = FakeProvider("main")
    loop, bus, _ = _make_loop(tmp_path, main, runtime)

    loop._run_btw_turn = AsyncMock()  # any side turn would be a bug here

    await loop._handle_diary(_msg("/diary"))

    out = await _next(bus)
    assert "Usage: /diary" in out.content
    assert out.metadata.get("_notice") is True
    loop._run_btw_turn.assert_not_awaited()
    assert main.calls == [] and local.calls == []
    assert "local" not in runtime.lookups


# ---------------------------------------------------------------------------
# No local provider → canned refusal, NO turn (spec 138 §A)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_diary_without_local_provider_refuses_and_runs_no_turn(tmp_path):
    """Logging from the main (cloud) model would defeat the whole command."""
    runtime = FakeRuntime(local_provider=None)
    main = FakeProvider("main")
    loop, bus, _ = _make_loop(tmp_path, main, runtime)

    loop._run_btw_turn = AsyncMock()

    await loop._handle_diary(_msg("/diary I finally finished the balcony garden."))

    out = await _next(bus)
    assert "No local provider is configured" in out.content
    assert "/provider role local <name>" in out.content
    assert out.metadata.get("_notice") is True

    loop._run_btw_turn.assert_not_awaited()
    assert main.calls == []
    assert runtime.lookups == ["local"]


@pytest.mark.asyncio
async def test_diary_without_runtime_refuses_and_runs_no_turn(tmp_path):
    """No runtime at all (CLI/test context) is handled the same way."""
    main = FakeProvider("main")
    loop, bus, _ = _make_loop(tmp_path, main, runtime=None)

    loop._run_btw_turn = AsyncMock()
    await loop._handle_diary(_msg("/diary today was a good day."))

    out = await _next(bus)
    assert "No local provider is configured" in out.content
    loop._run_btw_turn.assert_not_awaited()


# ---------------------------------------------------------------------------
# /diary <text> → side turn on the local role (spec 138 §A)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_diary_routes_side_turn_to_local_provider_with_diary_tag(tmp_path):
    """The routing contract: local role, `diary` side tag, narrow prompt,
    exec-only tools, and the turn's media handed to build_messages."""
    local = FakeProvider("local", reply="noted")
    runtime = FakeRuntime(local_provider=local)
    main = FakeProvider("main")
    loop, bus, _ = _make_loop(tmp_path, main, runtime)

    loop._run_btw_turn = AsyncMock()
    media = [str(tmp_path / "ws" / "media" / "photo.png")]

    await loop._handle_diary(
        _msg("/diary Viyaan laughed for the first time in weeks.", media=media)
    )

    ack = await _next(bus)
    assert "DIARY noted" in ack.content
    assert "local biographer" in ack.content
    assert ack.metadata.get("_notice") is True

    await _let_task_start()
    loop._run_btw_turn.assert_awaited_once()
    args, kwargs = loop._run_btw_turn.await_args
    assert args[1] == "Viyaan laughed for the first time in weeks."
    assert kwargs["provider_role"] == "local"
    assert kwargs["side_tag"] == "diary"
    assert kwargs["media"] == media
    assert kwargs["system_prompt_override"]
    assert "exec" in str(kwargs["system_prompt_override"])
    tool_names = [t["function"]["name"] for t in kwargs["tools_override"]]
    assert tool_names == ["exec"]


@pytest.mark.asyncio
async def test_diary_without_media_passes_no_media(tmp_path):
    """`media=None` (not `[]`) so the marker injection stays a no-op."""
    local = FakeProvider("local")
    loop, bus, _ = _make_loop(tmp_path, FakeProvider("main"), FakeRuntime(local_provider=local))

    loop._run_btw_turn = AsyncMock()
    await loop._handle_diary(_msg("/diary quiet day."))
    await _next(bus)
    await _let_task_start()

    _, kwargs = loop._run_btw_turn.await_args
    assert kwargs["media"] is None


@pytest.mark.asyncio
async def test_diary_turn_runs_on_local_provider_and_restores_the_main_one(tmp_path):
    """End to end through the real ContextBuilder: local provider serves the
    turn, the active provider/model are restored, and the reply is `_btw`-tagged."""
    local = FakeProvider("local", reply="Noted, sir.")
    runtime = FakeRuntime(local_provider=local)
    main = FakeProvider("main", reply="main answer")
    loop, bus, sm = _make_loop(tmp_path, main, runtime, patch_context=False)

    await loop._handle_diary(_msg("/diary I re-read my old journals today."))
    await _drain_until(bus, lambda o: o.metadata.get("_final"))

    assert local.calls, "the local provider must serve the /diary turn"
    assert main.calls == [], "the active provider must not be touched"
    assert loop.provider is main
    assert loop.model == "main-model"
    assert "test:c1" not in loop._active_btw_turns

    # The turn really ran on the narrow prompt, not the ~19k-token one.
    system = local.calls[0]["messages"][0]
    assert system["role"] == "system"
    assert "diary biographer" in system["content"]
    assert "Sarathy Guidelines" not in system["content"]

    # …with exec and nothing else advertised.
    tools = local.calls[0]["tools"]
    assert [t["function"]["name"] for t in tools] == ["exec"]

    side_keys = [k for k in sm._cache if "##diary##" in k]
    assert len(side_keys) == 1, "the entry lands in a diary side session"


@pytest.mark.asyncio
async def test_diary_side_session_never_touches_the_main_session(tmp_path):
    local = FakeProvider("local", reply="Noted, sir.")
    runtime = FakeRuntime(local_provider=local)
    loop, bus, sm = _make_loop(tmp_path, FakeProvider("main"), runtime, patch_context=False)

    await loop._handle_diary(_msg("/diary first entry"))
    await _drain_until(bus, lambda o: o.metadata.get("_final"))
    await loop._handle_diary(_msg("/diary second entry"))
    await _drain_until(bus, lambda o: o.metadata.get("_final"))

    side_keys = [k for k in sm._cache if "##diary##" in k]
    assert len(side_keys) == 2, "each /diary turn gets its own side session"
    main_session = sm.get_or_create("test:c1")
    assert not any("Noted, sir." in (m.get("content") or "") for m in main_session.messages)


@pytest.mark.asyncio
async def test_run_dispatches_diary_to_handle_diary(tmp_path):
    """`/diary` is intercepted in the run loop beside /btw and /local so its
    ack ships out-of-band, without waiting on the session lock."""
    local = FakeProvider("local", reply="Noted, sir.")
    loop, bus, _ = _make_loop(tmp_path, FakeProvider("main"), FakeRuntime(local_provider=local))

    handled: list[InboundMessage] = []
    loop._handle_diary = AsyncMock(side_effect=lambda m: handled.append(m))
    loop._handle_btw = AsyncMock()
    loop._handle_local = AsyncMock()
    loop._connect_mcp = AsyncMock()
    loop._running = True

    async def stop_after_one():
        loop._running = False
        return _msg("/diary today I felt lighter than usual.")

    loop.bus.consume_inbound = stop_after_one  # type: ignore[method-assign]

    await loop.run()

    assert len(handled) == 1
    assert handled[0].content == "/diary today I felt lighter than usual."
    loop._handle_btw.assert_not_awaited()
    loop._handle_local.assert_not_awaited()


# ---------------------------------------------------------------------------
# system_prompt_override (spec 138 §B)
# ---------------------------------------------------------------------------


def test_build_messages_uses_the_system_prompt_override_verbatim(tmp_path):
    cb = ContextBuilder(tmp_path)
    override = "You are Sarathy's diary biographer.\nONLY THIS."

    messages = cb.build_messages(
        history=[{"role": "user", "content": "earlier"}],
        current_message="today was heavy",
        system_prompt_override=override,
    )

    assert messages[0] == {"role": "system", "content": override}
    # The history and the user message are untouched by the override.
    assert messages[1] == {"role": "user", "content": "earlier"}
    assert messages[-1]["content"].endswith("today was heavy")


def test_build_messages_default_still_assembles_the_full_prompt(tmp_path):
    """`system_prompt_override=None` is byte-identical to the old behaviour."""
    cb = ContextBuilder(tmp_path)
    default = cb.build_messages(history=[], current_message="hi")
    explicit_none = cb.build_messages(history=[], current_message="hi", system_prompt_override=None)

    assert default[0]["content"] == explicit_none[0]["content"]
    assert "# Sarathy" in default[0]["content"]
    assert default[0]["content"] != "You are Sarathy's diary biographer."


@pytest.mark.asyncio
async def test_run_btw_turn_forwards_the_override_to_build_messages(tmp_path):
    """The override reaches the side turn's build_messages call and ends up as
    the system message the local model actually sees."""
    local = FakeProvider("local")
    loop, bus, _ = _make_loop(
        tmp_path, FakeProvider("main"), FakeRuntime(local_provider=local), patch_context=False
    )

    override = "NARROW DIARY PROMPT"
    await loop._run_btw_turn(
        _msg("/diary something"),
        "something",
        provider_role="local",
        side_tag="diary",
        system_prompt_override=override,
        tools_override=[],
    )
    await _drain_until(bus, lambda o: o.metadata.get("_final"))

    assert local.calls[0]["messages"][0]["content"] == override


@pytest.mark.asyncio
async def test_run_btw_turn_forwards_media_and_passes_none_by_default(tmp_path):
    local = FakeProvider("local")
    loop, bus, _ = _make_loop(tmp_path, FakeProvider("main"), FakeRuntime(local_provider=local))

    media = ["balcony.png"]
    await loop._run_btw_turn(
        _msg("/diary something", media=media),
        "something",
        provider_role="local",
        side_tag="diary",
        media=media,
    )
    await _drain_until(bus, lambda o: o.metadata.get("_final"))

    _, kwargs = loop.context.build_messages.call_args
    assert kwargs["media"] == media
    assert kwargs["system_prompt_override"] is None

    # …and the /btw default (no media kwarg) leaves it None, so the side turns
    # that predate /diary see no marker at all.
    await loop._run_btw_turn(_msg("/btw something"), "something")
    await _drain_until(bus, lambda o: o.metadata.get("_final"))

    _, kwargs = loop.context.build_messages.call_args
    assert kwargs["media"] is None


# ---------------------------------------------------------------------------
# tools_override (spec 138 §B / §5)
# ---------------------------------------------------------------------------


def test_diary_tool_definitions_is_exec_only(tmp_path):
    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))
    defs = loop._diary_tool_definitions()
    assert [d["function"]["name"] for d in defs] == ["exec"]
    # It is the live registry's schema, not a hand-rolled stub.
    assert defs[0] == [
        d for d in loop.tools.get_definitions() if d["function"]["name"] == "exec"
    ][0]


@pytest.mark.asyncio
async def test_run_agent_loop_sends_exactly_the_overridden_tools(tmp_path):
    loop, bus, _ = _make_loop(tmp_path, FakeProvider("main"), patch_context=False)
    provider = FakeProvider("main")
    loop.provider = provider

    await loop._run_agent_loop(
        [{"role": "user", "content": "capture this"}],
        tools_override=[{"type": "function", "function": {"name": "exec", "parameters": {}}}],
    )

    assert len(provider.calls) == 1
    assert provider.calls[0]["tools"] == [
        {"type": "function", "function": {"name": "exec", "parameters": {}}}
    ]


@pytest.mark.asyncio
async def test_run_agent_loop_without_override_still_sends_the_full_registry(tmp_path):
    """Default behaviour is untouched: all registered tools, every iteration."""
    loop, bus, _ = _make_loop(tmp_path, FakeProvider("main"), patch_context=False)
    provider = FakeProvider("main")
    loop.provider = provider

    await loop._run_agent_loop([{"role": "user", "content": "hello"}])

    sent = provider.calls[0]["tools"]
    assert sent == loop.tools.get_definitions()
    assert len(sent) >= 8, "the main turn keeps its full tool set"


@pytest.mark.asyncio
async def test_run_btw_turn_forwards_the_overridden_tools(tmp_path):
    local = FakeProvider("local")
    loop, bus, _ = _make_loop(tmp_path, FakeProvider("main"), FakeRuntime(local_provider=local))

    exec_def = {"type": "function", "function": {"name": "exec"}}
    await loop._run_btw_turn(
        _msg("/diary something"),
        "something",
        provider_role="local",
        side_tag="diary",
        tools_override=[exec_def],
    )
    await _drain_until(bus, lambda o: o.metadata.get("_final"))

    assert local.calls[0]["tools"] == [exec_def]


# ---------------------------------------------------------------------------
# The prompt itself (spec 138 §C)
# ---------------------------------------------------------------------------


def test_diary_system_prompt_states_the_contract(tmp_path):
    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))
    prompt = loop._build_diary_system_prompt(channel="telegram")

    assert prompt.strip()
    # Role + trigger.
    assert "diary biographer" in prompt
    assert "first-person life content" in prompt
    assert "no diary entry" in prompt.lower() or "NOT record" in prompt
    # The three layers.
    assert "raw" in prompt and "narrative" in prompt and "thread" in prompt
    assert "verbatim" in prompt
    # Metadata.
    assert "--mood" in prompt and "--people" in prompt and "--tags" in prompt
    # The mandatory capture call + its CLI contract.
    assert f"python3 {DIARY_CLI} add" in prompt
    assert "--raw" in prompt and "--narrative" in prompt and "--thread" in prompt
    assert "MANDATORY" in prompt
    assert "--source telegram" in prompt
    # Images, including the graceful degrade for a CLI without --images.
    assert "[attached media: <paths>]" in prompt
    assert "--images" in prompt and "--image-desc" in prompt
    assert "WITHOUT `--images`" in prompt
    # Quoting safety for text with quotes/$/newlines.
    assert "<<" in prompt and '"$(cat ' in prompt
    # The ack.
    assert "Noted, sir." in prompt
    assert "NO questions, NO judgement, NO advice" in prompt


def test_diary_system_prompt_source_follows_the_channel(tmp_path):
    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))
    assert "--source dashboard" in loop._build_diary_system_prompt(channel="dashboard")
    # Unknown/absent channels fall back to `cli` rather than leaking junk into
    # the CLI's --source enum.
    assert "--source cli" in loop._build_diary_system_prompt()
    assert "--source cli" in loop._build_diary_system_prompt(channel="weird-channel")


def test_diary_system_prompt_falls_back_when_the_skill_is_missing(tmp_path):
    """A missing SKILL.md degrades to the embedded craft, never to a crash."""
    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))

    with patch.object(AgentLoop, "_read_diary_skill_craft") as read:
        from sarathy.agent.loop import DIARY_CRAFT_FALLBACK

        read.return_value = DIARY_CRAFT_FALLBACK
        prompt = loop._build_diary_system_prompt(channel="telegram")

    assert DIARY_CRAFT_FALLBACK in prompt
    assert f"python3 {DIARY_CLI} add" in prompt, "the contract survives the fallback"


def test_diary_skill_craft_reads_the_workspace_skill(tmp_path):
    """The craft is read at runtime, so editing SKILL.md edits the biographer."""
    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))
    skill = tmp_path / "ws" / "skills" / "diary-biographer" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text(
        "---\nname: diary-biographer\ndescription: meta\n---\n\n# Custom craft marker\n",
        encoding="utf-8",
    )

    prompt = loop._build_diary_system_prompt()
    assert "Custom craft marker" in prompt
    assert "description: meta" not in prompt, "frontmatter is metadata, not craft"
    assert f"python3 {DIARY_CLI} add" in prompt


def test_read_diary_skill_craft_returns_the_embedded_fallback(tmp_path):
    from sarathy.agent.loop import DIARY_CRAFT_FALLBACK

    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))
    with patch("sarathy.agent.loop.Path.is_file", return_value=False):
        craft = loop._read_diary_skill_craft()
    assert craft == DIARY_CRAFT_FALLBACK


# ---------------------------------------------------------------------------
# Media-path injection (spec 138 §D)
# ---------------------------------------------------------------------------


def test_build_messages_appends_the_attached_media_marker(tmp_path):
    cb = ContextBuilder(tmp_path)
    media_dir = tmp_path / "media"
    media_dir.mkdir(exist_ok=True)

    messages = cb.build_messages(
        history=[],
        current_message="[image: photo.png] the balcony garden is done",
        media=["photo.png", "/abs/other.jpg"],
    )

    content = messages[-1]["content"]
    assert "[attached media: " in content
    # Relative paths resolve against workspace/media exactly like the image
    # pipeline does; absolute paths are kept verbatim.
    assert str(media_dir / "photo.png") in content
    assert "/abs/other.jpg" in content
    assert "photo.png, /abs/other.jpg" in content
    assert content.startswith("[Runtime Context") or "Runtime Context" in content


def test_build_messages_without_media_is_byte_identical(tmp_path):
    cb = ContextBuilder(tmp_path)
    plain = cb.build_messages(history=[], current_message="[image: photo.png] hi")
    assert "attached media" not in plain[-1]["content"]
    assert plain[-1]["content"].endswith("[image: photo.png] hi")


def test_attached_media_marker_does_not_collide_with_the_image_marker(tmp_path):
    """`[attached media: …]` must not be mistaken for an `[image: …]` token —
    that marker is the describe pipeline's split pattern."""
    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))

    messages = [
        {
            "role": "user",
            "content": "[attached media: /abs/photo.png]",
        }
    ]
    assert loop._has_image_content(messages) is False


def test_image_marker_still_drives_the_describe_pipeline(tmp_path):
    """Adding the attached-media line cannot break the existing `[image: …]`
    handling: a message carrying the old marker is still detected."""
    loop, _, _ = _make_loop(tmp_path, FakeProvider("main"))
    assert loop._has_image_content([{"role": "user", "content": "[image: /a/b.png]"}]) is True
    assert (
        loop._has_image_content(
            [{"role": "user", "content": "[image: /a/b.png]\n[attached media: /a/b.png]"}]
        )
        is True
    )


@pytest.mark.asyncio
async def test_diary_turn_passes_media_paths_to_the_local_model(tmp_path):
    """The whole point of §D: after the image pipeline swaps the image parts
    for `[image description: …]`, the model can still name the file to pass to
    `diary.py --images`."""
    local = FakeProvider("local", reply="Noted, sir.")
    image_provider = FakeProvider("image", reply="a balcony full of jasmine")
    runtime = FakeRuntime(local_provider=local, image_provider=image_provider)
    loop, bus, _ = _make_loop(tmp_path, FakeProvider("main"), runtime, patch_context=False)

    # Channels hand over absolute paths (telegram downloads into workspace/media).
    photo = _write_png(tmp_path / "ws" / "media" / "balcony.png")

    await loop._handle_diary(
        _msg("/diary I finally finished the balcony garden.", media=[str(photo)])
    )
    await _drain_until(bus, lambda o: o.metadata.get("_final"))

    assert local.calls, "the local biographer must see the turn"
    user_text = _user_text(local.calls[0]["messages"])

    assert str(photo) in user_text, "the absolute path must survive into the message"
    assert f"[attached media: {photo}]" in user_text
    # The describe pipeline still ran and left its hint behind, next to the path.
    assert "[image description: a balcony full of jasmine from image]" in user_text
    assert "image_url" not in user_text  # the part was replaced, as before

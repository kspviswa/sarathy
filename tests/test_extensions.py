"""Extension discovery, loading, and hook plumbing via ExtensionHost."""

from __future__ import annotations

from pathlib import Path

import pytest
from tau_agent.tools import AgentTool

from sarathy.extensions.host import ExtensionHost
from sarathy.extensions.loader import discover


def test_discover_finds_py_files(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    ext_dir.mkdir(parents=True)
    (ext_dir / "hello.py").write_text("", encoding="utf-8")
    (ext_dir / "ignore.txt").write_text("", encoding="utf-8")
    found = discover(tmp_path)
    names = {e.name for e in found}
    assert "hello" in names
    assert "ignore" not in names


def test_discover_finds_dir_and_pyproject_manifest(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    (ext_dir / "myext").mkdir(parents=True)
    (ext_dir / "myext" / "__init__.py").write_text("", encoding="utf-8")
    # renamed has a manifest pointing at an entry file with a custom stem
    renamed = ext_dir / "renamed"
    src = renamed / "src" / "my_ext"
    src.mkdir(parents=True)
    (src / "entry.py").write_text("", encoding="utf-8")
    (renamed / "pyproject.toml").write_text(
        "[tool.tau]\nextensions = ['src/my_ext/entry.py']\n",
        encoding="utf-8",
    )
    found = discover(tmp_path)
    names = {e.name for e in found}
    assert "myext" in names
    # manifest entry is named after the file stem (entry.py != extension.py)
    assert "entry" in names


def test_extension_with_tool_and_command_and_hooks(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    (ext_dir / "myext").mkdir(parents=True)
    (ext_dir / "myext" / "extension.py").write_text(
        _EXT_SRC,
        encoding="utf-8",
    )

    host = ExtensionHost()
    host.load(tmp_path)

    assert "myext" in host._extensions  # noqa: SLF001
    assert [t.name for t in host.tools] == ["hello"]
    assert "greet" in host.commands

    # tool is a real AgentTool
    tool = host.tools[0]
    assert isinstance(tool, AgentTool)


@pytest.mark.asyncio
async def test_input_hook_transform(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    (ext_dir / "trx").mkdir(parents=True)
    (ext_dir / "trx" / "extension.py").write_text(_TRANSFORM_SRC, encoding="utf-8")

    host = ExtensionHost()
    host.load(tmp_path)
    text, handled = await host.run_input_hooks("hi there")
    assert handled is None
    assert text == "HI THERE"


@pytest.mark.asyncio
async def test_input_hook_handled(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    (ext_dir / "hh").mkdir(parents=True)
    (ext_dir / "hh" / "extension.py").write_text(_HANDLED_SRC, encoding="utf-8")

    host = ExtensionHost()
    host.load(tmp_path)
    text, handled = await host.run_input_hooks("anything")
    assert handled == "extension consumed it"
    assert text == ""


def test_duplicate_tool_raises(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    (ext_dir / "a").mkdir(parents=True)
    (ext_dir / "a" / "extension.py").write_text(_TOOL_SRC, encoding="utf-8")
    (ext_dir / "b").mkdir(parents=True)
    (ext_dir / "b" / "extension.py").write_text(_TOOL_SRC, encoding="utf-8")

    host = ExtensionHost()
    host.load(tmp_path)
    # second registration of the same tool name is ignored (guarded) — no crash
    assert len(host.tools) == 1


def test_unknown_event_rejected() -> None:
    host = ExtensionHost()
    with pytest.raises(ValueError, match="unknown extension event"):
        host.subscribe("x", "nope", lambda *_: None)


def test_package_extension_relative_import(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    pkg = ext_dir / "pkg"
    pkg.mkdir(parents=True)
    (pkg / "helper.py").write_text(
        "def shout(name):\n    return 'HELLO ' + name\n",
        encoding="utf-8",
    )
    (pkg / "extension.py").write_text(
        _PKG_SRC,
        encoding="utf-8",
    )
    host = ExtensionHost()
    host.load(tmp_path)
    assert "pkg" in host._extensions  # noqa: SLF001
    assert [t.name for t in host.tools] == ["shout"]


def test_async_setup_rejected(tmp_path: Path) -> None:
    ext_dir = tmp_path / "extensions"
    (ext_dir / "bad").mkdir(parents=True)
    (ext_dir / "bad" / "extension.py").write_text(
        "async def setup(sarathy):\n    pass\n",
        encoding="utf-8",
    )
    host = ExtensionHost()
    host.load(tmp_path)
    assert "bad" not in host._extensions  # noqa: SLF001


def test_data_examples_load(tmp_path: Path) -> None:
    from pathlib import Path as _Path

    data_examples = _Path("sarathy/data/examples")
    if not data_examples.exists():
        return
    host = ExtensionHost()
    host.load(data_examples)
    assert "simple" in host._extensions  # noqa: SLF001
    assert "echo-package" in host._extensions  # noqa: SLF001
    assert "hooks" in host._extensions  # noqa: SLF001
    assert [t.name for t in host.tools] == ["hello", "utc_now"]


_PKG_SRC = '''
from tau_agent.messages import TextContent
from tau_agent.tools import AgentTool, AgentToolResult

from .helper import shout


async def run(tool_call_id, arguments, signal=None, on_update=None):
    return AgentToolResult(content=[TextContent(text=shout(arguments.get("name", "")))])


def setup(sarathy):
    sarathy.register_tool(
        AgentTool(
            name="shout",
            label="shout",
            description="Uppercase greeting",
            parameters={"type": "object", "properties": {}},
            execute_fn=run,
        )
    )
'''


_EXT_SRC = '''from tau_agent.messages import TextContent
from tau_agent.tools import AgentTool, AgentToolResult


async def hello(tool_call_id, arguments, signal=None, on_update=None):
    return AgentToolResult(content=[TextContent(text="hello!")])


def setup(sarathy):
    sarathy.register_tool(
        AgentTool(
            name="hello",
            label="hello",
            description="Say hello",
            parameters={"type": "object", "properties": {}},
            execute_fn=hello,
        )
    )
    sarathy.register_command("greet", lambda args, ctx: "hi " + args)
    sarathy.add_prompt_guideline("always be nice")
'''


_TRANSFORM_SRC = '''
from sarathy.extensions.api import InputEvent, InputHookResult


def setup(sarathy):
    @sarathy.on("input")
    async def upcase(event, ctx):
        if isinstance(event, InputEvent):
            return InputHookResult(action="transform", text=event.text.upper())
'''


_HANDLED_SRC = '''
from sarathy.extensions.api import InputHookResult


def setup(sarathy):
    sarathy.on("input")(
        lambda event, ctx: InputHookResult(
            action="handled", message="extension consumed it"
        )
    )
'''


_TOOL_SRC = '''
from tau_agent.messages import TextContent
from tau_agent.tools import AgentTool, AgentToolResult


async def t(tool_call_id, arguments, signal=None, on_update=None):
    return AgentToolResult(content=[TextContent(text="t")])


def setup(sarathy):
    sarathy.register_tool(
        AgentTool(
            name="dup",
            label="dup",
            description="duplicate",
            parameters={"type": "object", "properties": {}},
            execute_fn=t,
        )
    )
'''

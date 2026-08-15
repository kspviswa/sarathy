"""System prompt assembly via engine/context.build_system_prompt."""

from __future__ import annotations

from pathlib import Path

from sarathy.engine.context import BOOTSTRAP_FILES, build_system_prompt


def _prompt(workspace: Path, **kwargs) -> str:
    base = {
        "workspace": workspace,
        "memory_context": "## Long-term Memory\n- user likes coffee",
        "skills_summary": "- **greet**: a greeting skill",
        "always_skills": "# always greet",
        "tools": [],
        "extra_guidelines": ["never delete files"],
    }
    base.update(kwargs)
    return build_system_prompt(**base)


def test_includes_identity_and_memory(tmp_path: Path) -> None:
    text = _prompt(tmp_path)
    assert "You are Sarathy" in text
    assert "user likes coffee" in text
    assert "Current date:" in text


def test_tools_block_lists_tools(tmp_path: Path) -> None:
    from tau_agent.tools import AgentTool

    tool = AgentTool(
        name="read_file",
        label="read_file",
        description="Read a file",
        parameters={"type": "object", "properties": {}},
        execute_fn=None,
    )
    text = _prompt(tmp_path, tools=[tool])
    assert "read_file" in text


def test_bootstrap_sections(tmp_path: Path) -> None:
    for name in BOOTSTRAP_FILES[:2]:
        (tmp_path / name).write_text("bootstrap-content", encoding="utf-8")
    text = _prompt(tmp_path)
    assert "bootstrap-content" in text


def test_no_memory_when_empty(tmp_path: Path) -> None:
    text = _prompt(tmp_path, memory_context="")
    assert "Long-term Memory" not in text

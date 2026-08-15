"""System prompt assembly for sarathy (identity, memory, skills, self-docs)."""

from __future__ import annotations

import platform
from datetime import date
from pathlib import Path

from tau_agent.tools import AgentTool

PACKAGE_DATA = Path(__file__).resolve().parent.parent / "data"

BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"]


def build_system_prompt(
    *,
    workspace: Path,
    memory_context: str,
    skills_summary: str,
    always_skills: str,
    tools: list[AgentTool],
    extra_guidelines: list[str] | None = None,
) -> str:
    """Build sarathy's full system prompt."""
    identity = _identity(workspace)
    bootstrap = _bootstrap(workspace)

    sections: list[str] = [identity]
    if bootstrap:
        sections.append(bootstrap)
    if memory_context:
        sections.append(f"# Memory\n\n{memory_context}")
    if always_skills:
        sections.append(f"# Active Skills\n\n{always_skills}")
    if skills_summary:
        sections.append(
            "# Skills\n\n"
            "The following skills extend your capabilities. To use a skill, read its SKILL.md "
            "file using the read_file tool.\n\n"
            f"{skills_summary}"
        )
    sections.append("# Available Tools\n\n" + _tools_block(tools))
    sections.append(format_sarathy_documentation())
    if extra_guidelines:
        sections.append("# Extension Guidelines\n\n" + "\n".join(f"- {g}" for g in extra_guidelines))
    sections.append(f"Current date: {date.today().isoformat()}")

    return "\n\n---\n\n".join(sections)


def format_sarathy_documentation() -> str:
    """Pi-style routing hints to sarathy's installed reference material.

    This is the "teaching" block: it tells the model where to find sarathy's
    bundled docs and example extensions and to read them before implementing or
    modifying extensions/skills.
    """
    readme = _fmt(PACKAGE_DATA / "docs" / "README.md")
    examples = _fmt(PACKAGE_DATA / "examples")
    return (
        "# Extension Capability\n\n"
        f"Sarathy can extend itself. Reference documentation is installed locally:\n"
        f"- Guide to extending sarathy (extensions, tools, commands, skills): {readme}\n"
        f"- Working example extensions: {examples}\n"
        f"- When asked to create or modify an extension, read {_fmt(PACKAGE_DATA / 'docs' / 'EXTENSIONS.md')} "
        f"and the example files under {examples} first, then follow them.\n"
        "- When asked about skills, read docs/SKILLS.md under the installed data/docs directory"
    )


def _tools_block(tools: list[AgentTool]) -> str:
    if not tools:
        return "(none)"
    return "\n".join(
        f"- {tool.name}: {tool.prompt_snippet or tool.description}" for tool in tools
    )


def _identity(workspace: Path) -> str:
    ws = workspace.expanduser().resolve()
    system = platform.system()
    runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"

    return f"""# sarathy 🪆

You are Sarathy — a personal AI assistant and mentor.

## Runtime
{runtime}

## Workspace
Your workspace is at: {ws}
- Long-term memory: {ws}/memory/MEMORY.md (write important facts there; read it at the start of sessions)
- Custom skills: {ws}/skills/{{skill-name}}/SKILL.md
- Extensions: read the guide at docs/EXTENSIONS.md before creating one

## sarathy Guidelines
- State intent before tool calls, but NEVER predict or claim results before receiving them.
- Before modifying a file, read it first. Do not assume files or directories exist.
- After writing or editing a file, re-read it if accuracy matters.
- If a tool call fails, analyze the error before retrying with a different approach.
- Ask for clarification when the request is ambiguous."""


def _bootstrap(workspace: Path) -> str:
    parts = []
    for filename in BOOTSTRAP_FILES:
        path = workspace / filename
        if path.exists():
            parts.append(f"## {filename}\n\n{path.read_text(encoding='utf-8')}")
    return "\n\n".join(parts)


def _fmt(path: Path) -> str:
    return str(path).replace("\\", "/")

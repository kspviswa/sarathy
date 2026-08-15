"""/-command registry: builtins plus extension commands for REPL and web."""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True, slots=True)
class BuiltinCommand:
    name: str
    description: str
    handler: Callable[..., str]

    def execute(self, context: "CommandContext") -> str:
        result = self.handler(context)
        if hasattr(result, "__await__"):
            raise TypeError("builtin command handlers must be sync")
        return result or ""


@dataclass(slots=True)
class CommandContext:
    """Context provided to every builtin command handler."""

    engine: Any
    session_id: str
    arguments: list[str]
    raw: str


def parse_command_line(line: str) -> tuple[str, list[str]] | None:
    """Return (command_name, args) for a /-prefixed line, else None."""
    text = line.strip()
    if not text.startswith("/"):
        return None
    try:
        parts = shlex.split(text[1:])
    except ValueError:
        parts = text[1:].split()
    if not parts:
        return None
    return parts[0].lower(), parts[1:]


class CommandRegistry:
    """Merged view over builtin and extension slash commands."""

    def __init__(self, engine) -> None:
        self.engine = engine
        self._builtins: dict[str, BuiltinCommand] = {}
        self._register_stdlib()

    def _register_stdlib(self) -> None:
        self.register(
            "help",
            "Show available commands.",
            lambda ctx: "Commands: " + ", ".join(sorted(self.names()))
            if not ctx.arguments
            else f"/{ctx.arguments[0]}: {self.describe(ctx.arguments[0])}",
        )
        self.register("status", "Show engine status.", lambda ctx: self.engine_status(ctx))
        self.register("sessions", "List loaded sessions.", lambda ctx: self.sessions_list(ctx))
        self.register("skills", "List available skills.", lambda ctx: self.skills_list(ctx))
        self.register("extensions", "List loaded extensions.", lambda ctx: self.extensions_list(ctx))
        self.register("model", "Show the active model.", lambda ctx: f"{self.engine.model} via {self.engine.provider_name}")
        self.register("config", "Print the active config.", lambda ctx: self.config_summary(ctx))

    def register(self, name: str, description: str, handler: Callable[[CommandContext], str]) -> None:
        self._builtins[name] = BuiltinCommand(name=name, description=description, handler=handler)

    def names(self) -> list[str]:
        return sorted(set(self._builtins) | set(self.engine.extensions.commands))

    def describe(self, name: str) -> str:
        if name in self._builtins:
            return self._builtins[name].description
        return "Extension-provided command."

    def is_command(self, line: str) -> bool:
        return parse_command_line(line) is not None

    def as_list(self) -> list[dict]:
        return [
            {"name": name, "description": self.describe(name)}
            for name in self.names()
        ]

    async def handle(self, session_id: str, raw: str) -> str | None:
        """Execute a /-command; returns response text or None if not a command."""
        parsed = parse_command_line(raw)
        if parsed is None:
            return None
        name, args = parsed
        ctx = CommandContext(engine=self.engine, session_id=session_id, arguments=args, raw=raw)

        if name in self._builtins:
            return self._builtins[name].execute(ctx)

        # extension commands
        if name in self.engine.extensions.commands or name in self.engine.extensions._aliases:
            return await self.engine.extensions.run_command(name, " ".join(args))

        return f"Unknown command /{name}. Try /help."

    # ------------------------------------------------------------------ builtin implementations
    def engine_status(self, ctx: CommandContext) -> str:
        return (
            f"model={self.engine.model} provider={self.engine.provider_name} "
            f"sessions={len(self.engine.sessions)} extensions={len(self.engine.extensions.tools)}"
        )

    def sessions_list(self, ctx: CommandContext) -> str:
        running = sum(1 for s in self.engine.sessions.values() if s.running)
        return f"{len(self.engine.sessions)} session(s), {running} running."

    def skills_list(self, ctx: CommandContext) -> str:
        try:
            names = [s["name"] for s in self.engine.skills_loader.list_skills()]
        except Exception:  # noqa: BLE001
            names = []
        return "Skills: " + (", ".join(names) if names else "none")

    def extensions_list(self, ctx: CommandContext) -> str:
        exts = self.engine.extensions.list_extensions()
        if not exts:
            return "No extensions loaded."
        return "Extensions: " + ", ".join(e["name"] for e in exts)

    def config_summary(self, ctx: CommandContext) -> str:
        return f"provider={self.engine.provider_name} workspace={self.engine.workspace}"

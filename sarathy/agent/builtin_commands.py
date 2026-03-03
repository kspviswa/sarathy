"""Built-in commands for sarathy."""

from dataclasses import dataclass


@dataclass
class BuiltinCommand:
    """Information about a built-in command."""

    name: str
    description: str
    subcommands: list[str]
    has_status: bool = False


BUILTIN_COMMANDS = {
    "new": BuiltinCommand(
        name="new",
        description="Start a new conversation (saves to memory)",
        subcommands=[],
    ),
    "clear": BuiltinCommand(
        name="clear",
        description="Clear session without saving",
        subcommands=[],
    ),
    "stop": BuiltinCommand(
        name="stop",
        description="Stop the current task",
        subcommands=[],
    ),
    "think": BuiltinCommand(
        name="think",
        description="Set thinking effort level",
        subcommands=["status", "off", "low", "medium", "high", "xhigh"],
        has_status=True,
    ),
    "verbose": BuiltinCommand(
        name="verbose",
        description="Toggle token speed display",
        subcommands=["status", "true", "false"],
        has_status=True,
    ),
    "streaming": BuiltinCommand(
        name="streaming",
        description="Toggle streaming mode",
        subcommands=["status", "true", "false"],
        has_status=True,
    ),
    "context": BuiltinCommand(
        name="context",
        description="Show context usage",
        subcommands=[],
    ),
    "remember": BuiltinCommand(
        name="remember",
        description="Save important information to memory",
        subcommands=[],
    ),
    "help": BuiltinCommand(
        name="help",
        description="Show available commands",
        subcommands=[],
    ),
}


def get_help_text(
    cmd_name: str, description: str, subcommands: list[str], has_status: bool = False
) -> str:
    """Generate help text for a command."""
    lines = [f"📖 /{cmd_name} — {description}"]

    if subcommands:
        lines.append("")
        lines.append(f"Usage: /{cmd_name} <subcommand>")
        lines.append("")
        lines.append("Subcommands:")
        for sub in subcommands:
            if sub == "status" and has_status:
                lines.append(f"  {sub} — Show current status")
            elif sub == "true":
                lines.append(f"  {sub} — Enable")
            elif sub == "false":
                lines.append(f"  {sub} — Disable")
            else:
                lines.append(f"  {sub}")

    return "\n".join(lines)


def get_all_builtin_commands() -> list[BuiltinCommand]:
    """Get all built-in commands."""
    return list(BUILTIN_COMMANDS.values())

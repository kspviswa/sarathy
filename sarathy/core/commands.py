"""Command manager for dynamic slash commands from skills."""

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from loguru import logger


@dataclass
class CommandInfo:
    """Information about a registered command."""

    name: str
    description: str
    skill_name: str
    help_text: str
    handler: Callable[..., Awaitable[str]] | None = None


class CommandManager:
    """
    Manages dynamic slash commands from skills.

    This class handles registration and execution of commands
    that are defined in skill SKILL.md files.
    """

    def __init__(self):
        self._commands: dict[str, CommandInfo] = {}
        self._update_callbacks: list[Callable[[], Awaitable[None]]] = []

    def register_command(
        self,
        name: str,
        description: str,
        skill_name: str,
        help_text: str = "",
        handler: Callable[..., Awaitable[str]] | None = None,
    ) -> None:
        """Register a command from skill metadata."""
        self._commands[name] = CommandInfo(
            name=name,
            description=description,
            skill_name=skill_name,
            help_text=help_text,
            handler=handler,
        )
        logger.debug(f"Registered command: /{name} from skill {skill_name}")

    def unregister_command(self, name: str) -> None:
        """Remove a command."""
        if name in self._commands:
            skill_name = self._commands[name].skill_name
            del self._commands[name]
            logger.debug(f"Unregistered command: /{name} from skill {skill_name}")

    def get_command(self, name: str) -> CommandInfo | None:
        """Get a command by name."""
        return self._commands.get(name)

    def get_all_commands(self) -> list[CommandInfo]:
        """Get all registered commands."""
        return list(self._commands.values())

    def get_command_names(self) -> list[str]:
        """Get list of registered command names."""
        return list(self._commands.keys())

    def has_command(self, name: str) -> bool:
        """Check if a command is registered."""
        return name in self._commands

    def get_command_help(self, name: str) -> str | None:
        """Get help text for a command."""
        cmd = self._commands.get(name)
        return cmd.help_text if cmd else None

    def sync_from_skill_manager(self, skill_manager) -> None:
        """Sync commands from a SkillManager instance."""
        # Clear existing skill commands (but keep built-in ones if we had them)
        self._commands.clear()

        # Get commands from skill manager
        for cmd in skill_manager.get_commands():
            self.register_command(
                name=cmd.name,
                description=cmd.description,
                skill_name=cmd.skill_name,
                help_text=cmd.help_text,
            )

        logger.info(f"Synced {len(self._commands)} commands from skills")

    def on_update(self, callback: Callable[[], Awaitable[None]]):
        """Register a callback to be called when commands are updated."""
        self._update_callbacks.append(callback)

    async def notify_update(self):
        """Notify all registered callbacks of an update."""
        for callback in self._update_callbacks:
            try:
                await callback()
            except Exception as e:
                logger.error(f"Command update callback failed: {e}")

    def __len__(self) -> int:
        return len(self._commands)

    def __contains__(self, name: str) -> bool:
        return name in self._commands

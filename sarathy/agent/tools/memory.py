"""Memory tool for managing MEMORY.md and USER.md."""

from __future__ import annotations

from typing import Any

from sarathy.agent.tools.base import Tool
from sarathy.session.memory import MemoryStore


class MemoryTool(Tool):
    """Manage long-term memory (facts) and user profile."""

    def __init__(self, memory_store: MemoryStore):
        self._store = memory_store

    @property
    def name(self) -> str:
        return "memory"

    @property
    def description(self) -> str:
        return (
            "Manage long-term memory and user profile. Use 'memory' target for facts "
            "about the user, environment, projects, conventions, and corrections. "
            "Use 'user' target for user persona, communication style, preferences, "
            "and workflow habits. Add when you learn something durable; skip trivial "
            "or easily re-discovered info."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["add", "replace", "remove", "show"],
                    "description": "Operation to perform",
                },
                "target": {
                    "type": "string",
                    "enum": ["memory", "user"],
                    "description": "'memory' for MEMORY.md (facts), 'user' for USER.md (profile)",
                },
                "content": {
                    "type": "string",
                    "description": "Text to add (for add) or replacement text (for replace)",
                },
                "old_text": {
                    "type": "string",
                    "description": "Exact text to replace or remove",
                },
            },
            "required": ["action", "target"],
        }

    async def execute(self, **kwargs: Any) -> str:
        action = kwargs.get("action", "")
        target = kwargs.get("target", "memory")
        content = kwargs.get("content", "")
        old_text = kwargs.get("old_text", "")

        is_user = target == "user"
        current = self._store.read_user() if is_user else self._store.read_memory()
        max_size = self._store.user_max_size if is_user else self._store.memory_max_size

        if action == "show":
            if not current:
                return f"{'User profile' if is_user else 'Memory'} is empty."
            return current

        if action == "add":
            if not content:
                return "Error: 'content' is required for add action."
            if len(current) + len(content) + 2 > max_size:
                return (
                    f"Error: {target} is at {len(current)}/{max_size} chars. "
                    f"This entry ({len(content)} chars) would exceed the limit. "
                    f"Use 'replace' to merge overlapping entries or 'remove' stale ones first."
                )
            if content.strip() in current:
                return f"Entry already exists in {target}."
            updated = f"{current}\n- {content.strip()}" if current.strip() else f"- {content.strip()}"
            self._write(updated, is_user)
            return f"Added to {target}."

        if action == "replace":
            if not old_text or not content:
                return "Error: both 'old_text' and 'content' are required for replace."
            if old_text not in current:
                return f"Error: old_text not found in {target}."
            updated = current.replace(old_text, content, 1)
            self._write(updated, is_user)
            return f"Replaced in {target}."

        if action == "remove":
            if not old_text:
                return "Error: 'old_text' is required for remove."
            if old_text not in current:
                return f"Error: old_text not found in {target}."
            updated = current.replace(old_text, "", 1).strip()
            self._write(updated, is_user)
            return f"Removed from {target}."

        return f"Error: unknown action '{action}'."

    def _write(self, content: str, is_user: bool) -> None:
        content = self._store.enforce_max_size(content, is_user=is_user)
        if is_user:
            self._store.write_user(content)
        else:
            self._store.write_memory(content)

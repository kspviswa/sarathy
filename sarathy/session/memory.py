"""Memory file management with clean separation of concerns."""

import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from loguru import logger


class MemoryStore:
    """Manages MEMORY.md (factual memory) and USER.md (user profile)."""

    def __init__(
        self,
        workspace: Optional[Path] = None,
        memory_max_size: int = 2200,
        user_max_size: int = 1375,
    ):
        if workspace is None:
            workspace = Path("/root/.sarathy/workspace")
            logger.warning("MemoryStore using fallback workspace: {}", workspace)
        self.workspace = workspace
        self.memory_file = self.workspace / "memory" / "MEMORY.md"
        self.user_file = self.workspace / "memory" / "USER.md"
        self.history_file = self.workspace / "memory" / "HISTORY.md"
        self.memory_max_size = memory_max_size
        self.user_max_size = user_max_size
        # Backward compat
        self.max_size = memory_max_size

    # --- MEMORY.md ---

    def read_memory(self) -> str:
        """Read current MEMORY.md content."""
        if self.memory_file.exists():
            return self.memory_file.read_text(encoding="utf-8")
        return ""

    def write_memory(self, content: str) -> None:
        """Write updated MEMORY.md content."""
        from sarathy.utils.helpers import ensure_dir

        ensure_dir(self.memory_file.parent)
        self.memory_file.write_text(content, encoding="utf-8")

    def get_memory_context(self) -> str:
        """Return formatted memory context for system prompt."""
        long_term = self.read_memory()
        return f"## Long-term Memory\n{long_term}" if long_term else ""

    # --- USER.md ---

    def read_user(self) -> str:
        """Read current USER.md content."""
        if self.user_file.exists():
            return self.user_file.read_text(encoding="utf-8")
        return ""

    def write_user(self, content: str) -> None:
        """Write updated USER.md content."""
        from sarathy.utils.helpers import ensure_dir

        ensure_dir(self.user_file.parent)
        self.user_file.write_text(content, encoding="utf-8")

    def get_user_context(self) -> str:
        """Return formatted user profile for system prompt."""
        profile = self.read_user()
        return f"## User Profile\n{profile}" if profile else ""

    # --- Shared ---

    def enforce_max_size(self, content: str, is_user: bool = False) -> str:
        """Enforce max size, protecting HARD LESSONS for memory."""
        max_size = self.user_max_size if is_user else self.memory_max_size
        if len(content) <= max_size:
            return content

        if is_user:
            lines = content.split("\n")
            cutoff = int(len(lines) * 0.8)
            return "\n".join(lines[-cutoff:])[:max_size]

        sections = content.split("\n\n## ")
        hard_lessons = [s for s in sections if "HARD LESSONS" in s]
        others = [s for s in sections if "HARD LESSONS" not in s]

        if hard_lessons:
            protected = "\n\n## ".join(hard_lessons)
            protected_len = len(protected)
            remaining = max_size - protected_len - 50
            if remaining > 0 and others:
                recent = others[-3:] if len(others) > 3 else others
                result = "\n\n## ".join([others[0]] + recent + hard_lessons)
            else:
                result = protected
        else:
            lines = content.split("\n")
            cutoff = int(len(lines) * 0.8)
            result = "\n".join(lines[-cutoff:])

        return (
            result
            if len(result) <= max_size
            else "\n\n## ".join(hard_lessons + [others[-1]] if others else hard_lessons)
        )

    def clean_conversation_logs(self, content: str) -> str:
        """Remove conversation logs from MEMORY.md, keep only facts/rules."""
        lines = content.split("\n")
        cleaned_lines = []

        for line in lines:
            if "## Session" in line or "## Conversation" in line:
                continue
            if re.match(r"^## \d{4}-\d{2}-\d{2}", line):
                continue
            cleaned_lines.append(line)

        return "\n".join(cleaned_lines)

    # --- Legacy migration ---

    def read_history(self) -> str:
        """Read HISTORY.md content (for migration)."""
        if self.history_file.exists():
            return self.history_file.read_text(encoding="utf-8")
        return ""

    def migrate_history_to_memory(self, history_content: str) -> None:
        """Migrate key facts from HISTORY.md to MEMORY.md."""
        facts = self._extract_facts_from_history(history_content)

        current_memory = self.read_memory()
        timestamp = datetime.now().isoformat()
        new_memory = f"{current_memory}\n\n## {timestamp}"
        for fact in facts:
            new_memory += f"\n- {fact}"

        self.write_memory(new_memory)

    def _extract_facts_from_history(self, history_content: str) -> list[str]:
        """Extract key facts from HISTORY.md."""
        facts = []

        for line in history_content.split("\n"):
            if "iOS" in line or "macOS" in line:
                facts.append(line.strip())
            elif "AI" in line or "ML" in line:
                facts.append(line.strip())
            elif "5G" in line or "telco" in line.lower():
                facts.append(line.strip())

        return facts

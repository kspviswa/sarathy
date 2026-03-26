"""Memory file management with clean separation of concerns."""

import re
from datetime import datetime
from pathlib import Path


class MemoryStore:
    """Manages MEMORY.md with facts-only approach."""

    def __init__(self, max_size: int = 2000):
        self.max_size = max_size
        self.memory_file = Path("/root/.sarathy/workspace/memory/MEMORY.md")
        self.history_file = Path("/root/.sarathy/workspace/memory/HISTORY.md")

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

    def read_history(self) -> str:
        """Read HISTORY.md content (for migration)."""
        if self.history_file.exists():
            return self.history_file.read_text(encoding="utf-8")
        return ""

    def migrate_history_to_memory(self, history_content: str) -> None:
        """Migrate key facts from HISTORY.md to MEMORY.md."""
        # Extract key facts from history (can use regex or simple parsing)
        facts = self._extract_facts_from_history(history_content)

        current_memory = self.read_memory()
        timestamp = datetime.now().isoformat()
        new_memory = f"{current_memory}\n\n## {timestamp}"
        for fact in facts:
            new_memory += f"\n- {fact}"

        self.write_memory(new_memory)

    def _extract_facts_from_history(self, history_content: str) -> list[str]:
        """Extract key facts from HISTORY.md."""
        # Simple fact extraction (can be enhanced)
        facts = []

        for line in history_content.split("\n"):
            if "iOS" in line or "macOS" in line:
                facts.append(line.strip())
            elif "AI" in line or "ML" in line:
                facts.append(line.strip())
            elif "5G" in line or "telco" in line.lower():
                facts.append(line.strip())

        return facts

    def enforce_max_size(self, content: str) -> str:
        """Enforce max size on MEMORY.md."""
        if len(content) > self.max_size:
            # Keep most recent facts (last 80%)
            lines = content.split("\n")
            cutoff = int(len(lines) * 0.8)
            return "\n".join(lines[-cutoff:])
        return content

    def clean_conversation_logs(self, content: str) -> str:
        """Remove conversation logs from MEMORY.md, keep only facts/rules."""
        lines = content.split("\n")
        cleaned_lines = []

        for line in lines:
            # Skip conversation log markers
            if "## Session" in line or "## Conversation" in line:
                continue
            # Skip timestamped sections that look like logs
            if re.match(r"^## \d{4}-\d{2}-\d{2}", line):
                continue
            # Keep everything else (facts, rules, preferences)
            cleaned_lines.append(line)

        return "\n".join(cleaned_lines)

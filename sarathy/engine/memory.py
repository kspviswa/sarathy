"""Memory management and background fact extraction for sarathy."""

from __future__ import annotations

import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger
from tau_agent.messages import AssistantMessage, TextContent, UserMessage

from sarathy.utils.helpers import ensure_dir

CONSOLIDATION_PROMPT = """You are Sarathy's memory consolidator. Read the recent conversation excerpt
below and extract durable, generalizable facts and preferences about the user and this workspace.
Rules:
- Only keep facts that generalize across sessions. Skip one-off task details.
- Output as a flat markdown list of bullets, one fact per line, starting with "- ".
- Do NOT invent facts. If there is nothing durable, output "(nothing)".
- Keep each fact under 120 characters.

Conversation excerpt:
{excerpt}
"""


def _newest_first(sections: list[str], budget: int) -> list[str]:
    """Keep sections newest-first within ``budget`` chars; newest always wins.

    A single section that alone exceeds the budget is truncated to fit rather
    than dropped entirely.
    """
    kept: list[str] = []
    for section in reversed(sections):
        candidate = "\n\n## ".join([section] + kept)
        if len(candidate) > budget:
            if not kept:
                kept.append(section[: max(0, budget)])
            continue
        kept.insert(0, section)
    return kept


class Memory:
    """Owns MEMORY.md: read, write, size-cap with HARD LESSONS protection."""

    def __init__(self, workspace: Path, max_size: int = 3000):
        self.workspace = Path(workspace)
        self.memory_file = self.workspace / "memory" / "MEMORY.md"
        self.max_size = max_size

    def read(self) -> str:
        return self.memory_file.read_text(encoding="utf-8") if self.memory_file.exists() else ""

    def write(self, content: str) -> None:
        ensure_dir(self.memory_file.parent)
        self.memory_file.write_text(content, encoding="utf-8")

    def context_block(self) -> str:
        content = self.read()
        return f"## Long-term Memory\n{content}" if content else ""

    def add_facts(self, facts: list[str]) -> int:
        """Append new facts (deduped) under a timestamped section."""
        facts = [f.strip().lstrip("- ").rstrip(".") for f in facts]
        facts = [f for f in facts if f and f.lower() not in {"(nothing)", "nan"}]
        if not facts:
            return 0

        current = self.read()
        existing = set(self._facts_only(current))
        seen: set[str] = set()
        fresh = []
        for f in facts:
            if f in existing or f in seen:
                continue
            seen.add(f)
            fresh.append(f)
        if not fresh:
            return 0

        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
        block = f"\n## {stamp}\n" + "\n".join(f"- {f}" for f in fresh)
        self.write(self.enforce_max_size((current.rstrip() + block).strip()))
        return len(fresh)

    def _facts_only(self, content: str) -> list[str]:
        return re.findall(r"^-\s+(.+)$", content, flags=re.MULTILINE)

    def enforce_max_size(self, content: str) -> str:
        if len(content) <= self.max_size:
            return content
        sections = content.split("\n\n## ")
        hard = [s for s in sections if "HARD LESSONS" in s]
        other = [s for s in sections if "HARD LESSONS" not in s]
        if hard:
            protected = "\n\n## ".join(hard)
            budget = self.max_size - len(protected) - 50
            kept = _newest_first(other, budget)
            return (("\n\n## ".join(kept) + "\n\n## " + protected) if kept else protected)
        return "\n\n## ".join(_newest_first(sections, self.max_size)) or content[: self.max_size]


class MemoryArchivist:
    """Periodically summarizes recent session messages into MEMORY.md."""

    def __init__(
        self,
        memory: Memory,
        provider,
        model: str,
        interval_s: int = 1800,
        enabled: bool = True,
        min_messages: int = 8,
    ):
        self.memory = memory
        self.provider = provider
        self.model = model
        self.interval_s = interval_s
        self.enabled = enabled
        self.min_messages = min_messages
        self._task: asyncio.Task | None = None
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._on_sweep: list = []

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if self.enabled and not self.running:
            self._task = asyncio.create_task(self._loop())
            logger.info("Memory archivist started (every {}s)", self.interval_s)

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def consolidate(self, excerpt: str) -> int:
        """Run one extraction against the provider and merge into MEMORY.md."""
        if not excerpt.strip():
            return 0
        try:
            facts = await asyncio.to_thread(self._call_model, excerpt)
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory consolidation failed: {}", exc)
            return 0
        return self.memory.add_facts([f for f in facts if f])

    def _call_model(self, excerpt: str) -> list[str]:
        async def _inner() -> list[str]:
            lines: list[str] = []
            async for event in self.provider.stream_response(
                model=self.model,
                system="You extract durable memory facts.",
                messages=[UserMessage(content=CONSOLIDATION_PROMPT.format(excerpt=excerpt[:8000]))],
                tools=[],
            ):
                if isinstance(event, AssistantMessage):
                    lines = [b.text for b in event.content if isinstance(b, TextContent)]
            return lines

        return asyncio.run(_inner())

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval_s)
            try:
                await self._pending_consolidations()
            except Exception as exc:  # noqa: BLE001
                logger.warning("archivist sweep failed: {}", exc)

    async def _pending_consolidations(self) -> None:
        """Hook for the engine to feed recent session excerpts (see engine)."""
        for callback in self._on_sweep:
            try:
                await callback()
            except Exception as exc:  # noqa: BLE001
                logger.warning("archivist sweep hook failed: {}", exc)

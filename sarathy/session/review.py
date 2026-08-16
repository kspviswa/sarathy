"""Background reviewer for idle-time memory and skill learning.

After each conversation turn, the agent enqueues a review task. A background
worker processes the queue only when the LLM is idle (no active conversation),
with a configurable cooldown. This avoids parallel LLM calls that would degrade
performance on local models.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from loguru import logger

from sarathy.session.memory import MemoryStore

REVIEW_SYSTEM_PROMPT = """You are a memory and skill review assistant. Your task is to analyze a conversation and decide what should be saved for future sessions.

## What to save to memory (MEMORY.md — facts about the world)
- User corrections: "Don't do X", "Always do Y"
- Environment facts: server details, project structure, tool versions
- Conventions: code style, naming patterns, workflow preferences
- Completed work that changed state: "Migrated DB to PostgreSQL"

## What to save to user profile (USER.md — who the user is)
- Communication style preferences
- Technical skill level and domain expertise
- Workflow habits and pet peeves
- Personal context that affects how you should interact

## What to save as skills (reusable workflows)
- Multi-step procedures (5+ steps) that will recur
- Non-obvious debugging paths or workarounds
- Tool-usage patterns specific to this user's environment

## What to skip
- Trivial or one-off information
- Things easily re-discovered (web search, man pages)
- Raw data, code blocks, log output
- Session-specific ephemera (temp paths, debugging context)
- Information already in existing memory or skills

## Response format
Return a JSON object (no markdown fencing):
{
  "memory": ["fact to add to MEMORY.md"],
  "user": ["trait to add to USER.md"],
  "skills": [{"name": "skill-name", "description": "what it does", "content": "full SKILL.md content"}],
  "nothing_found": false
}

If nothing significant was discussed, set "nothing_found" to true with empty arrays."""


class BackgroundReviewer:
    """Processes conversation reviews when the LLM is idle."""

    def __init__(
        self,
        provider: Any,
        memory_store: MemoryStore | None = None,
        workspace: Any = None,
        enabled: bool = True,
        cooldown_seconds: int = 5,
        max_queue_size: int = 5,
    ):
        self._provider = provider
        self._workspace = Path(str(workspace)) if workspace else Path.home() / ".sarathy" / "workspace"
        self._memory = memory_store or MemoryStore(workspace=self._workspace)
        self._enabled = enabled
        self._cooldown = cooldown_seconds
        self._max_queue = max_queue_size
        self._queue: list[dict[str, Any]] = []
        self._llm_idle = asyncio.Event()
        self._llm_idle.set()
        self._worker: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the background worker."""
        if not self._enabled:
            logger.info("Background review disabled")
            return
        self._worker = asyncio.create_task(self._worker_loop())
        logger.info("Background review worker started (cooldown: {}s)", self._cooldown)

    async def stop(self) -> None:
        """Stop the worker gracefully."""
        if self._worker:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass

    def mark_busy(self) -> None:
        """Called before LLM call — review cannot start."""
        self._llm_idle.clear()

    def mark_idle(self) -> None:
        """Called after LLM call completes — review can start after cooldown."""
        self._llm_idle.set()

    async def enqueue(self, messages: list[dict[str, Any]], session_key: str) -> None:
        """Add a conversation snapshot for review. Called after each turn."""
        if not self._enabled:
            return
        if len(self._queue) >= self._max_queue:
            self._queue.pop(0)
        self._queue.append({"messages": messages, "session_key": session_key})

    async def _worker_loop(self) -> None:
        """Process reviews when LLM is idle."""
        while True:
            try:
                if not self._queue:
                    await asyncio.sleep(1)
                    continue

                await self._llm_idle.wait()
                await asyncio.sleep(self._cooldown)

                if not self._llm_idle.is_set():
                    continue

                task = self._queue.pop(0)
                try:
                    await self._process_review(task)
                except Exception as e:
                    logger.error("Background review failed: {}", e)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Background review worker error: {}", e)
                await asyncio.sleep(5)

    async def _process_review(self, task: dict[str, Any]) -> None:
        """Send conversation to LLM for memory/skill extraction."""
        messages = task["messages"]
        session_key = task.get("session_key", "unknown")

        conversation_text = self._format_conversation(messages)
        if not conversation_text.strip():
            return

        try:
            response = await self._provider.chat(
                messages=[
                    {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                    {"role": "user", "content": f"Review this conversation:\n\n{conversation_text}"},
                ],
            )
        except Exception as e:
            logger.error("Review LLM call failed: {}", e)
            return

        content = response.content if hasattr(response, "content") else str(response)

        try:
            result = json.loads(content)
        except json.JSONDecodeError:
            logger.warning("Failed to parse review response as JSON: {}", content[:200])
            return

        if not isinstance(result, dict) or result.get("nothing_found"):
            logger.debug("No learnings from session {}", session_key)
            return

        saved = []
        for fact in result.get("memory", []):
            current = self._memory.read_memory()
            if fact.strip() and fact.strip() not in current:
                updated = f"{current}\n- {fact.strip()}" if current.strip() else f"- {fact.strip()}"
                updated = self._memory.enforce_max_size(updated, is_user=False)
                self._memory.write_memory(updated)
                saved.append(f"memory: {fact[:60]}")

        for trait in result.get("user", []):
            current = self._memory.read_user()
            if trait.strip() and trait.strip() not in current:
                updated = f"{current}\n- {trait.strip()}" if current.strip() else f"- {trait.strip()}"
                updated = self._memory.enforce_max_size(updated, is_user=True)
                self._memory.write_user(updated)
                saved.append(f"user: {trait[:60]}")

        for skill in result.get("skills", []):
            name = skill.get("name", "")
            content_text = skill.get("content", "")
            if name and content_text:
                skill_dir = self._workspace / "skills" / self._slugify(name)
                skill_file = skill_dir / "SKILL.md"
                if not skill_file.exists():
                    skill_dir.mkdir(parents=True, exist_ok=True)
                    skill_file.write_text(content_text, encoding="utf-8")
                    saved.append(f"skill: {name}")

        if saved:
            logger.info("Background review saved: {}", ", ".join(saved))

    def _format_conversation(self, messages: list[dict[str, Any]]) -> str:
        """Format messages for the review prompt."""
        lines = []
        for m in messages:
            role = m.get("role", "?")
            content = m.get("content", "")
            if role in ("user", "assistant") and content:
                lines.append(f"{role.upper()}: {content[:500]}")
        return "\n".join(lines[-40:])

    @staticmethod
    def _slugify(name: str) -> str:
        import re

        slug = name.lower().strip()
        slug = re.sub(r"[^a-z0-9\s-]", "", slug)
        slug = re.sub(r"[\s]+", "-", slug)
        return slug[:64].strip("-")

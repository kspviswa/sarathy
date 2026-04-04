"""Background thread for memory archival using LLM fact extraction."""

import asyncio
import json
import threading
from datetime import datetime
from pathlib import Path

from loguru import logger

from sarathy.config.schema import Config
from sarathy.session.manager import Session
from sarathy.session.memory import MemoryStore

SYSTEM_PROMPT = """You are a memory archival assistant. Your task is to analyze conversation transcripts and extract:

1. **Facts** - Information about the user, environment, projects, or anything noteworthy
2. **Preferences** - User's communication style, workflow habits, technical preferences
3. **Lessons Learned** - Corrections, conventions, or important notes from the conversation
4. **Skills** - Reusable multi-step workflows worth encoding for future reuse

## Save These (Proactively):
- User preferences: "I prefer TypeScript over JavaScript"
- Environment facts: "Server runs Debian 12 with PostgreSQL 16"
- Corrections: "Don't use sudo for Docker commands, user is in docker group"
- Conventions: "Project uses tabs, 120-char line width"
- Reusable workflows: "To deploy to prod: build → tag → push → kubectl rollout"

## Skip These:
- Trivial/obvious info, raw data dumps, one-off debugging, session-specific ephemera

## Response Format

Return a JSON object with this structure:
{
  "facts": ["fact 1"],
  "preferences": ["preference 1"],
  "lessons": ["Never do X because Y"],
  "skills": ["workflow name: step1 → step2 → step3 (used for: X)"],
  "nothing_found": false
}

If nothing worth saving is found, set "nothing_found" to true and use empty arrays."""


class SessionArchivalManager:
    """Manages session archival with background thread using LLM fact extraction."""

    def __init__(self, config: Config, session_manager, bus=None):
        self.config = config.agents.memory_archival
        self.enabled = self.config.enabled
        self.interval_s = self.config.interval_seconds
        self.max_session_size = self.config.max_session_size
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self.session_manager = session_manager
        self.bus = bus

        workspace = Path(config.agents.defaults.workspace).expanduser()
        self.workspace = workspace
        self.memory_store = MemoryStore(workspace=workspace, max_size=2000)

        self._provider = self._create_provider(config)

    def _create_provider(self, config: Config):
        """Create LLM provider using the same configuration as the main agent."""
        from sarathy.providers.custom_provider import CustomProvider
        from sarathy.providers.litellm_provider import LiteLLMProvider
        from sarathy.providers.registry import find_by_name

        model = config.agents.defaults.model
        provider_name = config.get_provider_name()
        p = config.get_provider()
        api_base = config.get_api_base()

        if api_base and api_base.endswith("/v1"):
            return CustomProvider(
                api_key=p.api_key if p else "no-key",
                api_base=api_base,
                default_model=model,
            )
        elif provider_name == "custom":
            return CustomProvider(
                api_key=p.api_key if p else "no-key",
                api_base=api_base or "http://localhost:8000/v1",
                default_model=model,
            )
        else:
            spec = find_by_name(provider_name)
            if spec and spec.is_local:
                pass
            elif (
                not model.startswith("bedrock/")
                and not (p and p.api_key)
                and not (spec and spec.is_oauth)
            ):
                raise RuntimeError("No API key configured")

            return LiteLLMProvider(
                api_key=p.api_key if p else None,
                api_base=config.get_api_base(),
                default_model=model,
                extra_headers=p.extra_headers if p else None,
                provider_name=provider_name,
            )

    def start(self):
        """Start archival thread."""
        if not self.enabled:
            logger.info("Session archival disabled in config")
            return

        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="SessionArchival")
        self._thread.start()
        logger.info("Session archival thread started (interval: {}s)", self.interval_s)

    def stop(self):
        """Stop archival thread."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=10)
            logger.info("Session archival thread stopped")

    def _run_loop(self):
        """Main loop - runs every interval_s seconds."""
        while not self._stop_event.is_set():
            try:
                self._stop_event.wait(timeout=self.interval_s)

                if not self._stop_event.is_set():
                    self._process_unarchived_sessions()

            except Exception as e:
                logger.error("Session archival error: {}", e)

    def _process_unarchived_sessions(self):
        """Process all sessions that need archival."""
        sessions = self.session_manager.get_unarchived()
        logger.info("Processing {} unarchived sessions", len(sessions))

        for session in sessions:
            try:
                self._archive_session(session)
            except Exception as e:
                logger.error("Failed to archive {}: {}", session.key, e)
                self._notify_error(session.key, str(e))

    def _archive_session(self, session: Session) -> None:
        """Archive a single session by extracting facts via LLM and updating MEMORY.md."""
        try:
            result = asyncio.run(self._extract_facts(session.messages))
        except Exception as e:
            logger.error("LLM extraction failed for {}: {}", session.key, e)
            self._notify_error(session.key, f"LLM extraction failed: {e}")
            result = {
                "facts": [],
                "preferences": [],
                "lessons": [],
                "skills": [],
                "nothing_found": True,
            }

        facts = result.get("facts", [])
        preferences = result.get("preferences", [])
        lessons = result.get("lessons", [])
        skills = result.get("skills", [])
        nothing_found = result.get("nothing_found", False)

        lessons = list(dict.fromkeys(session.pending_lessons + lessons))
        skills = list(dict.fromkeys(session.pending_skills + skills))

        lessons, skills = self._merge_pending_files(lessons, skills)

        has_content = facts or preferences or lessons or skills
        if not nothing_found and has_content:
            self._update_memory(session, facts, preferences, lessons)
            if skills:
                self._write_learned_skills(session.key, skills)
            logger.info(
                "Archived session {}: {} facts, {} prefs, {} lessons, {} skills",
                session.key,
                len(facts),
                len(preferences),
                len(lessons),
                len(skills),
            )
        else:
            logger.debug("No significant facts found in session {}", session.key)

        self.session_manager.mark_session_archived(session.key)

    def _update_memory(
        self,
        session: Session,
        facts: list[str],
        preferences: list[str],
        lessons: list[str] | None = None,
    ) -> None:
        """Update MEMORY.md with extracted facts, preferences, and lessons."""
        current_memory = self.memory_store.read_memory()
        timestamp = datetime.now().isoformat()

        if lessons:
            existing_lower = current_memory.lower()
            lessons = [l for l in lessons if l.lower()[:30] not in existing_lower]

        lines = [current_memory]

        if facts or preferences:
            lines.append(f"\n\n## Session: {session.key} ({timestamp})")
            for fact in facts:
                lines.append(f"- {fact}")
            for pref in preferences:
                lines.append(f"- [pref] {pref}")

        if lessons:
            if "## HARD LESSONS" in current_memory:
                for lesson in lessons:
                    lines.append(f"\n- {lesson}")
            else:
                lines.append("\n\n## HARD LESSONS")
                for lesson in lessons:
                    lines.append(f"- {lesson}")

        new_memory = "\n".join(lines)

        new_memory = self.memory_store.enforce_max_size(new_memory)
        new_memory = self.memory_store.clean_conversation_logs(new_memory)

        self.memory_store.write_memory(new_memory)

    def _write_learned_skills(self, session_key: str, skills: list[str]) -> None:
        """Write learned skills to workspace/skills/learned/ as individual files."""
        skills_dir = self.workspace / "skills" / "learned"
        skills_dir.mkdir(parents=True, exist_ok=True)
        for skill in skills:
            slug = (
                skill[:30]
                .lower()
                .replace(" ", "-")
                .replace(":", "")
                .replace("→", "-")
                .replace("/", "-")
            )
            slug = "".join(c if c.isalnum() or c in "-_" else "_" for c in slug)
            skill_file = skills_dir / f"{slug}.md"
            if not skill_file.exists():
                skill_file.write_text(
                    f"# {skill}\n\nExtracted from session: {session_key}\n",
                    encoding="utf-8",
                )
                logger.debug("Wrote learned skill to {}", skill_file)

    def _merge_pending_files(
        self, lessons: list[str], skills: list[str]
    ) -> tuple[list[str], list[str]]:
        """Read nudge output files, merge into lists, delete files after."""
        tasks_dir = self.workspace / "tasks"

        lessons_file = tasks_dir / "pending-lessons.md"
        skills_file = tasks_dir / "pending-skills.md"

        if lessons_file.exists():
            for line in lessons_file.read_text(encoding="utf-8").splitlines():
                line = line.lstrip("- ").strip()
                if line and line not in lessons:
                    lessons.append(line)
            lessons_file.unlink()

        if skills_file.exists():
            for line in skills_file.read_text(encoding="utf-8").splitlines():
                line = line.lstrip("- ").strip()
                if line and line not in skills:
                    skills.append(line)
            skills_file.unlink()

        return lessons, skills

    async def _extract_facts(self, messages: list[dict]) -> dict:
        """Extract facts and preferences from messages using LLM."""
        lines = []
        for m in messages:
            if m.get("role") == "system":
                continue
            timestamp = m.get("timestamp", "?")[:16]
            role = m.get("role", "?").upper()
            content = m.get("content", "")
            if content:
                lines.append(f"[{timestamp}] {role}: {content}")

        if not lines:
            return {
                "facts": [],
                "preferences": [],
                "lessons": [],
                "skills": [],
                "nothing_found": True,
            }

        conversation_text = "\n".join(lines)

        try:
            response = await self._provider.chat(
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": f"Analyze this conversation:\n\n{conversation_text}",
                    },
                ],
                model=self.config.model if hasattr(self.config, "model") else None,
            )

            content = response.content if hasattr(response, "content") else str(response)

            try:
                result = json.loads(content)
                if isinstance(result, dict):
                    return result
            except json.JSONDecodeError:
                logger.warning("Failed to parse LLM response as JSON: {}", content[:100])

        except Exception as e:
            logger.error("LLM call failed: {}", e)
            raise

        return {"facts": [], "preferences": [], "lessons": [], "skills": [], "nothing_found": True}

    def _notify_error(self, session_key: str, error: str) -> None:
        """Notify all channels about archival error asynchronously."""
        if self.bus is None:
            return

        try:
            asyncio.run(self._notify_error_async(session_key, error))
        except Exception as e:
            logger.error("Failed to notify channels about archival error: {}", e)

    async def _notify_error_async(self, session_key: str, error: str) -> None:
        """Send error notification to all channels."""
        from sarathy.bus import OutboundMessage

        channels = ["telegram", "discord", "cli", "email"]
        for channel in channels:
            try:
                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel=channel,
                        chat_id="error",
                        content=f"⚠️ Session archival error for `{session_key}`: {error}",
                    )
                )
            except Exception:
                pass

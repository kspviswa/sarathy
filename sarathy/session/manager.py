"""Session management for conversation history."""

import json
import shutil
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from sarathy.config.schema import Config
from sarathy.utils.helpers import ensure_dir, safe_filename


@dataclass
class Session:
    """
    A conversation session with auto-creation when full.

    Stores messages in JSONL format for easy reading and persistence.

    Important: Messages are append-only for LLM cache efficiency.
    Learning (memory/skill writes) is handled by the background reviewer
    and embedded memory/skill tools. This does NOT modify the messages list.
    """

    key: str  # channel:chat_id
    messages: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    metadata: dict[str, Any] = field(default_factory=dict)
    last_consolidated: int = 0  # Number of messages already consolidated to files
    max_size: int | None = None  # Auto-create new session when messages >= this count
    archived: bool = False  # False when newly created, True after background thread processes
    pending_lessons: list[str] = field(default_factory=list)
    pending_skills: list[str] = field(default_factory=list)

    def add_message(self, role: str, content: str | None, **kwargs: Any) -> None:
        """Add a message and auto-create new session if full."""
        # Sanitize None content to prevent session poisoning
        if content is None:
            content = "(empty)"
        msg = {"role": role, "content": content, "timestamp": datetime.now().isoformat(), **kwargs}
        self.messages.append(msg)
        self.updated_at = datetime.now()

        # Auto-create new session if nearing limit
        if self.max_size and len(self.messages) >= self.max_size:
            logger.info(
                "Session {} full ({} messages), auto-creating new session",
                self.key,
                len(self.messages),
            )
            self._create_new_session()

    def get_history(self, max_messages: int = 500) -> list[dict[str, Any]]:
        """Return unconsolidated messages for LLM input, aligned to a user turn."""
        unconsolidated = self.messages[self.last_consolidated :]
        sliced = unconsolidated[-max_messages:]

        # Drop leading non-user messages to avoid orphaned tool_result blocks
        for i, m in enumerate(sliced):
            if m.get("role") == "user":
                sliced = sliced[i:]
                break

        out: list[dict[str, Any]] = []
        for m in sliced:
            entry: dict[str, Any] = {"role": m["role"], "content": m.get("content", "")}
            for k in ("tool_calls", "tool_call_id", "name", "reasoning_content"):
                if k in m:
                    entry[k] = m[k]
            out.append(entry)
        return out

    def clear(self) -> None:
        """Clear all messages and reset session to initial state."""
        self.messages = []
        self.last_consolidated = 0
        self.updated_at = datetime.now()

    def _create_new_session(self) -> None:
        """Archive current session and start fresh."""
        self.archive_session()

        new_session = Session(key=self.key, max_size=self.max_size)
        new_session._manager = self._manager
        self.messages = []

        if hasattr(self, "_manager") and self._manager is not None:
            self._manager._cache[self.key] = new_session

    def archive_session(self) -> None:
        """Archive session to timestamped JSONL file in archived_sessions directory.

        The session is saved with archived=False. The background thread will later
        set archived=True after processing.
        """
        from datetime import datetime
        from pathlib import Path

        from sarathy.utils.helpers import ensure_dir

        archive_dir = Path(self._get_archive_dir())
        ensure_dir(archive_dir)

        timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M")
        filename = f"session-{timestamp}.jsonl"
        filepath = archive_dir / filename

        with open(filepath, "w", encoding="utf-8") as f:
            metadata = {
                "_type": "metadata",
                "key": self.key,
                "created_at": self.created_at.isoformat(),
                "updated_at": self.updated_at.isoformat(),
                "metadata": self.metadata,
                "last_consolidated": self.last_consolidated,
                "archived": False,
                "pending_lessons": self.pending_lessons,
                "pending_skills": self.pending_skills,
            }
            f.write(json.dumps(metadata, ensure_ascii=False) + "\n")
            for msg in self.messages:
                f.write(json.dumps(msg, ensure_ascii=False) + "\n")

    def _get_archive_dir(self) -> str:
        """Get the archived sessions directory path."""
        if hasattr(self, "_manager") and self._manager is not None:
            workspace = Path(self._manager.config.agents.defaults.workspace).expanduser()
        else:
            workspace = Path("~/.sarathy/workspace").expanduser()
        return str(workspace / "archived_sessions")


class SessionManager:
    """
    Manages conversation sessions with auto-creation support.

    Sessions are stored as JSONL files in the sessions directory.
    Uses an LRU cache to limit in-memory sessions.
    Auto-creates new session when messages >= max_session_size.
    """

    def __init__(
        self,
        config: Config,
        workspace: Path | None = None,
        max_cache_size: int = 50,
        max_session_messages: int = 500,
    ):
        self.config = config
        self.workspace = workspace or Path(config.agents.defaults.workspace).expanduser()
        self.active_sessions_dir = ensure_dir(self.workspace / "sessions")
        self.legacy_sessions_dir = Path.home() / ".sarathy" / "sessions"
        self._max_cache_size = max_cache_size
        self._max_session_messages = max_session_messages
        self.max_session_size = config.agents.memory_archival.max_session_size
        self.auto_create_new_session = config.agents.memory_archival.auto_create_new_session
        self._cache: OrderedDict[str, Session] = OrderedDict()

    def _get_active_session_path(self, key: str) -> Path:
        """Get the file path for an active session."""
        safe_key = safe_filename(key.replace(":", "_"))
        return self.active_sessions_dir / f"{safe_key}.jsonl"

    def _get_legacy_session_path(self, key: str) -> Path:
        """Legacy global session path (~/.sarathy/sessions/)."""
        safe_key = safe_filename(key.replace(":", "_"))
        return self.legacy_sessions_dir / f"{safe_key}.jsonl"

    def get_or_create(self, key: str) -> Session:
        """
        Get an existing session or create a new one.

        Uses LRU cache - accessed sessions move to end.
        Auto-creates new session if existing session is full.

        Args:
            key: Session key (usually channel:chat_id).

        Returns:
            The session.
        """
        if key in self._cache:
            self._cache.move_to_end(key)
            session = self._cache[key]

            # Check if existing session is full and auto-create new one
            if self.auto_create_new_session and len(session.messages) >= self.max_session_size:
                logger.info(
                    "Session {} full ({} messages), auto-creating new session",
                    key,
                    len(session.messages),
                )
                return self._create_new_session(key)

            return session

        session = self._load(key)
        if session is None:
            session = Session(key=key, max_size=self.max_session_size)

        session._manager = self
        self._cache[key] = session

        if len(self._cache) > self._max_cache_size:
            evicted_key, evicted_session = self._cache.popitem(last=False)
            logger.debug("Evicted session {} from cache (LRU)", evicted_key)

        return session

    def read_session(self, key: str) -> Session | None:
        """Load a session for read-only display without creating or caching it."""
        return self._load(key)

    def _load(self, key: str) -> Session | None:
        """Load a session from disk."""
        path = self._get_active_session_path(key)
        if not path.exists():
            legacy_path = self._get_legacy_session_path(key)
            if legacy_path.exists():
                try:
                    shutil.move(str(legacy_path), str(path))
                    logger.info("Migrated session {} from legacy path", key)
                except Exception:
                    logger.exception("Failed to migrate session {}", key)

        if not path.exists():
            return None

        try:
            messages = []
            metadata = {}
            created_at = None
            last_consolidated = 0

            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue

                    data = json.loads(line)

                    if data.get("_type") == "metadata":
                        metadata = data.get("metadata", {})
                        created_at = (
                            datetime.fromisoformat(data["created_at"])
                            if data.get("created_at")
                            else None
                        )
                        last_consolidated = data.get("last_consolidated", 0)
                    else:
                        messages.append(data)

            return Session(
                key=key,
                messages=messages,
                created_at=created_at or datetime.now(),
                metadata=metadata,
                last_consolidated=last_consolidated,
            )
        except Exception as e:
            logger.warning("Failed to load session {}: {}", key, e)
            return None

    def save(self, session: Session) -> None:
        """Save a session to disk, truncating if too many messages."""
        path = self._get_active_session_path(session.key)

        messages_to_save = session.messages
        if len(messages_to_save) > self._max_session_messages:
            truncated = messages_to_save[-self._max_session_messages :]
            logger.debug(
                "Truncated session {} from {} to {} messages",
                session.key,
                len(messages_to_save),
                len(truncated),
            )
            messages_to_save = truncated
            session.last_consolidated = 0

        with open(path, "w", encoding="utf-8") as f:
            metadata_line = {
                "_type": "metadata",
                "key": session.key,
                "created_at": session.created_at.isoformat(),
                "updated_at": session.updated_at.isoformat(),
                "metadata": session.metadata,
                "last_consolidated": session.last_consolidated,
                "max_size": session.max_size,
                "archived": session.archived,
                "pending_lessons": session.pending_lessons,
                "pending_skills": session.pending_skills,
            }
            f.write(json.dumps(metadata_line, ensure_ascii=False) + "\n")
            for msg in messages_to_save:
                f.write(json.dumps(msg, ensure_ascii=False) + "\n")

        session.messages = messages_to_save
        self._cache[session.key] = session

    def invalidate(self, key: str) -> None:
        """Remove a session from the in-memory cache."""
        self._cache.pop(key, None)

    def _create_new_session(self, key: str) -> Session:
        """Create a new session file with same key."""
        new_session = Session(key=key, max_size=self.max_session_size)
        new_session._manager = self

        old_session = self._load(key)
        if old_session and old_session.messages:
            old_session.archive_session()

        self._cache[key] = new_session

        logger.info("Created new session for key: {}", key)
        return new_session

    def mark_session_archived(self, key: str) -> None:
        """Mark a session as archived in the archived_sessions/ file."""
        archive_dir = Path(self.workspace) / "archived_sessions"
        if not archive_dir.exists():
            return

        for filepath in archive_dir.glob("session-*.jsonl"):
            try:
                with open(filepath, encoding="utf-8") as f:
                    lines = f.readlines()
                if not lines:
                    continue
                metadata = json.loads(lines[0])
                if metadata.get("key") == key:
                    metadata["archived"] = True
                    lines[0] = json.dumps(metadata, ensure_ascii=False) + "\n"
                    filepath.write_text("".join(lines), encoding="utf-8")
                    logger.info("Marked session {} as archived", key)
                    break
            except Exception as e:
                logger.warning("Failed to mark session {} as archived: {}", key, e)

    def get_unarchived(self) -> list[Session]:
        """Get all unarchived sessions from archived_sessions/ directory.

        Scans archived_sessions/ for files with archived=False (not yet processed
        by background thread). Loads each file and returns as Session objects.
        """
        from pathlib import Path

        unarchived = []
        archive_dir = Path(self.workspace) / "archived_sessions"

        if not archive_dir.exists():
            return unarchived

        for filepath in archive_dir.glob("session-*.jsonl"):
            try:
                with open(filepath, encoding="utf-8") as f:
                    first_line = f.readline().strip()
                    if not first_line:
                        continue
                    metadata = json.loads(first_line)
                    if metadata.get("_type") == "metadata" and not metadata.get("archived", False):
                        f.seek(0)
                        messages = []
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            data = json.loads(line)
                            if data.get("_type") != "metadata":
                                messages.append(data)
                        session = Session(
                            key=metadata.get("key", filepath.stem),
                            messages=messages,
                            created_at=datetime.fromisoformat(
                                metadata.get("created_at", datetime.now().isoformat())
                            ),
                            updated_at=datetime.fromisoformat(
                                metadata.get("updated_at", datetime.now().isoformat())
                            ),
                            metadata=metadata.get("metadata", {}),
                            last_consolidated=metadata.get("last_consolidated", 0),
                            archived=False,
                            pending_lessons=metadata.get("pending_lessons", []),
                            pending_skills=metadata.get("pending_skills", []),
                        )
                        session._manager = self
                        unarchived.append(session)
            except Exception as e:
                logger.warning("Failed to load archived session {}: {}", filepath, e)

        return unarchived

    def list_sessions(self) -> list[dict[str, Any]]:
        """
        List all sessions.

        Returns:
            List of session info dicts.
        """
        sessions = []

        for path in self.active_sessions_dir.glob("*.jsonl"):
            try:
                # Read just the metadata line
                with open(path, encoding="utf-8") as f:
                    first_line = f.readline().strip()
                    if first_line:
                        data = json.loads(first_line)
                        if data.get("_type") == "metadata":
                            key = data.get("key") or path.stem.replace("_", ":", 1)
                            sessions.append(
                                {
                                    "key": key,
                                    "created_at": data.get("created_at"),
                                    "updated_at": data.get("updated_at"),
                                    "path": str(path),
                                }
                            )
            except Exception:
                continue

        return sorted(sessions, key=lambda x: x.get("updated_at", ""), reverse=True)

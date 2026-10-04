"""Session management for conversation history."""

import asyncio
import json
import shutil
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from sarathy.config.schema import Config
from sarathy.utils.helpers import ensure_dir, safe_filename


def channel_for_key(key: str) -> str:
    """Derive the channel from a session key (prefix before the first ':')."""
    if ":" in key:
        prefix = key.split(":", 1)[0]
        return prefix or "cli"
    return "cli"


_INDEX_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  topic TEXT,
  topic_user_set INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
"""


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
    archived: bool = False  # True only when live review was confirmed done at archive time
    pending_lessons: list[str] = field(default_factory=list)
    pending_skills: list[str] = field(default_factory=list)
    steer_queue: asyncio.Queue | None = None  # transient in-memory /steer queue (not persisted)

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
            # Persist the fresh (empty) session to disk so reads that go to
            # disk (dashboard /api/session, gateway restart) see the new
            # session — otherwise the archived conversation is resurrected
            # on page reload / restart.
            self._manager.save(new_session)

    def archive_session(self, learned: bool = False) -> None:
        """Archive session to timestamped JSONL file in archived_sessions directory.

        Args:
            learned: True only when live per-turn review is confirmed complete
                for this session (e.g. /new checked via reviewer.has_pending).
                Callers that cannot confirm it keep the default False so the
                file is treated as unverified and re-checked later.
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
                "archived": learned,
                "pending_lessons": self.pending_lessons,
                "pending_skills": self.pending_skills,
            }
            f.write(json.dumps(metadata, ensure_ascii=False) + "\n")
            for msg in self.messages:
                f.write(json.dumps(msg, ensure_ascii=False) + "\n")

        # Keep the lightweight sessions index in sync (best effort).
        try:
            manager = getattr(self, "_manager", None)
            if manager is not None and hasattr(manager, "_upsert_index"):
                manager._upsert_index(self, archived=1 if learned else 0)
        except Exception as e:
            logger.debug("Failed to update sessions index for {}: {}", self.key, e)

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
        # Build the lightweight sessions index on first use (gateway start with
        # a missing/stale index). Cheap when there are no session files.
        try:
            if not self._index_db_path().exists():
                self.rebuild_index()
            else:
                self._ensure_index()
        except Exception as e:
            logger.debug("Sessions index init skipped: {}", e)

    def _get_active_session_path(self, key: str) -> Path:
        """Get the file path for an active session."""
        safe_key = safe_filename(key.replace(":", "_"))
        return self.active_sessions_dir / f"{safe_key}.jsonl"

    @staticmethod
    def _is_cron_session(key: str) -> bool:
        """Cron jobs use a stable per-job key 'cron:<job_id>'."""
        return key.startswith("cron:")

    def _max_size_for(self, key: str) -> int | None:
        """Per-session mid-turn rotation threshold.

        Cron sessions must NOT rotate mid-turn (that would break a run in
        progress); they rotate between runs in get_or_create() instead.
        """
        return None if self._is_cron_session(key) else self.max_session_size

    def _should_rotate(self, key: str, session: Session) -> bool:
        """Decide whether a session must be archived and started fresh.

        Interactive sessions rotate at the (large) max_session_size threshold.
        Cron sessions rotate at the trim cap instead: they hold a stable
        'cron:<job_id>' key reused across every run, so without this they are
        truncated forever and never rotate — the context eventually blows up
        and the run no-ops silently while still reporting ok. See KB #305.
        """
        if not self.auto_create_new_session:
            return False
        if self._is_cron_session(key):
            return len(session.messages) > self._max_session_messages
        return len(session.messages) >= self.max_session_size

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
            if self._should_rotate(key, session):
                logger.info(
                    "Session {} full ({} messages), auto-creating new session",
                    key,
                    len(session.messages),
                )
                return self._create_new_session(key)

            return session

        session = self._load(key)
        if session is None:
            session = Session(key=key, max_size=self._max_size_for(key))
        elif self._should_rotate(key, session):
            # A session loaded cold from disk (e.g. after a gateway restart)
            # may already be over threshold — rotate it before this run.
            logger.info(
                "Session {} over threshold ({} messages) on load, auto-creating new session",
                key,
                len(session.messages),
            )
            session._manager = self
            self._cache[key] = session
            return self._create_new_session(key)

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
        """Save a session to disk, truncating if too many messages.

        Cron sessions are exempt from the trim cap: they rotate between runs
        (see _should_rotate) and must keep their full history so the archive
        captures it. A generous safety cap still guards pathological growth.
        """
        path = self._get_active_session_path(session.key)

        messages_to_save = session.messages
        if self._is_cron_session(session.key):
            safety_cap = self._max_session_messages * 10
            if len(messages_to_save) > safety_cap:
                messages_to_save = messages_to_save[-safety_cap:]
                logger.warning(
                    "Cron session {} exceeded safety cap, truncated to {} messages",
                    session.key,
                    safety_cap,
                )
        elif len(messages_to_save) > self._max_session_messages:
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

        # Keep the lightweight sessions index in sync (best effort, cheap).
        try:
            self._upsert_index(session, archived=1 if session.archived else 0)
        except Exception as e:
            logger.debug("Failed to update sessions index for {}: {}", session.key, e)

    def invalidate(self, key: str) -> None:
        """Remove a session from the in-memory cache."""
        self._cache.pop(key, None)

    def delete_session(self, key: str) -> None:
        """Delete a session from disk and cache (idempotent)."""
        self.invalidate(key)
        try:
            conn = self._index_connect()
            try:
                conn.execute("DELETE FROM sessions WHERE key = ?", (key,))
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.debug("Failed to delete sessions index row for {}: {}", key, e)
        path = self._get_active_session_path(key)
        if path.exists():
            try:
                path.unlink()
                logger.info("Deleted session file for key: {}", key)
            except OSError as e:
                logger.warning("Failed to delete session file {}: {}", path, e)
        fallback_key = "dashboard:console"
        if key != fallback_key:
            fb_path = self._get_active_session_path(fallback_key)
            if fb_path.exists():
                try:
                    fb_path.unlink()
                    logger.info("Deleted fallback session file for key: {}", fallback_key)
                except OSError as e:
                    logger.warning("Failed to delete fallback session file {}: {}", fb_path, e)

    def _create_new_session(self, key: str) -> Session:
        """Create a new session file with same key.

        The LIVE conversation lives in the in-memory cache (messages are only
        flushed to disk opportunistically), so archive the cached session when
        present — archiving the disk copy alone would capture a stale snapshot
        and drop everything since the last save. Then persist the fresh empty
        session so disk reads (dashboard /api/session, gateway restart) do not
        resurrect the archived conversation.
        """
        new_session = Session(key=key, max_size=self._max_size_for(key))
        new_session._manager = self

        old_session = self._cache.get(key) or self._load(key)
        if old_session and old_session.messages:
            old_session.archive_session()

        self._cache[key] = new_session
        self.save(new_session)

        logger.info("Created new session for key: {}", key)
        return new_session

    def mark_session_archived(self, key: str) -> None:
        """Mark archived sessions as verified in the archived_sessions/ files.

        Flips every file for this key that is still stamped archived=False —
        multiple archives can exist for one session key (one per /new).
        """
        archive_dir = Path(self.workspace) / "archived_sessions"
        if not archive_dir.exists():
            return

        marked = 0
        for filepath in archive_dir.glob("session-*.jsonl"):
            try:
                with open(filepath, encoding="utf-8") as f:
                    lines = f.readlines()
                if not lines:
                    continue
                metadata = json.loads(lines[0])
                if (
                    metadata.get("_type") == "metadata"
                    and metadata.get("key") == key
                    and not metadata.get("archived", False)
                ):
                    metadata["archived"] = True
                    lines[0] = json.dumps(metadata, ensure_ascii=False) + "\n"
                    filepath.write_text("".join(lines), encoding="utf-8")
                    marked += 1
            except Exception as e:
                logger.warning("Failed to mark session {} as archived: {}", key, e)

        if marked:
            logger.info("Marked {} archived session(s) of {} as verified", marked, key)

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

    # ------------------------------------------------------------------ sessions index

    def _index_db_path(self) -> Path:
        """Path of the lightweight sessions index DB."""
        return self.active_sessions_dir / "index.db"

    def _index_connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._index_db_path()))
        conn.execute(_INDEX_SCHEMA)
        return conn

    def _ensure_index(self) -> None:
        conn = self._index_connect()
        try:
            conn.commit()
        finally:
            conn.close()

    def _upsert_index(self, session: Session, archived: int = 0) -> None:
        """Upsert one row of the sessions index (one cheap write per save)."""
        meta = session.metadata or {}
        conn = self._index_connect()
        try:
            conn.execute(
                "INSERT INTO sessions (key, channel, topic, topic_user_set,"
                " created_at, updated_at, archived)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(key) DO UPDATE SET"
                " channel=excluded.channel, topic=excluded.topic,"
                " topic_user_set=excluded.topic_user_set,"
                " created_at=excluded.created_at, updated_at=excluded.updated_at,"
                " archived=excluded.archived",
                (
                    session.key,
                    channel_for_key(session.key),
                    meta.get("topic"),
                    1 if meta.get("topic_user_set") else 0,
                    session.created_at.isoformat() if session.created_at else None,
                    session.updated_at.isoformat() if session.updated_at else None,
                    archived,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def rebuild_index(self) -> int:
        """Walk active session files and repopulate the index. Returns row count."""
        conn = self._index_connect()
        try:
            conn.execute("DELETE FROM sessions")
            count = 0
            for path in self.active_sessions_dir.glob("*.jsonl"):
                try:
                    with open(path, encoding="utf-8") as f:
                        first_line = f.readline().strip()
                    if not first_line:
                        continue
                    data = json.loads(first_line)
                    if data.get("_type") != "metadata":
                        continue
                    key = data.get("key") or path.stem.replace("_", ":", 1)
                    meta = data.get("metadata", {}) or {}
                    conn.execute(
                        "INSERT OR REPLACE INTO sessions"
                        " (key, channel, topic, topic_user_set,"
                        " created_at, updated_at, archived)"
                        " VALUES (?, ?, ?, ?, ?, ?, 0)",
                        (
                            key,
                            channel_for_key(key),
                            meta.get("topic"),
                            1 if meta.get("topic_user_set") else 0,
                            data.get("created_at"),
                            data.get("updated_at"),
                        ),
                    )
                    count += 1
                except Exception:
                    continue
            conn.commit()
            return count
        finally:
            conn.close()

    def _list_sessions_from_index(self) -> list[dict[str, Any]] | None:
        """Fast path: read the session list from the SQLite index.

        Returns None when the index is missing/empty/unreadable so the caller
        can fall back to the metadata-line scan.
        """
        try:
            path = self._index_db_path()
            if not path.exists():
                return None
            conn = sqlite3.connect(str(path))
            try:
                rows = conn.execute(
                    "SELECT key, channel, topic, topic_user_set,"
                    " created_at, updated_at, archived FROM sessions"
                    " ORDER BY updated_at DESC"
                ).fetchall()
            finally:
                conn.close()
        except Exception:
            return None
        if not rows:
            return None
        sessions = []
        for key, channel, topic, topic_user_set, created_at, updated_at, archived in rows:
            if archived:
                continue
            sessions.append(
                {
                    "key": key,
                    "channel": channel,
                    "topic": topic,
                    "topic_user_set": bool(topic_user_set),
                    "created_at": created_at,
                    "updated_at": updated_at,
                    "path": str(self._get_active_session_path(key)),
                }
            )
        return sessions

    def list_sessions(self) -> list[dict[str, Any]]:
        """
        List all sessions.

        Fast path reads the SQLite index (never scans transcripts); falls back
        to the metadata-line scan when the index is missing or empty.

        Returns:
            List of session info dicts.
        """
        indexed = self._list_sessions_from_index()
        if indexed is not None:
            return indexed

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
                            meta = data.get("metadata", {}) or {}
                            sessions.append(
                                {
                                    "key": key,
                                    "channel": channel_for_key(key),
                                    "topic": meta.get("topic"),
                                    "topic_user_set": bool(meta.get("topic_user_set", False)),
                                    "created_at": data.get("created_at"),
                                    "updated_at": data.get("updated_at"),
                                    "path": str(path),
                                }
                            )
            except Exception:
                continue

        return sorted(sessions, key=lambda x: x.get("updated_at", ""), reverse=True)

    def prune_archives(self, max_age_days: int = 30, keep_unverified: bool = True) -> dict[str, int]:
        """Delete archived session files older than max_age_days.

        Retention for archived_sessions/ — nothing else reaps this directory,
        so without it the archive grows without bound. Files still stamped
        archived=False (not yet reviewed for durable facts) are kept by
        default so pending learning is never discarded.

        Returns a dict of counts: {"scanned", "deleted", "kept_unverified", "freed_bytes"}.
        """
        import time

        archive_dir = self.workspace / "archived_sessions"
        stats = {"scanned": 0, "deleted": 0, "kept_unverified": 0, "freed_bytes": 0}
        if not archive_dir.exists():
            return stats

        cutoff = time.time() - max_age_days * 86400
        for filepath in archive_dir.glob("session-*.jsonl"):
            stats["scanned"] += 1
            try:
                if filepath.stat().st_mtime >= cutoff:
                    continue
                if keep_unverified:
                    with open(filepath, encoding="utf-8") as f:
                        first_line = f.readline().strip()
                    if first_line:
                        meta = json.loads(first_line)
                        if meta.get("_type") == "metadata" and not meta.get("archived", False):
                            stats["kept_unverified"] += 1
                            continue
                size = filepath.stat().st_size
                filepath.unlink()
                stats["deleted"] += 1
                stats["freed_bytes"] += size
                logger.info("Pruned archived session {} (older than {}d)", filepath.name, max_age_days)
            except Exception as e:
                logger.warning("Failed to prune archive {}: {}", filepath, e)

        return stats

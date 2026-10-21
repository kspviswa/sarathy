"""The Ask thread store — a dedicated SQLite database of research threads.

Ask threads used to live in the browser's ``localStorage``: browser-local,
capped at fifty, lost when the data was cleared, invisible from any other
device. The gateway owns them now, the way it already owns the chat
sessions. A thread is a list of turns, and a turn is stored WHOLE — the
answer, the research steps, the sources and the media — so a thread reopened
from the server renders exactly as it did live.

The database lives beside the other gateway state (``~/.sarathy/ask/``) and is
created on demand: nothing touches the disk until a thread is read or
written.

The store is deliberately SEPARATE from the sessions index. A research thread
is not a chat session — it has its own turns, its own lifetime and its own
endpoints — and folding it into the sessions store would have meant every
session list carried research rows it had no use for.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from sarathy.utils.helpers import ensure_dir, get_data_path

# The schema version, kept in the database's `user_version` — the same
# migration discipline the usage store uses (sarathy/usage/store.py).
SCHEMA_VERSION = 1

# The title of a thread is its first query, clipped. The SPA clips the same
# way (`askThreadTitle`), so a thread looks the same wherever it is read.
TITLE_MAX = 80

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ask_threads (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ask_turns (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  query        TEXT NOT NULL,
  answer       TEXT NOT NULL DEFAULT '',
  steps_json   TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  media_json   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  -- The turn's remaining fields (mode, source kinds, usage, error) live
  -- here: a reopened thread must render EXACTLY as it did live, and those
  -- are part of what the turn card draws.
  meta_json    TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (thread_id) REFERENCES ask_threads (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ask_turns_thread ON ask_turns (thread_id, seq);
"""


def default_ask_store_path() -> Path:
    """Where the ask store lives — the gateway's own state directory."""
    return get_data_path() / "ask" / "threads.db"


def thread_title(query: str) -> str:
    """The title of a thread: its first query, whitespace-collapsed and clipped."""
    flat = " ".join((query or "").split())
    if len(flat) > TITLE_MAX:
        return f"{flat[:TITLE_MAX]}…"
    return flat


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _epoch_ms(stamp: str | None) -> int:
    """An ISO stamp as epoch milliseconds — the shape the SPA's threads use."""
    if not stamp:
        return 0
    try:
        return int(datetime.fromisoformat(stamp).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


def _iso_from_epoch_ms(value: Any) -> str:
    """Epoch milliseconds as an ISO stamp — the shape the database stores."""
    try:
        millis = int(value)
    except (TypeError, ValueError):
        return _now_iso()
    if millis <= 0:
        return _now_iso()
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat()


def _dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return "[]"


def _loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed is not None else fallback


class AskStore:
    """The Ask threads: create, list, read, delete — and the turns inside.

    Every method is synchronous and opens its own connection: the store is
    touched from the aiohttp event loop and from tests, and a single shared
    connection would have to be guarded against concurrent use.
    """

    def __init__(self, db_path: Path | None = None) -> None:
        self._db_path = Path(db_path) if db_path else default_ask_store_path()
        self._lock = threading.Lock()
        self._ensure_schema()

    @property
    def db_path(self) -> Path:
        return self._db_path

    # ------------------------------------------------------------------ schema

    def _connect(self) -> sqlite3.Connection:
        ensure_dir(self._db_path.parent)
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        # The cascade that drops a thread's turns with the thread relies on
        # this being ON — SQLite keeps it off by default.
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _ensure_schema(self) -> None:
        """Create the tables, and migrate a database written by an older build."""
        try:
            with self._lock:
                conn = self._connect()
                try:
                    conn.executescript(_SCHEMA)
                    version = conn.execute("PRAGMA user_version;").fetchone()[0]
                    if version < SCHEMA_VERSION:
                        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION};")
                    conn.commit()
                finally:
                    conn.close()
        except Exception as err:  # a broken store must not break the dashboard
            logger.warning("Could not open the Ask thread store: {}", err)

    # ------------------------------------------------------------------ threads

    def list_threads(self) -> list[dict[str, Any]]:
        """The thread list, newest first — WITHOUT the turn bodies.

        The list is what the history rail draws: a title, a turn count and a
        timestamp. Shipping every turn's answer with it would make the list
        grow with the whole history, so the bodies come from the detail
        call instead.
        """
        try:
            with self._lock:
                conn = self._connect()
                try:
                    rows = conn.execute(
                        "SELECT t.id, t.title, t.created_at, t.updated_at,"
                        " (SELECT COUNT(*) FROM ask_turns u WHERE u.thread_id = t.id)"
                        " AS turn_count"
                        " FROM ask_threads t"
                        " ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC"
                    ).fetchall()
                finally:
                    conn.close()
        except Exception as err:
            logger.warning("Could not read the Ask threads: {}", err)
            return []

        return [
            {
                "id": row["id"],
                "title": row["title"],
                "createdAt": _epoch_ms(row["created_at"]),
                "updatedAt": _epoch_ms(row["updated_at"]),
                "turnCount": int(row["turn_count"] or 0),
            }
            for row in rows
        ]

    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        """One thread with its turns — ``None`` when the id is unknown."""
        if not thread_id:
            return None
        try:
            with self._lock:
                conn = self._connect()
                try:
                    row = conn.execute(
                        "SELECT id, title, created_at, updated_at FROM ask_threads"
                        " WHERE id = ?",
                        (thread_id,),
                    ).fetchone()
                    if row is None:
                        return None
                    turns = conn.execute(
                        "SELECT * FROM ask_turns WHERE thread_id = ? ORDER BY seq ASC",
                        (thread_id,),
                    ).fetchall()
                finally:
                    conn.close()
        except Exception as err:
            logger.warning("Could not read the Ask thread {}: {}", thread_id, err)
            return None

        return {
            "thread": {
                "id": row["id"],
                "title": row["title"],
                "createdAt": _epoch_ms(row["created_at"]),
                "updatedAt": _epoch_ms(row["updated_at"]),
                "turnCount": len(turns),
            },
            "turns": [self._turn(row) for row in turns],
        }

    def create_thread(
        self,
        title: str = "",
        thread_id: str | None = None,
        turns: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Create (or replace) a thread and its turns.

        The write is an UPSERT keyed by the id: the one-time migration of the
        browser's history must be safe to retry, and a thread that already
        exists is replaced rather than duplicated.
        """
        thread_id = thread_id or f"thread-{uuid.uuid4().hex}"
        turns = turns or []
        now = _now_iso()

        # A thread with no title takes the first query it carries.
        resolved = (title or "").strip()
        if not resolved:
            for turn in turns:
                query = str(turn.get("query") or "").strip()
                if query:
                    resolved = thread_title(query)
                    break

        try:
            with self._lock:
                conn = self._connect()
                try:
                    conn.execute(
                        "INSERT INTO ask_threads (id, title, created_at, updated_at)"
                        " VALUES (?, ?, ?, ?)"
                        " ON CONFLICT(id) DO UPDATE SET"
                        " title = excluded.title, updated_at = excluded.updated_at",
                        (thread_id, resolved, now, now),
                    )
                    conn.execute("DELETE FROM ask_turns WHERE thread_id = ?", (thread_id,))
                    for index, turn in enumerate(turns):
                        self._insert_turn(conn, thread_id, index, turn, now)
                    conn.commit()
                finally:
                    conn.close()
        except Exception as err:
            logger.warning("Could not write the Ask thread {}: {}", thread_id, err)

        stored = self.get_thread(thread_id)
        if stored:
            return stored["thread"]
        return {
            "id": thread_id,
            "title": resolved,
            "createdAt": _epoch_ms(now),
            "updatedAt": _epoch_ms(now),
            "turnCount": len(turns),
        }

    def delete_thread(self, thread_id: str) -> bool:
        """Forget a thread and its turns. ``False`` when the id is unknown."""
        if not thread_id:
            return False
        try:
            with self._lock:
                conn = self._connect()
                try:
                    cursor = conn.execute(
                        "DELETE FROM ask_threads WHERE id = ?", (thread_id,)
                    )
                    # The cascade drops the turns with the thread; the explicit
                    # delete covers a database written before the foreign key
                    # was enabled.
                    conn.execute("DELETE FROM ask_turns WHERE thread_id = ?", (thread_id,))
                    conn.commit()
                    return cursor.rowcount > 0
                finally:
                    conn.close()
        except Exception as err:
            logger.warning("Could not delete the Ask thread {}: {}", thread_id, err)
            return False

    # ------------------------------------------------------------------ turns

    def add_turn(self, thread_id: str, turn: dict[str, Any]) -> dict[str, Any] | None:
        """Append one turn to a thread, creating the thread when it is new.

        A stream that lands in a thread the store has never seen creates it —
        the first turn of a new conversation IS the thread, and its title is
        the question that started it.
        """
        if not thread_id:
            return None
        try:
            with self._lock:
                conn = self._connect()
                try:
                    row = conn.execute(
                        "SELECT id, title, created_at, updated_at FROM ask_threads"
                        " WHERE id = ?",
                        (thread_id,),
                    ).fetchone()
                    now = _now_iso()
                    if row is None:
                        conn.execute(
                            "INSERT INTO ask_threads (id, title, created_at, updated_at)"
                            " VALUES (?, ?, ?, ?)",
                            (thread_id, thread_title(str(turn.get("query") or "")), now, now),
                        )
                    else:
                        now = _now_iso()
                    seq = int(
                        conn.execute(
                            "SELECT COALESCE(MAX(seq), -1) + 1 FROM ask_turns"
                            " WHERE thread_id = ?",
                            (thread_id,),
                        ).fetchone()[0]
                    )
                    self._insert_turn(conn, thread_id, seq, turn, now)
                    conn.execute(
                        "UPDATE ask_threads SET updated_at = ? WHERE id = ?",
                        (now, thread_id),
                    )
                    conn.commit()
                finally:
                    conn.close()
        except Exception as err:
            logger.warning("Could not write the Ask turn for {}: {}", thread_id, err)
            return None

        return self.get_thread(thread_id)

    def merge_turn_media(
        self, thread_id: str, turn_id: str, kind: str, items: list[dict[str, Any]]
    ) -> bool:
        """Attach media to a turn that already exists.

        The media is fetched AFTER the stream completed, so it lands on a turn
        that was written a moment earlier. Only the items of ONE kind are
        replaced: the images and the videos of a turn are fetched by two
        separate calls, and the second must not drop the first.
        """
        if not thread_id or not turn_id:
            return False
        try:
            with self._lock:
                conn = self._connect()
                try:
                    row = conn.execute(
                        "SELECT media_json FROM ask_turns WHERE id = ? AND thread_id = ?",
                        (turn_id, thread_id),
                    ).fetchone()
                    if row is None:
                        return False
                    existing = _loads(row["media_json"], [])
                    if not isinstance(existing, list):
                        existing = []
                    kept = [m for m in existing if not (isinstance(m, dict) and m.get("kind") == kind)]
                    merged = kept + list(items or [])
                    conn.execute(
                        "UPDATE ask_turns SET media_json = ? WHERE id = ? AND thread_id = ?",
                        (_dumps(merged), turn_id, thread_id),
                    )
                    conn.commit()
                    return True
                finally:
                    conn.close()
        except Exception as err:
            logger.warning("Could not attach media to the Ask turn {}: {}", turn_id, err)
            return False

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _insert_turn(
        conn: sqlite3.Connection,
        thread_id: str,
        seq: int,
        turn: dict[str, Any],
        created_at: str,
    ) -> None:
        """Write one turn row. The caller owns the transaction."""
        turn_id = str(turn.get("id") or f"turn-{uuid.uuid4().hex}")
        meta = {
            "mode": turn.get("mode") or "speed",
            "sources": turn.get("sources") or ["web"],
        }
        if turn.get("usage"):
            meta["usage"] = turn["usage"]
        if turn.get("error"):
            meta["error"] = turn["error"]
        conn.execute(
            "INSERT OR REPLACE INTO ask_turns"
            " (id, thread_id, seq, query, answer, steps_json, sources_json,"
            "  media_json, created_at, meta_json)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                turn_id,
                thread_id,
                seq,
                str(turn.get("query") or ""),
                str(turn.get("answer") or ""),
                _dumps(turn.get("steps") or []),
                _dumps(turn.get("sourcesList") or []),
                _dumps(turn.get("media") or []),
                _iso_from_epoch_ms(turn.get("createdAt")) if turn.get("createdAt") else created_at,
                _dumps(meta),
            ),
        )

    @staticmethod
    def _turn(row: sqlite3.Row) -> dict[str, Any]:
        """One stored turn as the API's turn object."""
        meta = _loads(row["meta_json"], {})
        if not isinstance(meta, dict):
            meta = {}
        turn: dict[str, Any] = {
            "id": row["id"],
            "seq": int(row["seq"]),
            "query": row["query"],
            "answer": row["answer"],
            "mode": meta.get("mode") or "speed",
            "sources": meta.get("sources") or ["web"],
            "sourcesList": _loads(row["sources_json"], []),
            "steps": _loads(row["steps_json"], []),
            "media": _loads(row["media_json"], []),
            "createdAt": _epoch_ms(row["created_at"]),
        }
        if meta.get("usage"):
            turn["usage"] = meta["usage"]
        if meta.get("error"):
            turn["error"] = meta["error"]
        return turn


class AskTurnAccumulator:
    """Folds the Ask NDJSON frames into the turn the store keeps.

    This is the server-side twin of the SPA's ``reduceAskFrame``: the same
    frames in, the same answer, steps and sources out. The browser folds the
    frames for the live view; the gateway folds them for the record, so a
    thread reopened from the server renders exactly as it did live.
    """

    def __init__(self) -> None:
        self.answer = ""
        self.steps: list[dict[str, Any]] = []
        self.sources: list[dict[str, Any]] = []
        self.media: list[dict[str, Any]] = []
        self.usage: dict[str, Any] | None = None
        self.error: dict[str, Any] | None = None
        self.done = False
        self.failed = False

    def feed(self, frame: Any) -> None:
        """Fold one frame in. An unknown frame is ignored, never fatal."""
        if not isinstance(frame, dict):
            return
        kind = frame.get("type")
        data = frame.get("data")

        if kind == "step":
            self._feed_step(data)
        elif kind == "sources":
            self._feed_sources(data)
        elif kind == "response" and isinstance(data, str):
            self.answer += data
        elif kind == "media":
            self._feed_media(data)
        elif kind == "usage" and isinstance(data, dict):
            self.usage = data
        elif kind == "error":
            self.failed = True
            self.error = data if isinstance(data, dict) else {"message": str(data)}
        elif kind == "done":
            self.done = True

    def _feed_step(self, data: Any) -> None:
        if not isinstance(data, dict):
            return
        kind = data.get("kind")
        if kind == "searching":
            queries = data.get("queries")
            self.steps.append(
                {"kind": "searching", "queries": queries if isinstance(queries, list) else []}
            )
            return
        if kind == "reading" and isinstance(data.get("url"), str):
            self.steps.append(
                {
                    "kind": "reading",
                    "url": data["url"],
                    "title": data.get("title") or data["url"],
                }
            )
            return
        if kind == "reasoning":
            reasoning = data.get("reasoning") if isinstance(data.get("reasoning"), str) else ""
            # The engine re-sends the whole plan on every block update, so a
            # plan that GREW updates the step on screen instead of drawing a
            # second "Thinking" row. The same rule keeps the record in step
            # with the live timeline.
            last = self.steps[-1] if self.steps else None
            if (
                last
                and last.get("kind") == "reasoning"
                and reasoning.startswith(str(last.get("reasoning") or ""))
            ):
                self.steps[-1] = {"kind": "reasoning", "reasoning": reasoning}
                return
            self.steps.append({"kind": "reasoning", "reasoning": reasoning})
            return
        if kind in ("timeout", "retrying"):
            self.steps.append(
                {
                    "kind": kind,
                    "attempt": int(data.get("attempt") or 1),
                    "max": int(data.get("max") or 1),
                }
            )
            return
        if kind == "gave_up":
            self.steps.append({"kind": "gave_up", "message": data.get("message")})

    def _feed_sources(self, data: Any) -> None:
        if not isinstance(data, list):
            return
        sources: list[dict[str, Any]] = []
        for index, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str) or not url:
                continue
            sources.append(
                {
                    "idx": item.get("idx") if isinstance(item.get("idx"), int) else index + 1,
                    "title": item.get("title") or url,
                    "url": url,
                    "domain": item.get("domain") or "",
                }
            )
        self.sources = sources
        # The "found" step is DERIVED, exactly as the SPA derives it: it is
        # not a wire frame, it lands after the research steps.
        if sources:
            self.steps.append({"kind": "found", "count": len(sources)})

    def _feed_media(self, data: Any) -> None:
        if not isinstance(data, list):
            return
        for item in data:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str) or not url:
                continue
            self.media.append(
                {
                    "kind": "video" if item.get("kind") == "video" else "image",
                    "url": url,
                    "thumb": item.get("thumb"),
                    "img_src": item.get("img_src"),
                    "title": item.get("title"),
                    "iframe_src": item.get("iframe_src"),
                    "iframeUrl": item.get("iframeUrl") or item.get("iframe_src"),
                }
            )

    def turn(self, query: str, turn_id: str, mode: str, sources: list[str], created_at: int) -> dict[str, Any]:
        """The turn as the store keeps it."""
        turn: dict[str, Any] = {
            "id": turn_id,
            "query": query,
            "answer": self.answer,
            "mode": mode,
            "sources": sources,
            "sourcesList": self.sources,
            "steps": self.steps,
            "media": self.media,
            "createdAt": created_at,
        }
        if self.usage:
            turn["usage"] = self.usage
        if self.error:
            turn["error"] = self.error
        return turn

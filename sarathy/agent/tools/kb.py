"""Knowledge-base tool — SQLite + FTS5 durable facts (same schema as memory_cli)."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from sarathy.agent.tools.base import Tool

# Mirror scripts/memory_cli.py — do not fork the schema.
_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'fact',
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, tags, category,
    content='entries', content_rowid='id',
    tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, tags, category)
    VALUES (new.id, new.title, new.content, new.tags, new.category);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags, category)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.category);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags, category)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.category);
    INSERT INTO entries_fts(rowid, title, content, tags, category)
    VALUES (new.id, new.title, new.content, new.tags, new.category);
END;
"""


def _default_db_path() -> Path:
    env = os.environ.get("SARATHY_KB_PATH")
    if env:
        return Path(env)
    return Path.home() / ".sarathy" / "workspace" / "memory" / "kb.db"


class KBTool(Tool):
    """Search and record durable facts in the workspace knowledge base."""

    def __init__(self, db_path: Path | str | None = None):
        self._db_path = Path(db_path) if db_path else _default_db_path()

    @property
    def name(self) -> str:
        return "kb"

    @property
    def description(self) -> str:
        return (
            "Search and manage the durable knowledge base (facts, decisions, preferences). "
            "Use 'search' to find entries, 'add' to insert a new fact, 'update' to edit one. "
            "Prefer this over shell/memory_cli for KB reads and writes."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["search", "add", "update"],
                    "description": "Operation to perform",
                },
                "query": {
                    "type": "string",
                    "description": "Search query (for search)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max search results (default 5)",
                },
                "id": {
                    "type": "integer",
                    "description": "Entry id (for update)",
                },
                "kind": {
                    "type": "string",
                    "description": "Entry kind (fact, decision, preference, …)",
                },
                "category": {
                    "type": "string",
                    "description": "Category label",
                },
                "title": {
                    "type": "string",
                    "description": "Short title",
                },
                "content": {
                    "type": "string",
                    "description": "Full entry body",
                },
                "tags": {
                    "type": "string",
                    "description": "Comma-separated tags",
                },
                "source": {
                    "type": "string",
                    "description": "Optional provenance note",
                },
            },
            "required": ["action"],
        }

    def _connect(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        conn.executescript(_SCHEMA)
        return conn

    async def execute(self, **kwargs: Any) -> str:
        action = (kwargs.get("action") or "").strip()
        if action == "search":
            return self._search(
                query=str(kwargs.get("query") or ""),
                limit=int(kwargs.get("limit") or 5),
            )
        if action == "add":
            return self._add(
                kind=str(kwargs.get("kind") or "fact"),
                category=str(kwargs.get("category") or ""),
                title=str(kwargs.get("title") or ""),
                content=str(kwargs.get("content") or ""),
                tags=str(kwargs.get("tags") or ""),
                source=str(kwargs.get("source") or ""),
            )
        if action == "update":
            entry_id = kwargs.get("id")
            if entry_id is None:
                return "Error: 'id' is required for update."
            return self._update(
                entry_id=int(entry_id),
                kind=kwargs.get("kind"),
                category=kwargs.get("category"),
                title=kwargs.get("title"),
                content=kwargs.get("content"),
                tags=kwargs.get("tags"),
            )
        return f"Error: unknown action '{action}'."

    def _search(self, query: str, limit: int) -> str:
        if not query.strip():
            return "Error: 'query' is required for search."
        limit = max(1, min(limit, 50))
        conn = self._connect()
        try:
            rows: list[sqlite3.Row] = []
            try:
                cur = conn.execute(
                    "SELECT e.id, e.kind, e.category, e.title, e.tags, e.content "
                    "FROM entries_fts f JOIN entries e ON e.id = f.rowid "
                    "WHERE entries_fts MATCH ? ORDER BY bm25(entries_fts) LIMIT ?",
                    (query, limit),
                )
                rows = cur.fetchall()
            except sqlite3.OperationalError:
                pat = f"%{query}%"
                cur = conn.execute(
                    "SELECT id, kind, category, title, tags, content "
                    "FROM entries WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? "
                    "ORDER BY updated_at DESC LIMIT ?",
                    (pat, pat, pat, limit),
                )
                rows = cur.fetchall()
            if not rows:
                return "No matches."
            out = [
                {
                    "id": r["id"],
                    "kind": r["kind"],
                    "category": r["category"],
                    "title": r["title"],
                    "tags": r["tags"],
                    "content": r["content"],
                }
                for r in rows
            ]
            return json.dumps(out, ensure_ascii=False, indent=2)
        finally:
            conn.close()

    def _add(
        self,
        *,
        kind: str,
        category: str,
        title: str,
        content: str,
        tags: str,
        source: str,
    ) -> str:
        if not category or not title or not content:
            return "Error: 'category', 'title', and 'content' are required for add."
        conn = self._connect()
        try:
            cur = conn.execute(
                "INSERT INTO entries(kind, category, title, content, tags, source) "
                "VALUES (?,?,?,?,?,?)",
                (kind, category, title, content, tags, source),
            )
            conn.commit()
            return f"Added #{cur.lastrowid}: [{kind}/{category}] {title}"
        finally:
            conn.close()

    def _update(
        self,
        *,
        entry_id: int,
        kind: Any,
        category: Any,
        title: Any,
        content: Any,
        tags: Any,
    ) -> str:
        fields: list[str] = []
        params: list[Any] = []
        for col, val in (
            ("kind", kind),
            ("category", category),
            ("title", title),
            ("content", content),
            ("tags", tags),
        ):
            if val is not None:
                fields.append(f"{col} = ?")
                params.append(val)
        if not fields:
            return "Error: nothing to update."
        fields.append("updated_at = datetime('now')")
        params.append(entry_id)
        conn = self._connect()
        try:
            cur = conn.execute(
                f"UPDATE entries SET {', '.join(fields)} WHERE id = ?",
                params,
            )
            conn.commit()
            if cur.rowcount == 0:
                return f"Error: entry #{entry_id} not found."
            return f"Updated #{entry_id}."
        finally:
            conn.close()

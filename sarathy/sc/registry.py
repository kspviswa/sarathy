"""Fleet registry — the gateway's node database (spec section 9, first bullet).

A SQLite table of nodes with the fields the design calls for: id, name, pairing
hash, last_seen, a capabilities mirror and a state.

Three rules shape the implementation:

* **The pairing key is never stored.** Only ``sha256(key)`` is kept, so a DB
  disclosure does not yield a credential. Pair proof comparison is constant-time.
* **The capabilities mirror is a mirror.** It exists for the dashboard and for
  Sarathy to plan against; it is *not* policy. Nothing here can widen what a node
  will accept — that lives on the node (spec section 6.2, section 11).
* **Health is derived, not stored.** ``online`` / ``stale`` / ``offline`` comes
  from ``last_seen`` against the watchdog grace, so a gateway restart shows the
  true state rather than a stale cached one.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# Node lifecycle states.
STATE_PENDING = "pending"  # added via the dashboard, not yet paired
STATE_PAIRING = "pairing"  # pair.request seen, pair.confirm not yet sent
STATE_ONLINE = "online"  # connected and heartbeating
STATE_OFFLINE = "offline"  # was connected, watchdog expired
STATE_REVOKED = "revoked"  # revoked from the dashboard

# Health badges derived from last_seen (job spec section H).
HEALTH_ONLINE = "online"
HEALTH_STALE = "stale"
HEALTH_OFFLINE = "offline"

# A node that has not been seen for this long is "stale" rather than "online".
# The SC heartbeats every 30s (spec section 5.3), so 90s is three missed beats:
# enough slack for one dropped packet, short enough to notice a dead host.
DEFAULT_WATCHDOG_GRACE_S = 90.0

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sc_nodes (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL DEFAULT '',
    pairing_hash    TEXT,
    state           TEXT NOT NULL DEFAULT 'pending',
    platform        TEXT NOT NULL DEFAULT '',
    arch            TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '',
    capabilities    TEXT NOT NULL DEFAULT '[]',
    capabilities_hash TEXT NOT NULL DEFAULT '',
    grants          TEXT NOT NULL DEFAULT '[]',
    services        TEXT NOT NULL DEFAULT '[]',
    last_seen       REAL,
    paired_at       REAL,
    revoked_at      REAL,
    pair_code       TEXT,
    note            TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sc_nodes_last_seen ON sc_nodes (last_seen);

CREATE TABLE IF NOT EXISTS sc_jobs (
    id          TEXT PRIMARY KEY,
    node        TEXT NOT NULL,
    type        TEXT NOT NULL,
    state       TEXT NOT NULL,
    workspace   TEXT NOT NULL DEFAULT '',
    progress    INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sc_jobs_node ON sc_jobs (node, updated_at);

CREATE TABLE IF NOT EXISTS sc_job_events (
    job_id   TEXT NOT NULL,
    ts       REAL NOT NULL,
    state    TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    message  TEXT NOT NULL DEFAULT '',
    payload  TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (job_id, ts)
);
CREATE INDEX IF NOT EXISTS sc_job_events_job ON sc_job_events (job_id, ts);

CREATE TABLE IF NOT EXISTS sc_approvals (
    id          TEXT PRIMARY KEY,
    node        TEXT NOT NULL,
    capability  TEXT NOT NULL,
    scope       TEXT,
    reason      TEXT NOT NULL DEFAULT '',
    call_id     TEXT,
    job_id      TEXT,
    grant       TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    decided_by  TEXT,
    note        TEXT,
    created_at  REAL NOT NULL,
    decided_at  REAL
);
CREATE INDEX IF NOT EXISTS sc_approvals_status ON sc_approvals (status, created_at);
"""


def key_proof(pairing_key: str) -> str:
    """What the gateway stores for a pairing key: sha256 hex, never the key."""
    return hashlib.sha256(pairing_key.encode("utf-8")).hexdigest()


def constant_time_eq(a: str, b: str) -> bool:
    """Constant-time comparison, so a wrong proof leaks no timing information."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _now() -> float:
    return time.time()


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Node:
    """One row of ``sc_nodes``."""

    id: str
    name: str = ""
    pairing_hash: str | None = None
    state: str = STATE_PENDING
    platform: str = ""
    arch: str = ""
    version: str = ""
    capabilities: list[dict[str, Any]] = field(default_factory=list)
    capabilities_hash: str = ""
    grants: list[dict[str, Any]] = field(default_factory=list)
    services: list[dict[str, Any]] = field(default_factory=list)
    last_seen: float | None = None
    paired_at: float | None = None
    revoked_at: float | None = None
    pair_code: str | None = None
    note: str = ""
    created_at: float = 0.0

    # ------------------------------------------------------------- derived state

    def health(self, grace_s: float = DEFAULT_WATCHDOG_GRACE_S, now: float | None = None) -> str:
        """Health badge from ``last_seen``.

        A revoked node is offline regardless of when it was last seen — the
        dashboard should never show a revoked node as healthy.
        """
        if self.state == STATE_REVOKED:
            return HEALTH_OFFLINE
        if self.last_seen is None:
            return HEALTH_OFFLINE
        current = _now() if now is None else now
        age = current - self.last_seen
        if age <= grace_s:
            return HEALTH_ONLINE
        if age <= grace_s * 3:
            return HEALTH_STALE
        return HEALTH_OFFLINE

    def age_s(self, now: float | None = None) -> float | None:
        if self.last_seen is None:
            return None
        return round(((_now() if now is None else now) - self.last_seen), 1)

    def risk_classes(self) -> list[str]:
        """The distinct risk classes this node exposes, for a compact badge row."""
        return sorted({str(c.get("risk", "")) for c in self.capabilities if c.get("risk")})

    def document(self, grace_s: float = DEFAULT_WATCHDOG_GRACE_S, now: float | None = None) -> dict[str, Any]:
        """The API/dashboard shape (job spec section H)."""
        return {
            "id": self.id,
            "name": self.name or self.id,
            "state": self.state,
            "health": self.health(grace_s, now),
            "last_seen": _iso(self.last_seen),
            "last_seen_age_s": self.age_s(now),
            "paired": bool(self.pairing_hash) and self.state != STATE_REVOKED,
            "paired_at": _iso(self.paired_at),
            "revoked_at": _iso(self.revoked_at),
            "platform": self.platform,
            "arch": self.arch,
            "version": self.version,
            "capabilities_hash": self.capabilities_hash,
            "capabilities": self.capabilities,
            "capability_names": [c.get("name") for c in self.capabilities],
            "risk_classes": self.risk_classes(),
            "grants": self.grants,
            "grant_count": len(self.grants),
            "services": self.services,
            "note": self.note,
            "created_at": _iso(self.created_at),
        }


class NodeRegistry:
    """SQLite-backed fleet registry. Safe for concurrent use within a process."""

    def __init__(self, path: Path | str | None = None) -> None:
        self._lock = threading.RLock()
        if path is None:
            self._path: Path | None = None
            self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        else:
            self._path = Path(path).expanduser()
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    @property
    def path(self) -> Path | None:
        return self._path

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ helpers

    def _row_to_node(self, row: sqlite3.Row) -> Node:
        return Node(
            id=row["id"],
            name=row["name"],
            pairing_hash=row["pairing_hash"],
            state=row["state"],
            platform=row["platform"],
            arch=row["arch"],
            version=row["version"],
            capabilities=_loads(row["capabilities"], []),
            capabilities_hash=row["capabilities_hash"],
            grants=_loads(row["grants"], []),
            services=_loads(row["services"], []),
            last_seen=row["last_seen"],
            paired_at=row["paired_at"],
            revoked_at=row["revoked_at"],
            pair_code=row["pair_code"],
            note=row["note"],
            created_at=row["created_at"],
        )

    def _write(self, node: Node) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO sc_nodes (
                    id, name, pairing_hash, state, platform, arch, version,
                    capabilities, capabilities_hash, grants, services,
                    last_seen, paired_at, revoked_at, pair_code, note, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    pairing_hash=excluded.pairing_hash,
                    state=excluded.state,
                    platform=excluded.platform,
                    arch=excluded.arch,
                    version=excluded.version,
                    capabilities=excluded.capabilities,
                    capabilities_hash=excluded.capabilities_hash,
                    grants=excluded.grants,
                    services=excluded.services,
                    last_seen=excluded.last_seen,
                    paired_at=excluded.paired_at,
                    revoked_at=excluded.revoked_at,
                    pair_code=excluded.pair_code,
                    note=excluded.note
                """,
                (
                    node.id,
                    node.name,
                    node.pairing_hash,
                    node.state,
                    node.platform,
                    node.arch,
                    node.version,
                    json.dumps(node.capabilities),
                    node.capabilities_hash,
                    json.dumps(node.grants),
                    json.dumps(node.services),
                    node.last_seen,
                    node.paired_at,
                    node.revoked_at,
                    node.pair_code,
                    node.note,
                    node.created_at,
                ),
            )
            self._conn.commit()

    # ----------------------------------------------------------------- CRUD

    def add(
        self,
        node_id: str,
        *,
        name: str = "",
        pairing_key: str | None = None,
        note: str = "",
    ) -> Node:
        """Register a node id, optionally pre-authorising a pairing key.

        This is the "add node" intent from the dashboard/API: it creates the row
        so a later ``pair.request`` from a matching id is accepted instead of
        being an unknown stranger.
        """
        node_id = node_id.strip()
        if not node_id:
            raise ValueError("node id must not be empty")
        with self._lock:
            existing = self.get(node_id)
            if existing:
                existing.note = note or existing.note
                if pairing_key:
                    existing.pairing_hash = key_proof(pairing_key)
                if existing.state == STATE_REVOKED:
                    existing.state = STATE_PENDING
                self._write(existing)
                return existing
        node = Node(
            id=node_id,
            name=name or node_id,
            pairing_hash=key_proof(pairing_key) if pairing_key else None,
            state=STATE_PENDING,
            note=note,
            created_at=_now(),
        )
        self._write(node)
        return node

    def get(self, node_id: str) -> Node | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM sc_nodes WHERE id = ?", (node_id,)).fetchone()
        return self._row_to_node(row) if row else None

    def list_nodes(self, *, include_offline: bool = True) -> list[Node]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM sc_nodes ORDER BY (last_seen IS NULL), last_seen DESC, id"
            ).fetchall()
        nodes = [self._row_to_node(r) for r in rows]
        if include_offline:
            return nodes
        return [n for n in nodes if n.state != STATE_REVOKED and n.last_seen is not None]

    def find_by_key_proof(self, proof: str) -> Node | None:
        """Look a node up by pairing-key proof.

        Every candidate is compared in constant time. Selecting on the hash in SQL
        would be fine *and* constant-time, but keeping the comparison explicit here
        documents the intent and keeps the comparison identical for every row.
        """
        if not proof:
            return None
        for node in self.list_nodes():
            if node.pairing_hash and constant_time_eq(node.pairing_hash, proof):
                return node
        return None

    def revoke(self, node_id: str) -> Node:
        """Revoke a node.

        The pairing hash is cleared, not just the flag: after revocation the node
        can no longer authenticate, which is the point of revoking rather than
        hiding. If it reconnects it will be refused by :meth:`accept_pairing`.
        """
        node = self.get(node_id)
        if node is None:
            raise KeyError(node_id)
        node.state = STATE_REVOKED
        node.pairing_hash = None
        node.revoked_at = _now()
        node.last_seen = None
        self._write(node)
        return node

    def delete(self, node_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM sc_nodes WHERE id = ?", (node_id,))
            self._conn.commit()
            return cur.rowcount > 0

    # ------------------------------------------------------------- pairing flow

    def accept_pairing(self, node_id: str, proof: str, *, name: str = "") -> Node:
        """Validate a ``pair.request`` proof.

        Two accepted cases, and one refused:

        * the node is **already registered** and its stored hash matches the proof;
        * the node is **new** — first-contact adoption, so a fresh host can pair
          without a dashboard round trip (the operator still has to have started
          the listener);
        * the node is registered with a **different** key, or is **revoked** —
          refused. Silently re-keying an existing node would let anyone who knew
          its id take it over.
        """
        with self._lock:
            existing = self.get(node_id)
            if existing and existing.state == STATE_REVOKED:
                raise PermissionError(f"node {node_id} is revoked")
            if existing and existing.pairing_hash:
                if not constant_time_eq(existing.pairing_hash, proof):
                    raise PermissionError(f"pairing key mismatch for node {node_id}")
            node = existing or Node(id=node_id, name=name or node_id, created_at=_now())
            node.pairing_hash = proof
            node.name = name or node.name or node_id
            node.state = STATE_PAIRING
            self._write(node)
            return node

    def mark_paired(self, node_id: str, session_token: str) -> Node:
        node = self.get(node_id)
        if node is None:
            raise KeyError(node_id)
        node.state = STATE_ONLINE
        node.paired_at = _now()
        node.last_seen = node.last_seen or _now()
        node.pair_code = None
        self._write(node)
        # The session token is handed to the node; the gateway keeps no copy of
        # it beyond the node row, so store only the fact that pairing succeeded.
        return node

    # -------------------------------------------------------------- liveness

    def touch(self, node_id: str, **fields: Any) -> Node:
        """Record liveness and any mirrored facts a heartbeat/hello carried."""
        node = self.get(node_id)
        if node is None:
            raise KeyError(node_id)
        node.last_seen = _now()
        if node.state in (STATE_PENDING, STATE_PAIRING):
            node.state = STATE_ONLINE
        if "platform" in fields and fields["platform"]:
            node.platform = fields["platform"]
        if "arch" in fields and fields["arch"]:
            node.arch = fields["arch"]
        if "version" in fields and fields["version"]:
            node.version = fields["version"]
        if "capabilities" in fields and fields["capabilities"] is not None:
            node.capabilities = list(fields["capabilities"])
        if "capabilities_hash" in fields and fields["capabilities_hash"]:
            node.capabilities_hash = fields["capabilities_hash"]
        if "grants" in fields and fields["grants"] is not None:
            node.grants = list(fields["grants"])
        if "services" in fields and fields["services"] is not None:
            node.services = list(fields["services"])
        self._write(node)
        return node

    def mark_offline(self, node_id: str) -> Node | None:
        """The watchdog fired: mark a node offline without discarding its record."""
        node = self.get(node_id)
        if node is None or node.state == STATE_REVOKED:
            return node
        node.state = STATE_OFFLINE
        self._write(node)
        return node

    def sweep(self, grace_s: float = DEFAULT_WATCHDOG_GRACE_S, now: float | None = None) -> list[str]:
        """Mark every node past the grace as offline. Returns the ids changed."""
        current = _now() if now is None else now
        changed: list[str] = []
        for node in self.list_nodes():
            if node.state in (STATE_REVOKED, STATE_PENDING):
                continue
            if node.last_seen is None:
                continue
            if current - node.last_seen > grace_s and node.state != STATE_OFFLINE:
                self.mark_offline(node.id)
                changed.append(node.id)
        return changed

    # ---------------------------------------------------------------- summary

    def fleet_summary(self, grace_s: float = DEFAULT_WATCHDOG_GRACE_S) -> dict[str, Any]:
        nodes = self.list_nodes()
        buckets = {HEALTH_ONLINE: 0, HEALTH_STALE: 0, HEALTH_OFFLINE: 0}
        for node in nodes:
            buckets[node.health(grace_s)] += 1
        return {
            "total": len(nodes),
            "online": buckets[HEALTH_ONLINE],
            "stale": buckets[HEALTH_STALE],
            "offline": buckets[HEALTH_OFFLINE],
            "revoked": sum(1 for n in nodes if n.state == STATE_REVOKED),
            "watchdog_grace_s": grace_s,
            "capabilities": sorted({c.get("name") for n in nodes for c in n.capabilities if c.get("name")}),
        }


def _loads(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # A corrupt mirror column must not take the fleet view down; the node's
        # real state lives on the node.
        return fallback


#: Environment override for the node database, used by the E2E harness and by any
#: operator who wants a fleet view separate from the production one.
ENV_REGISTRY_DB = "SC_REGISTRY_DB"


def default_registry_path() -> Path:
    """Default location for the SC node database.

    ``SC_REGISTRY_DB`` overrides it, which is how the E2E harness and the tests
    get a scratch database without patching call sites.
    """
    import os

    override = os.environ.get(ENV_REGISTRY_DB)
    if override:
        return Path(override).expanduser()

    from sarathy.config.loader import get_data_dir

    return get_data_dir() / "sc" / "nodes.db"


def open_default_registry() -> NodeRegistry:
    return NodeRegistry(default_registry_path())


def health_of(node: Node, grace_s: float = DEFAULT_WATCHDOG_GRACE_S) -> str:
    """Module-level helper so the API layer need not import the class."""
    return node.health(grace_s)


def iter_documents(
    nodes: Iterable[Node], grace_s: float = DEFAULT_WATCHDOG_GRACE_S
) -> list[dict[str, Any]]:
    return [n.document(grace_s) for n in nodes]

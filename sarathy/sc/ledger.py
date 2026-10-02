"""Job ledger + A2A state machine (spec section 5.4, section 7.3).

The ledger is the gateway's record of jobs and **the gateway owns the state**. The
SC reports transitions it observed; it never decides the final outcome (spec
section 5.4: "States are owned by the gateway job ledger; the SC never decides
final state — the gateway does, on SC evidence").

Event sourcing: every ``job.status`` / ``job.events`` / ``job.artifact`` is appended
to ``sc_job_events`` so a job timeline can be replayed (spec section 7.3). The
``sc_jobs`` row is a projection of that log, kept for fast dashboard reads.

For this slice the job *types* are registered but no executor is bound: a submit
moves a job to ``submitted`` and the ledger records that nothing will drive it.
That is deliberate — a ledger that claimed a job was running when no runner
existed would be lying in the one place an operator looks for the truth.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sarathy.sc import schemas

# A2A states (spec section 5.4).
STATE_SUBMITTED = "submitted"
STATE_RUNNING = "running"
STATE_INPUT_REQUIRED = "input-required"
STATE_COMPLETED = "completed"
STATE_FAILED = "failed"
STATE_CANCELED = "canceled"

#: Legal transitions. Terminal states have no outbound edge.
TRANSITIONS: dict[str, set[str]] = {
    STATE_SUBMITTED: {STATE_RUNNING, STATE_CANCELED, STATE_FAILED},
    STATE_RUNNING: {STATE_INPUT_REQUIRED, STATE_COMPLETED, STATE_FAILED, STATE_CANCELED},
    STATE_INPUT_REQUIRED: {STATE_RUNNING, STATE_CANCELED, STATE_FAILED},
    STATE_COMPLETED: set(),
    STATE_FAILED: set(),
    STATE_CANCELED: set(),
}

#: Job types registered for this slice (spec section 7.1).
JOB_TYPES = {
    "sdd": "SDD job (opencode headless in a workspace) — executor lands in Phase 4",
    "run": "Typed job template — executor lands in Phase 4",
    "svc": "Service bring-up — proxied to the node's service registry",
}

#: Which job types have an executor in this build.
JOB_TYPES_BOUND = {"svc"}


class LedgerError(RuntimeError):
    """Base class for ledger failures."""


class IllegalTransition(LedgerError):  # noqa: N818 - a *transition* is illegal
    """A reported state is not reachable from the current one."""


class UnknownJob(LedgerError):  # noqa: N818 - an unknown *job*
    """No such job id."""


def is_terminal(state: str) -> bool:
    return state in TRANSITIONS and not TRANSITIONS[state]


def can_transition(current: str, target: str) -> bool:
    return target in TRANSITIONS.get(current, set())


def _iso(ts: float | None = None) -> str:
    current = time.time() if ts is None else ts
    return datetime.fromtimestamp(current, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class Job:
    """The ledger's view of one job."""

    id: str
    node: str
    type: str
    state: str = STATE_SUBMITTED
    workspace: str = ""
    progress: int = 0
    message: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    artifacts: list[dict[str, Any]] = field(default_factory=list)

    def document(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "node": self.node,
            "type": self.type,
            "state": self.state,
            "workspace": self.workspace,
            "progress": self.progress,
            "message": self.message,
            "terminal": is_terminal(self.state),
            "executor_bound": self.type in JOB_TYPES_BOUND,
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
            "artifacts": self.artifacts,
        }


class JobLedger:
    """SQLite-backed job ledger. Shares the registry's connection."""

    def __init__(self, registry: Any) -> None:
        # The registry owns the sqlite connection and the schema; the ledger is a
        # second logical view over the same database rather than a second file to
        # keep consistent.
        self._registry = registry
        self._lock = threading.RLock()
        self._conn = registry._conn  # noqa: SLF001 - one DB, one connection
        self._blocked_calls: list[dict[str, Any]] = []

    # ------------------------------------------------------------------- jobs

    def submit(
        self, job_id: str, node: str, job_type: str, workspace: str = "", message: str = ""
    ) -> Job:
        """Register a job. Rejects unregistered types and duplicate ids."""
        if job_type not in JOB_TYPES:
            raise LedgerError(
                f"unknown job type {job_type!r}; registered: {', '.join(sorted(JOB_TYPES))}"
            )
        now = time.time()
        note = message or JOB_TYPES[job_type]
        with self._lock:
            existing = self.get(job_id)
            if existing is not None:
                raise LedgerError(f"job {job_id} already exists")
            self._conn.execute(
                """
                INSERT INTO sc_jobs (id, node, type, state, workspace, progress,
                                     message, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (job_id, node, job_type, STATE_SUBMITTED, workspace, 0, note, now, now),
            )
            self._conn.commit()
            self._append_event(job_id, STATE_SUBMITTED, 0, note, {"source": "gateway"})
        return self.get(job_id)  # type: ignore[return-value]

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM sc_jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        job = Job(
            id=row["id"],
            node=row["node"],
            type=row["type"],
            state=row["state"],
            workspace=row["workspace"],
            progress=row["progress"],
            message=row["message"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        job.artifacts = self.artifacts(job_id)
        return job

    def list_jobs(self, *, node: str | None = None, state: str | None = None, limit: int = 200) -> list[Job]:
        query = "SELECT id FROM sc_jobs"
        clauses: list[str] = []
        params: list[Any] = []
        if node:
            clauses.append("node = ?")
            params.append(node)
        if state:
            clauses.append("state = ?")
            params.append(state)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY updated_at DESC LIMIT ?"
        params.append(max(1, min(limit, 1000)))
        with self._lock:
            rows = self._conn.execute(query, params).fetchall()
        jobs = [self.get(row["id"]) for row in rows]
        return [j for j in jobs if j is not None]

    # -------------------------------------------------------------- transitions

    def apply_transition(
        self, job_id: str, state: str, progress: int | None = None, message: str = ""
    ) -> Job:
        """Apply a transition, rejecting an illegal one.

        A duplicate report of the current state is accepted as a no-op: nodes
        retry, and a retry that reports ``running → running`` is not an error worth
        dropping a heartbeat over.
        """
        if state not in TRANSITIONS:
            raise IllegalTransition(f"unknown job state {state!r}")
        with self._lock:
            job = self.get(job_id)
            if job is None:
                raise UnknownJob(job_id)
            if job.state == state:
                if message:
                    self._append_event(job_id, state, progress if progress is not None else job.progress, message)
                return job
            if not can_transition(job.state, state):
                raise IllegalTransition(
                    f"job {job_id} cannot go {job.state} → {state}"
                )
            now = time.time()
            new_progress = job.progress if progress is None else max(0, min(100, progress))
            self._conn.execute(
                "UPDATE sc_jobs SET state = ?, progress = ?, message = ?, updated_at = ? WHERE id = ?",
                (state, new_progress, message or job.message, now, job_id),
            )
            self._conn.commit()
            self._append_event(job_id, state, new_progress, message, {"source": "node"})
        return self.get(job_id)  # type: ignore[return-value]

    # --------------------------------------------------------- node-reported IO

    def record_status(self, node: str, payload: dict[str, Any]) -> Job:
        """Record a ``job.status`` frame from a node.

        ``progress`` is a fraction (0..1) in the schema — A2A's convention — so it
        is scaled to a percentage here, once, at the boundary. Keeping the wire
        format fractional and the storage integral means neither the node nor the
        dashboard has to guess which one it is looking at.
        """
        schemas.validate_payload(schemas.JOB_STATUS, payload)
        job_id = str(payload["job_id"])
        existing = self.get(job_id)
        if existing is None:
            # A node reporting a job the ledger never saw: adopt it rather than
            # dropping evidence. The state machine still has to be satisfied, so
            # this only works for a first report of ``submitted`` or later.
            self.submit(
                job_id,
                node,
                job_type=str(payload.get("type", "run")) if payload.get("type") in JOB_TYPES else "run",
                message="adopted from a node report",
            )
        if existing is not None and existing.node and node and existing.node != node:
            raise LedgerError(
                f"job {job_id} belongs to node {existing.node}, not {node}"
            )
        raw_progress = payload.get("progress")
        percent = None
        if raw_progress is not None:
            percent = max(0, min(100, int(round(float(raw_progress) * 100))))
        return self.apply_transition(
            job_id,
            str(payload["state"]),
            percent,
            str(payload.get("message", "")),
        )

    def record_event(self, node: str, payload: dict[str, Any]) -> None:
        """Append a ``job.events`` frame to the replay log."""
        schemas.validate_payload(schemas.JOB_EVENTS, payload)
        self._append_event(
            str(payload["job_id"]),
            STATE_RUNNING,
            int(round(float(payload.get("progress", 0) or 0) * 100)),
            str(payload.get("kind", "log")),
            {"source": "node", "node": node, "kind": payload.get("kind", "log"), "data": payload.get("data")},
        )

    def record_artifact(self, node: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Record a ``job.artifact`` frame."""
        schemas.validate_payload(schemas.JOB_ARTIFACT, payload)
        artifact = {
            "path": payload.get("path"),
            "kind": payload.get("kind"),
            "size_bytes": payload.get("size_bytes"),
            "content_ref": payload.get("content_ref"),
            "recorded_at": _iso(),
            "node": node,
        }
        with self._lock:
            self._append_event(
                str(payload["job_id"]),
                str(self.get(str(payload["job_id"])).state) if self.get(str(payload["job_id"])) else STATE_RUNNING,
                0,
                f"artifact {payload.get('path')}",
                {"source": "node", "artifact": artifact},
            )
        return artifact

    def artifacts(self, job_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT payload FROM sc_job_events WHERE job_id = ? ORDER BY ts", (job_id,)
            ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            payload = json.loads(row["payload"] or "{}")
            if "artifact" in payload:
                out.append(payload["artifact"])
        return out

    def timeline(self, job_id: str) -> list[dict[str, Any]]:
        """The replayable event log for one job (spec section 7.3)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT ts, state, progress, message, payload FROM sc_job_events "
                "WHERE job_id = ? ORDER BY ts, rowid",
                (job_id,),
            ).fetchall()
        return [
            {
                "ts": _iso(row["ts"]),
                "state": row["state"],
                "progress": row["progress"],
                "message": row["message"],
                "payload": json.loads(row["payload"] or "{}"),
            }
            for row in rows
        ]

    def note_blocked_call(self, node: str, call_id: str, reason: str) -> None:
        """Record that a tool call is parked awaiting an approval.

        Kept in memory: it is a UI hint, and the authoritative pending-approval
        record lives on the node plus in ``sc_approvals``.
        """
        self._blocked_calls.append(
            {"node": node, "call_id": call_id, "reason": reason, "ts": _iso()}
        )
        del self._blocked_calls[:-50]

    def blocked_calls(self) -> list[dict[str, Any]]:
        return list(self._blocked_calls)

    def counts(self) -> dict[str, int]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT state, COUNT(*) AS n FROM sc_jobs GROUP BY state"
            ).fetchall()
        out = {state: 0 for state in TRANSITIONS}
        for row in rows:
            out[row["state"]] = row["n"]
        return out

    def types(self) -> dict[str, str]:
        return {
            name: {"description": desc, "bound": name in JOB_TYPES_BOUND}
            for name, desc in JOB_TYPES.items()
        }

    # ----------------------------------------------------------------- internal

    def _append_event(
        self, job_id: str, state: str, progress: int, message: str, extra: dict[str, Any] | None = None
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO sc_job_events (job_id, ts, state, progress, message, payload) "
                "VALUES (?,?,?,?,?,?)",
                (job_id, time.time(), state, progress or 0, message or "", json.dumps(extra or {})),
            )
            self._conn.commit()

    # Approvals live in the same database so one connection owns the SC tables.

    def add_approval(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO sc_approvals
                    (id, node, capability, scope, reason, call_id, job_id, grant,
                     status, decided_by, note, created_at, decided_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    record["id"],
                    record["node"],
                    record["capability"],
                    record.get("scope"),
                    record.get("reason", ""),
                    record.get("call_id"),
                    record.get("job_id"),
                    json.dumps(record["grant"]) if record.get("grant") else None,
                    record.get("status", "pending"),
                    record.get("decided_by"),
                    record.get("note"),
                    record.get("created_at", time.time()),
                    record.get("decided_at"),
                ),
            )
            self._conn.commit()

    def update_approval(self, approval_id: str, *, status: str, decided_by: str = "", note: str = "") -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sc_approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?",
                (status, decided_by or None, note or None, time.time(), approval_id),
            )
            self._conn.commit()

    def get_approval(self, approval_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sc_approvals WHERE id = ?", (approval_id,)
            ).fetchone()
        return _approval_row(row) if row else None

    def list_approvals(self, *, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        query = "SELECT * FROM sc_approvals"
        params: list[Any] = []
        if status:
            query += " WHERE status = ?"
            params.append(status)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(max(1, min(limit, 1000)))
        with self._lock:
            rows = self._conn.execute(query, params).fetchall()
        return [_approval_row(row) for row in rows]


def _approval_row(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "node": row["node"],
        "capability": row["capability"],
        "scope": row["scope"],
        "reason": row["reason"],
        "call_id": row["call_id"],
        "job_id": row["job_id"],
        "grant": json.loads(row["grant"]) if row["grant"] else None,
        "status": row["status"],
        "decided_by": row["decided_by"],
        "note": row["note"],
        "created_at": _iso(row["created_at"]),
        "decided_at": _iso(row["decided_at"]),
    }

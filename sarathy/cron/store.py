"""SQLite-backed durable store for cron jobs.

The cron DB (~/.sarathy/cron/cron.db) is the single source of truth for job
definitions AND runtime state. The gateway scheduler, the CLI, and the agent
cron tool all read/write the same rows; atomic claims (UPDATE ... WHERE
next_run_at_ms <= now) make cross-process double-fire impossible.

Schema is versioned via PRAGMA user_version with idempotent migrations.
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from pathlib import Path
from typing import Callable

from loguru import logger

from sarathy.cron.types import CronJob, CronJobState, CronPayload, CronSchedule

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    schedule_kind    TEXT NOT NULL,
    at_ms            INTEGER,
    every_ms         INTEGER,
    expr             TEXT,
    tz               TEXT,
    payload_kind     TEXT NOT NULL DEFAULT 'agent_turn',
    message          TEXT NOT NULL,
    deliver          INTEGER NOT NULL DEFAULT 0,
    channel          TEXT,
    to_              TEXT,
    provider_role    TEXT NOT NULL DEFAULT '',
    delete_after_run INTEGER NOT NULL DEFAULT 0,
    next_run_at_ms   INTEGER,
    last_run_at_ms   INTEGER,
    last_status      TEXT,
    last_error       TEXT,
    run_count        INTEGER NOT NULL DEFAULT 0,
    error_count      INTEGER NOT NULL DEFAULT 0,
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id             TEXT PRIMARY KEY,
    job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    started_at_ms  INTEGER NOT NULL,
    finished_at_ms INTEGER,
    status         TEXT,
    error          TEXT,
    response       TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(enabled, next_run_at_ms);
"""


def _now_ms() -> int:
    return int(time.time() * 1000)


class SqliteCronStore:
    """Durable cron store backed by SQLite (WAL, atomic, cross-process)."""

    def __init__(
        self,
        db_path: Path | str,
        compute_next: Callable[[CronSchedule, int, int | None], int | None] | None = None,
    ):
        self.db_path = Path(db_path)
        self._compute_next = compute_next
        self._conn: sqlite3.Connection | None = None
        self._init()

    # ------------------------------------------------------------------ infra

    def _init(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; explicit BEGIN/COMMIT for claims
        )
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA busy_timeout=5000;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._conn.row_factory = sqlite3.Row
        self._migrate()

    def _migrate(self) -> None:
        row = self._conn.execute("PRAGMA user_version;").fetchone()
        version = row[0] if row else 0
        if version < 1:
            self._conn.executescript(_SCHEMA_V1)
            self._conn.execute("PRAGMA user_version = 1;")
            logger.info("Cron store initialized at {} (schema v1)", self.db_path)

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    # ------------------------------------------------------------- row mapping

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> CronJob:
        return CronJob(
            id=row["id"],
            name=row["name"],
            enabled=bool(row["enabled"]),
            schedule=CronSchedule(
                kind=row["schedule_kind"],
                at_ms=row["at_ms"],
                every_ms=row["every_ms"],
                expr=row["expr"],
                tz=row["tz"],
            ),
            payload=CronPayload(
                kind=row["payload_kind"],
                message=row["message"],
                deliver=bool(row["deliver"]),
                channel=row["channel"],
                to=row["to_"],
                provider_role=row["provider_role"],
            ),
            state=CronJobState(
                next_run_at_ms=row["next_run_at_ms"],
                last_run_at_ms=row["last_run_at_ms"],
                last_status=row["last_status"],
                last_error=row["last_error"],
            ),
            created_at_ms=row["created_at_ms"],
            updated_at_ms=row["updated_at_ms"],
            delete_after_run=bool(row["delete_after_run"]),
        )

    _JOB_COLS = (
        "id, name, enabled, schedule_kind, at_ms, every_ms, expr, tz, "
        "payload_kind, message, deliver, channel, to_, provider_role, "
        "delete_after_run, next_run_at_ms, last_run_at_ms, last_status, "
        "last_error, run_count, error_count, created_at_ms, updated_at_ms"
    )

    def _job_values(self, job: CronJob, run_count: int = 0, error_count: int = 0) -> tuple:
        return (
            job.id,
            job.name,
            1 if job.enabled else 0,
            job.schedule.kind,
            job.schedule.at_ms,
            job.schedule.every_ms,
            job.schedule.expr,
            job.schedule.tz,
            job.payload.kind,
            job.payload.message,
            1 if job.payload.deliver else 0,
            job.payload.channel,
            job.payload.to,
            job.payload.provider_role,
            1 if job.delete_after_run else 0,
            job.state.next_run_at_ms,
            job.state.last_run_at_ms,
            job.state.last_status,
            job.state.last_error,
            run_count,
            error_count,
            job.created_at_ms,
            job.updated_at_ms,
        )

    # ------------------------------------------------------------------- CRUD

    def list_jobs(self, include_disabled: bool = False) -> list[CronJob]:
        sql = f"SELECT {self._JOB_COLS} FROM jobs"
        if not include_disabled:
            sql += " WHERE enabled = 1"
        sql += " ORDER BY next_run_at_ms IS NULL, next_run_at_ms"
        rows = self._conn.execute(sql).fetchall()
        return [self._row_to_job(r) for r in rows]

    def get_job(self, job_id: str) -> CronJob | None:
        row = self._conn.execute(
            f"SELECT {self._JOB_COLS} FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        return self._row_to_job(row) if row else None

    def add_job(self, job: CronJob) -> None:
        placeholders = ", ".join("?" for _ in range(len(self._JOB_COLS.split(","))))
        self._conn.execute(
            f"INSERT INTO jobs ({self._JOB_COLS}) VALUES ({placeholders})",
            self._job_values(job),
        )

    def save_job(self, job: CronJob) -> None:
        """Upsert a full job row from a CronJob object (atomic, single stmt)."""
        cols = [c.strip() for c in self._JOB_COLS.split(",")]
        assignments = ", ".join(f"{c} = excluded.{c}" for c in cols)
        placeholders = ", ".join("?" for _ in cols)
        self._conn.execute(
            f"""
            INSERT INTO jobs ({self._JOB_COLS}) VALUES ({placeholders})
            ON CONFLICT(id) DO UPDATE SET {assignments}
            """,
            self._job_values(job),
        )

    def remove_job(self, job_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        return cur.rowcount > 0

    def set_enabled(self, job_id: str, enabled: bool) -> None:
        self._conn.execute(
            "UPDATE jobs SET enabled = ?, updated_at_ms = ? WHERE id = ?",
            (1 if enabled else 0, _now_ms(), job_id),
        )

    def count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]

    def next_wake_ms(self) -> int | None:
        row = self._conn.execute(
            "SELECT MIN(next_run_at_ms) AS n FROM jobs WHERE enabled = 1 AND next_run_at_ms IS NOT NULL"
        ).fetchone()
        return row["n"] if row and row["n"] is not None else None

    # ------------------------------------------------------------------ claims

    def claim_due(self, now_ms: int) -> CronJob | None:
        """Atomically claim the earliest due job and advance its schedule.

        Returns the claimed job (snapshot taken before the advance) or None.
        The claim and the schedule advance happen in one transaction, so a
        crash mid-run can never re-fire the same occurrence (Hermes-style
        pre-dispatch advance).
        """
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE;")
        try:
            row = conn.execute(
                "SELECT * FROM jobs WHERE enabled = 1 AND next_run_at_ms IS NOT NULL"
                " AND next_run_at_ms <= ? ORDER BY next_run_at_ms LIMIT 1",
                (now_ms,),
            ).fetchone()
            if row is None:
                conn.execute("COMMIT;")
                return None

            job = self._row_to_job(row)

            if job.schedule.kind == "at":
                if job.delete_after_run:
                    conn.execute("DELETE FROM jobs WHERE id = ?", (job.id,))
                else:
                    conn.execute(
                        "UPDATE jobs SET enabled = 0, next_run_at_ms = NULL, updated_at_ms = ? WHERE id = ?",
                        (now_ms, job.id),
                    )
            else:
                next_run = None
                if self._compute_next is not None:
                    next_run = self._compute_next(job.schedule, now_ms, now_ms)
                conn.execute(
                    "UPDATE jobs SET next_run_at_ms = ?, last_run_at_ms = ?, updated_at_ms = ? WHERE id = ?",
                    (next_run, now_ms, now_ms, job.id),
                )
            conn.execute("COMMIT;")
            return job
        except Exception:
            conn.execute("ROLLBACK;")
            raise

    # -------------------------------------------------------------------- runs

    def record_run_start(self, job_id: str, started_at_ms: int) -> str:
        run_id = uuid.uuid4().hex[:12]
        self._conn.execute(
            "INSERT INTO runs (id, job_id, started_at_ms) VALUES (?, ?, ?)",
            (run_id, job_id, started_at_ms),
        )
        return run_id

    def finish_run(
        self,
        job_id: str,
        run_id: str | None,
        status: str,
        error: str | None,
        response: str | None,
    ) -> None:
        finished = _now_ms()
        if run_id:
            self._conn.execute(
                "UPDATE runs SET finished_at_ms = ?, status = ?, error = ?, response = ? WHERE id = ?",
                (finished, status, error, response, run_id),
            )
        self._conn.execute(
            """UPDATE jobs SET last_status = ?, last_error = ?,
               run_count = run_count + 1,
               error_count = error_count + CASE WHEN ? = 'error' THEN 1 ELSE 0 END,
               updated_at_ms = ? WHERE id = ?""",
            (status, error, status, finished, job_id),
        )
"""Cron service for scheduling agent tasks.

SQLite-backed: job definitions and runtime state live in cron.db. The
scheduler sleeps until the earliest due time, claims due jobs atomically from
the DB (pre-dispatch advance → no double-fire, no re-fire after a crash), and
re-arms from the DB after every change. A local unix-socket control channel
lets the CLI wake the scheduler instantly — config/job edits go live without
a gateway restart and without polling.
"""

import asyncio
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Coroutine

from loguru import logger

from sarathy.cron.control import CronControlServer
from sarathy.cron.store import SqliteCronStore
from sarathy.cron.types import CronJob, CronJobState, CronPayload, CronSchedule


def _now_ms() -> int:
    return int(time.time() * 1000)


def _compute_next_run(schedule: CronSchedule, now_ms: int, last_run_at_ms: int | None = None) -> int | None:
    """Compute next run time in ms."""
    if schedule.kind == "at":
        return schedule.at_ms if schedule.at_ms and schedule.at_ms > now_ms else None

    if schedule.kind == "every":
        if not schedule.every_ms or schedule.every_ms <= 0:
            return None
        # Use last_run_at_ms to prevent drift, fallback to now_ms if never run
        last_run = last_run_at_ms or now_ms
        return last_run + schedule.every_ms

    if schedule.kind == "cron" and schedule.expr:
        try:
            from croniter import croniter
            from zoneinfo import ZoneInfo
            # Use caller-provided reference time for deterministic scheduling
            base_time = now_ms / 1000
            # Default to EST (America/New_York) when timezone not specified
            tz = ZoneInfo(schedule.tz) if schedule.tz else ZoneInfo("America/New_York")
            base_dt = datetime.fromtimestamp(base_time, tz=tz)
            cron = croniter(schedule.expr, base_dt)
            next_dt = cron.get_next(datetime)
            return int(next_dt.timestamp() * 1000)
        except Exception:
            return None

    return None


def _validate_schedule_for_add(schedule: CronSchedule) -> None:
    """Validate schedule fields that would otherwise create non-runnable jobs."""
    if schedule.tz and schedule.kind != "cron":
        raise ValueError("tz can only be used with cron schedules")

    if schedule.kind == "cron" and schedule.tz:
        try:
            from zoneinfo import ZoneInfo

            ZoneInfo(schedule.tz)
        except Exception:
            raise ValueError(f"unknown timezone '{schedule.tz}'") from None


class CronService:
    """Service for managing and executing scheduled jobs."""

    def __init__(
        self,
        db_path: Path | str,
        on_job: Callable[[CronJob], Coroutine[Any, Any, str | None]] | None = None,
        on_job_error: Callable[[CronJob], Coroutine[Any, Any, None]] | None = None,
    ):
        self.db_path = Path(db_path)
        self.store = SqliteCronStore(self.db_path, compute_next=_compute_next_run)
        self.on_job = on_job  # Callback to execute job, returns response text
        self.on_job_error = on_job_error  # Callback invoked when a job fails
        self._timer_task: asyncio.Task | None = None
        self._running = False
        # Guard for concurrent mutations within this process
        self._lock = asyncio.Lock()
        self._control: CronControlServer | None = None

    # ============================== Public API (sync) ==========================

    def list_jobs(self, include_disabled: bool = False) -> list[CronJob]:
        """List all jobs, sorted by next run."""
        return self.store.list_jobs(include_disabled=include_disabled)

    def status(self) -> dict:
        """Get service status."""
        return {
            "enabled": self._running,
            "jobs": self.store.count(),
            "next_wake_at_ms": self.store.next_wake_ms(),
        }

    # ============================ Public API (async) ===========================

    async def add_job(
        self,
        name: str,
        schedule: CronSchedule,
        message: str,
        deliver: bool = False,
        channel: str | None = None,
        to: str | None = None,
        delete_after_run: bool = False,
        provider_role: str = "",
    ) -> CronJob:
        """Add a new job."""
        async with self._lock:
            _validate_schedule_for_add(schedule)
            now = _now_ms()

            job = CronJob(
                id=str(uuid.uuid4())[:8],
                name=name,
                enabled=True,
                schedule=schedule,
                payload=CronPayload(
                    kind="agent_turn",
                    message=message,
                    deliver=deliver,
                    channel=channel,
                    to=to,
                    provider_role=provider_role,
                ),
                state=CronJobState(next_run_at_ms=_compute_next_run(schedule, now)),
                created_at_ms=now,
                updated_at_ms=now,
                delete_after_run=delete_after_run,
            )

            self.store.add_job(job)
            self._arm_timer()

            logger.info("Cron: added job '{}' ({})", name, job.id)
            return job

    async def remove_job(self, job_id: str) -> bool:
        """Remove a job by ID."""
        async with self._lock:
            removed = self.store.remove_job(job_id)
            if removed:
                self._arm_timer()
                logger.info("Cron: removed job {}", job_id)
            return removed

    async def enable_job(self, job_id: str, enabled: bool = True) -> CronJob | None:
        """Enable or disable a job."""
        async with self._lock:
            job = self.store.get_job(job_id)
            if job is None:
                return None
            job.enabled = enabled
            job.updated_at_ms = _now_ms()
            if enabled:
                job.state.next_run_at_ms = _compute_next_run(job.schedule, _now_ms())
            else:
                job.state.next_run_at_ms = None
            self.store.save_job(job)
            self._arm_timer()
            return job

    async def update_job(
        self,
        job_id: str,
        *,
        name: str | None = None,
        message: str | None = None,
        schedule: CronSchedule | None = None,
        deliver: bool | None = None,
        channel: str | None = None,
        to: str | None = None,
        provider_role: str | None = None,
        delete_after_run: bool | None = None,
    ) -> CronJob | None:
        """Edit a job's definition. Changes go live without a gateway restart."""
        async with self._lock:
            job = self.store.get_job(job_id)
            if job is None:
                return None

            if schedule is not None:
                _validate_schedule_for_add(schedule)
                job.schedule = schedule
                job.state.next_run_at_ms = _compute_next_run(schedule, _now_ms())
            if name is not None:
                job.name = name
            if message is not None:
                job.payload.message = message
            if deliver is not None:
                job.payload.deliver = deliver
            if channel is not None:
                job.payload.channel = channel
            if to is not None:
                job.payload.to = to
            if provider_role is not None:
                job.payload.provider_role = provider_role
            if delete_after_run is not None:
                job.delete_after_run = delete_after_run

            job.updated_at_ms = _now_ms()
            self.store.save_job(job)
            self._arm_timer()
            logger.info("Cron: updated job '{}' ({})", job.name, job.id)
            return job

    async def run_job(self, job_id: str, force: bool = False) -> bool:
        """Manually run a job (does not move its schedule)."""
        job = self.store.get_job(job_id)
        if job is None:
            return False
        if not force and not job.enabled:
            return False
        await self._execute_job(job)
        return True

    # ============================== Lifecycle =================================

    async def start(self) -> None:
        """Start the cron service: catch up missed jobs, arm the timer, open the
        control channel."""
        self._running = True

        # Execute any missed runs immediately on startup (existing semantics).
        now = _now_ms()
        while True:
            job = self.store.claim_due(now)
            if job is None:
                break
            logger.info("Cron: executing missed job '{}' ({}) at startup", job.name, job.id)
            await self._execute_job(job)

        self._arm_timer()

        self._control = CronControlServer(self)
        await self._control.start()

        logger.info("Cron service started with {} jobs", self.store.count())

    def stop(self) -> None:
        """Stop the cron service."""
        self._running = False
        if self._timer_task:
            self._timer_task.cancel()
            self._timer_task = None
        if self._control:
            self._control.close()
            self._control = None
        self.store.close()

    def notify_changed(self) -> None:
        """Re-arm the timer from the DB (invoked by the control channel)."""
        self._arm_timer()

    # ================================ Timer ===================================

    def _arm_timer(self) -> None:
        """Schedule the next timer tick, reading the earliest due time from the DB."""
        if self._timer_task:
            self._timer_task.cancel()
            self._timer_task = None

        next_wake = self.store.next_wake_ms()
        if not next_wake or not self._running:
            return

        delay_s = max(0, next_wake - _now_ms()) / 1000

        async def tick():
            await asyncio.sleep(delay_s)
            if self._running:
                await self._on_timer()

        self._timer_task = asyncio.create_task(tick())

    async def _on_timer(self) -> None:
        """Handle timer tick — claim and run all due jobs, then re-arm."""
        now = _now_ms()
        while True:
            job = self.store.claim_due(now)
            if job is None:
                break
            await self._execute_job(job)
        self._arm_timer()

    # =============================== Execution ================================

    async def _execute_job(self, job: CronJob) -> None:
        """Execute a single job and record the outcome in the DB."""
        start_ms = _now_ms()
        run_id: str | None = None
        try:
            run_id = self.store.record_run_start(job.id, start_ms)
        except Exception as e:
            logger.warning("Cron: could not record run start for '{}' ({}): {}", job.name, job.id, e)

        logger.info("Cron: executing job '{}' ({})", job.name, job.id)

        try:
            response = None
            if self.on_job:
                response = await self.on_job(job)

            job.state.last_status = "ok"
            job.state.last_error = None
            logger.info("Cron: job '{}' completed", job.name)

            self.store.finish_run(job.id, run_id, "ok", None, response)

        except Exception as e:
            job.state.last_status = "error"
            job.state.last_error = str(e)
            logger.error("Cron: job '{}' failed: {}", job.name, e)

            self.store.finish_run(job.id, run_id, "error", str(e), None)

            if self.on_job_error:
                try:
                    await self.on_job_error(job)
                except Exception as notify_err:
                    logger.warning("Cron: job '{}' error notifier failed: {}", job.name, notify_err)

        job.state.last_run_at_ms = start_ms
        job.updated_at_ms = _now_ms()

        # One-shots: the scheduler claim already disabled/deleted the row; mirror
        # it on the in-memory object and persist for direct (manual) runs.
        if job.schedule.kind == "at":
            job.enabled = False
            if not job.delete_after_run:
                self.store.set_enabled(job.id, False)
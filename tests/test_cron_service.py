import pytest

from sarathy.cron.service import CronService, _compute_next_run
from sarathy.cron.types import CronSchedule


def _service(store_path) -> CronService:
    """CronService with an async on-job callback that records calls."""
    service = CronService(store_path)
    service.fired = []
    async def on_job(job):
        service.fired.append(job)
        return "ok"
    service.on_job = on_job
    return service


def test_add_job_rejects_unknown_timezone(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="unknown timezone 'America/Vancovuer'"):
        service.add_job(
            name="tz typo",
            schedule=CronSchedule(kind="cron", expr="0 9 * * *", tz="America/Vancovuer"),
            message="hello",
        )

    assert service.list_jobs(include_disabled=True) == []


def test_add_job_accepts_valid_timezone(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")

    job = service.add_job(
        name="tz ok",
        schedule=CronSchedule(kind="cron", expr="0 9 * * *", tz="America/Vancouver"),
        message="hello",
    )

    assert job.schedule.tz == "America/Vancouver"
    assert job.state.next_run_at_ms is not None


def test_every_schedule_computes_next_run() -> None:
    next_run = _compute_next_run(
        CronSchedule(kind="every", every_ms=60_000), now_ms=1_000_000
    )
    assert next_run == 1_060_000


def test_at_schedule_past_returns_none() -> None:
    assert (
        _compute_next_run(CronSchedule(kind="at", at_ms=500_000), now_ms=1_000_000)
        is None
    )


def test_at_schedule_future_returns_time() -> None:
    assert (
        _compute_next_run(CronSchedule(kind="at", at_ms=1_500_000), now_ms=1_000_000)
        == 1_500_000
    )


@pytest.mark.asyncio
async def test_run_job_executes_callback(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")
    job = service.add_job(
        name="daily",
        schedule=CronSchedule(kind="every", every_ms=86_400_000),
        message="good morning",
    )

    ok = await service.run_job(job.id, force=True)

    assert ok is True
    assert len(service.fired) == 1
    assert service.fired[0].payload.message == "good morning"
    # one-shot: after "at" runs it disables; recurring still schedules
    assert job.state.last_status == "ok"


@pytest.mark.asyncio
async def test_run_job_unknown_id_is_false(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")
    assert await service.run_job("missing") is False


@pytest.mark.asyncio
async def test_disabled_job_requires_force(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")
    job = service.add_job(
        name="off", schedule=CronSchedule(kind="every", every_ms=86_400_000), message="x"
    )
    service.enable_job(job.id, enabled=False)

    assert await service.run_job(job.id) is False
    assert await service.run_job(job.id, force=True) is True


def test_list_jobs_excludes_disabled_by_default(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")
    job = service.add_job(
        name="a", schedule=CronSchedule(kind="every", every_ms=86_400_000), message="x"
    )
    service.enable_job(job.id, enabled=False)

    assert service.list_jobs() == []
    assert service.list_jobs(include_disabled=True) == [job]


def test_remove_job(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")
    job = service.add_job(
        name="a", schedule=CronSchedule(kind="every", every_ms=86_400_000), message="x"
    )
    assert service.remove_job(job.id) is True
    assert service.remove_job(job.id) is False


def test_persistence_round_trip(tmp_path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    service = _service(store_path)
    job = service.add_job(
        name="persisted",
        schedule=CronSchedule(kind="cron", expr="0 9 * * *"),
        message="hello",
        to="web-1",
    )

    reloaded = _service(store_path)
    jobs = reloaded.list_jobs(include_disabled=True)

    assert len(jobs) == 1
    assert jobs[0].id == job.id
    assert jobs[0].name == "persisted"
    assert jobs[0].schedule.expr == "0 9 * * *"
    assert jobs[0].payload.to == "web-1"


def test_status_reports_jobs(tmp_path) -> None:
    service = _service(tmp_path / "cron" / "jobs.json")
    service.add_job(
        name="a", schedule=CronSchedule(kind="every", every_ms=86_400_000), message="x"
    )
    status = service.status()
    assert status["enabled"] is False
    assert status["jobs"] == 1
    assert status["next_wake_at_ms"] is not None

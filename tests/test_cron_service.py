import pytest

from sarathy.cron.service import CronService
from sarathy.cron.types import CronJob, CronSchedule


def test_add_job_rejects_unknown_timezone(tmp_path) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    with pytest.raises(ValueError, match="unknown timezone 'America/Vancovuer'"):
        service.add_job(
            name="tz typo",
            schedule=CronSchedule(kind="cron", expr="0 9 * * *", tz="America/Vancovuer"),
            message="hello",
        )

    assert service.list_jobs(include_disabled=True) == []


def test_add_job_accepts_valid_timezone(tmp_path) -> None:
    service = CronService(tmp_path / "cron" / "jobs.json")

    job = service.add_job(
        name="tz ok",
        schedule=CronSchedule(kind="cron", expr="0 9 * * *", tz="America/Vancouver"),
        message="hello",
    )

    assert job.schedule.tz == "America/Vancouver"
    assert job.state.next_run_at_ms is not None


@pytest.mark.asyncio
async def test_on_job_error_invoked_when_job_execution_fails(tmp_path) -> None:
    """The on_job_error callback fires when a cron job raises, without masking
    the underlying job failure."""
    service = CronService(tmp_path / "cron" / "jobs.json")

    async def boom(_job: CronJob) -> str:
        raise RuntimeError("kaboom")

    error_calls: list[CronJob] = []

    async def on_error(job: CronJob) -> None:
        error_calls.append(job)

    service.on_job = boom
    service.on_job_error = on_error

    job = CronJob(
        id="abc123",
        name="failing job",
        schedule=CronSchedule(kind="at", at_ms=0),
        enabled=True,
        delete_after_run=False,
    )

    await service._execute_job(job)

    assert job.state.last_status == "error"
    assert job.state.last_error == "kaboom"
    assert error_calls == [job]
    assert job.enabled is False


@pytest.mark.asyncio
async def test_on_job_error_failure_does_not_mask_job_error(tmp_path) -> None:
    """A failing on_job_error notifier must not raise out of _execute_job, and
    the job's error state must be preserved."""
    service = CronService(tmp_path / "cron" / "jobs.json")

    async def boom(_job: CronJob) -> str:
        raise RuntimeError("job broke")

    async def on_error(job: CronJob) -> None:
        raise RuntimeError("notifier broke")

    service.on_job = boom
    service.on_job_error = on_error

    job = CronJob(
        id="def456",
        name="failing job 2",
        schedule=CronSchedule(kind="at", at_ms=0),
        enabled=True,
    )

    await service._execute_job(job)

    assert job.state.last_status == "error"
    assert job.state.last_error == "job broke"

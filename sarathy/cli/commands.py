"""CLI commands for sarathy."""

import asyncio
import os
import select
import sys
from pathlib import Path

import typer
from prompt_toolkit import PromptSession
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.history import FileHistory
from prompt_toolkit.patch_stdout import patch_stdout
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from sarathy import __logo__, __version__
from sarathy.config.schema import Config

app = typer.Typer(
    name="sarathy",
    help=f"{__logo__} sarathy - Personal AI Assistant",
    no_args_is_help=True,
)

console = Console()
EXIT_COMMANDS = {"exit", "quit", "/exit", "/quit", ":q"}


# ---------------------------------------------------------------------------
# CLI input: prompt_toolkit for editing, paste, history, and display
# ---------------------------------------------------------------------------

_PROMPT_SESSION: PromptSession | None = None
_SAVED_TERM_ATTRS = None  # original termios settings, restored on exit


def _flush_pending_tty_input() -> None:
    """Drop unread keypresses typed while the model was generating output."""
    try:
        fd = sys.stdin.fileno()
        if not os.isatty(fd):
            return
    except Exception:
        return

    try:
        import termios

        termios.tcflush(fd, termios.TCIFLUSH)
        return
    except Exception:
        pass

    try:
        while True:
            ready, _, _ = select.select([fd], [], [], 0)
            if not ready:
                break
            if not os.read(fd, 4096):
                break
    except Exception:
        return


def _restore_terminal() -> None:
    """Restore terminal to its original state (echo, line buffering, etc.)."""
    if _SAVED_TERM_ATTRS is None:
        return
    try:
        import termios

        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _SAVED_TERM_ATTRS)
    except Exception:
        pass


def _init_prompt_session() -> None:
    """Create the prompt_toolkit session with persistent file history."""
    global _PROMPT_SESSION, _SAVED_TERM_ATTRS

    # Save terminal state so we can restore it on exit
    try:
        import termios

        _SAVED_TERM_ATTRS = termios.tcgetattr(sys.stdin.fileno())
    except Exception:
        pass

    history_file = Path.home() / ".sarathy" / "history" / "cli_history"
    history_file.parent.mkdir(parents=True, exist_ok=True)

    _PROMPT_SESSION = PromptSession(
        history=FileHistory(str(history_file)),
        enable_open_in_editor=False,
        multiline=False,  # Enter submits (single line mode)
    )


def _print_agent_response(response: str, render_markdown: bool) -> None:
    """Render assistant response with consistent terminal styling."""
    content = response or ""
    body = Markdown(content) if render_markdown else Text(content)
    console.print()
    console.print(f"[cyan]{__logo__} sarathy[/cyan]")
    console.print(body)
    console.print()


def _is_exit_command(command: str) -> bool:
    """Return True when input should end interactive chat."""
    return command.lower() in EXIT_COMMANDS


async def _read_interactive_input_async() -> str:
    """Read user input using prompt_toolkit (handles paste, history, display).

    prompt_toolkit natively handles:
    - Multiline paste (bracketed paste mode)
    - History navigation (up/down arrows)
    - Clean display (no ghost characters or artifacts)
    """
    if _PROMPT_SESSION is None:
        raise RuntimeError("Call _init_prompt_session() first")
    try:
        with patch_stdout():
            return await _PROMPT_SESSION.prompt_async(
                HTML("<b fg='ansiblue'>You:</b> "),
            )
    except EOFError as exc:
        raise KeyboardInterrupt from exc


def version_callback(value: bool):
    if value:
        console.print(f"{__logo__} sarathy v{__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(None, "--version", "-v", callback=version_callback, is_eager=True),
):
    """sarathy - Personal AI Assistant."""
    pass


# ============================================================================
# Onboard / Setup
# ============================================================================


@app.command()
def onboard():
    """Interactive wizard to set up sarathy."""
    from sarathy.config.loader import get_config_path
    from sarathy.utils.helpers import get_workspace_path

    config_path = get_config_path()
    config = Config()

    workspace = get_workspace_path()
    if not workspace.exists():
        workspace.mkdir(parents=True, exist_ok=True)

    _create_workspace_templates(workspace)
    _create_global_skills()

    from sarathy.cli.onboard import run_onboarding

    run_onboarding(config, config_path, workspace)


@app.command("setup")
def setup(
    provider: str = typer.Option(
        "ollama", "--provider", "-p", help="Provider: ollama, lmstudio, vllm or custom"
    ),
    model: str = typer.Option("", "--model", "-m", help="Model name"),
    api_base: str = typer.Option("", "--api-base", help="Provider base URL (auto-defaults if empty)"),
    api_key: str = typer.Option("", "--api-key", help="API key for remote/custom providers"),
    host: str = typer.Option("0.0.0.0", "--host", help="Gateway bind host"),
    port: int = typer.Option(18790, "--port", help="Gateway port"),
    workspace: str = typer.Option(
        "", "--workspace", "-w", help="Workspace dir (defaults to <SARATHY_HOME>/workspace when set, else ~/.sarathy/workspace)"
    ),
    config_path: Path = typer.Option(
        None, "--config", "-c", help="Where to write the config file (default: ~/.sarathy/config.json)"
    ),
    force: bool = typer.Option(
        False, "--force", "-f", help="Overwrite an existing config file"
    ),
):
    """Generate a config file non-interactively from CLI args."""
    from sarathy.config.loader import get_config_path as default_config_path
    from sarathy.config.loader import save_config
    from sarathy.engine.provider import _LOCAL_ENDPOINTS
    from sarathy.utils.helpers import get_data_path, get_workspace_path

    key = provider.replace("-", "_").lower()
    if key not in _LOCAL_ENDPOINTS:
        names = ", ".join(sorted(_LOCAL_ENDPOINTS))
        console.print(f"[red]Unknown provider '{provider}'.[/red] Available: {names}")
        raise typer.Exit(1)

    default_models = {
        "ollama": "llama3",
        "lmstudio": "qwen2.5",
        "vllm": "qwen2.5",
        "custom": "gpt-4",
    }
    final_model = model or default_models[key]

    target = config_path or default_config_path()
    if target.exists() and not force:
        console.print(
            f"[yellow]Config already exists at {target}.[/yellow] "
            f"Use --force to overwrite it."
        )
        raise typer.Exit(1)

    cfg = Config()
    cfg.agents.defaults.provider = key
    cfg.agents.defaults.model = final_model
    if workspace:
        cfg.agents.defaults.workspace = workspace
    else:
        data_dir = get_data_path()
        if data_dir != Path.home() / ".sarathy":
            cfg.agents.defaults.workspace = str(data_dir / "workspace")
        else:
            cfg.agents.defaults.workspace = str(get_workspace_path())
    cfg.gateway.host = host
    cfg.gateway.port = port

    provider_cfg = getattr(cfg.providers, key)
    provider_cfg.api_base = api_base or _LOCAL_ENDPOINTS[key]
    provider_cfg.api_key = api_key or "dummy"

    save_config(cfg, target)
    ws_dir = Path(cfg.agents.defaults.workspace).expanduser()
    ws_dir.mkdir(parents=True, exist_ok=True)
    _create_workspace_templates(ws_dir)
    _create_global_skills()

    console.print(f"[green]✓ Config written to {target}[/green]")
    console.print(
        f"  Provider: [cyan]{key}[/cyan]  Model: [cyan]{final_model}[/cyan]  "
        f"Base: [cyan]{provider_cfg.api_base}[/cyan]"
    )
    console.print("  Start the gateway with: [cyan]sarathy gateway start[/cyan]")


def _create_workspace_templates(workspace: Path):
    """Create default workspace template files from bundled templates."""
    from importlib.resources import files as pkg_files

    templates_dir = pkg_files("sarathy") / "templates"

    for item in templates_dir.iterdir():
        if not item.name.endswith(".md"):
            continue
        dest = workspace / item.name
        if not dest.exists():
            dest.write_text(item.read_text(encoding="utf-8"), encoding="utf-8")
            console.print(f"  [dim]Created {item.name}[/dim]")

    memory_dir = workspace / "memory"
    memory_dir.mkdir(exist_ok=True)

    memory_template = templates_dir / "memory" / "MEMORY.md"
    memory_file = memory_dir / "MEMORY.md"
    if not memory_file.exists():
        memory_file.write_text(memory_template.read_text(encoding="utf-8"), encoding="utf-8")
        console.print("  [dim]Created memory/MEMORY.md[/dim]")

    history_file = memory_dir / "HISTORY.md"
    if not history_file.exists():
        history_file.write_text("", encoding="utf-8")
        console.print("  [dim]Created memory/HISTORY.md[/dim]")

    # Create workspace skills directory and populate with starter skills
    workspace_skills_dir = workspace / "skills"
    workspace_skills_dir.mkdir(exist_ok=True)

    # Copy starter skills from templates
    template_skills_dir = templates_dir / "skills"
    if template_skills_dir.is_dir():
        for skill_dir in template_skills_dir.iterdir():
            if skill_dir.is_dir():
                dest_skill_dir = workspace_skills_dir / skill_dir.name
                dest_skill_dir.mkdir(exist_ok=True)
                skill_file = skill_dir / "SKILL.md"
                dest_skill_file = dest_skill_dir / "SKILL.md"
                if not dest_skill_file.exists() and skill_file.is_file():
                    dest_skill_file.write_text(
                        skill_file.read_text(encoding="utf-8"), encoding="utf-8"
                    )
                    console.print(f"  [dim]Created skills/{skill_dir.name}/SKILL.md[/dim]")


def _create_global_skills():
    """Create ~/.sarathy/skills/ with built-in skills from the package."""

    global_skills_dir = Path.home() / ".sarathy" / "skills"
    global_skills_dir.mkdir(parents=True, exist_ok=True)

    # Get built-in skills from the package
    builtin_skills_dir = Path(__file__).parent.parent / "skills"

    if not builtin_skills_dir.exists():
        return

    # Copy built-in skills to ~/.sarathy/skills/ if they don't exist
    for skill_dir in builtin_skills_dir.iterdir():
        if skill_dir.is_dir():
            dest_skill_dir = global_skills_dir / skill_dir.name
            dest_skill_dir.mkdir(exist_ok=True)
            skill_file = skill_dir / "SKILL.md"
            dest_skill_file = dest_skill_dir / "SKILL.md"
            if not dest_skill_file.exists() and skill_file.is_file():
                dest_skill_file.write_text(skill_file.read_text(encoding="utf-8"), encoding="utf-8")
                console.print(f"  [dim]Copied built-in skill: {skill_dir.name}[/dim]")


# ============================================================================
# Provider Management
# ============================================================================

provider_app = typer.Typer(help="Manage providers")
app.add_typer(provider_app, name="provider")


@provider_app.command("list")
def provider_list():
    """List known providers and their default endpoints."""
    from sarathy.engine.provider import _LOCAL_ENDPOINTS

    table = Table(title="Providers")
    table.add_column("Provider", style="cyan")
    table.add_column("Default endpoint", style="yellow")
    for name, base in _LOCAL_ENDPOINTS.items():
        table.add_row(name, base)
    console.print(table)


@provider_app.command("login")
def provider_login(
    provider: str = typer.Argument(..., help="Provider name (e.g. 'ollama', 'lmstudio', 'vllm')"),
):
    """Authenticate with a provider (not needed for local providers)."""
    from sarathy.engine.provider import _LOCAL_ENDPOINTS

    key = provider.replace("-", "_")
    if key not in _LOCAL_ENDPOINTS:
        names = ", ".join(sorted(_LOCAL_ENDPOINTS))
        console.print(f"[red]Unknown provider: {provider}[/red]  Available: {names}")
        raise typer.Exit(1)

    console.print(
        f"[green]✓ {provider} is a local provider - no authentication needed.[/green]"
    )
    console.print(
        f"  Make sure {provider} is running and accessible at the configured endpoint."
    )


# ============================================================================
# Gateway / Server (start, stop, status, logs)
# ============================================================================

gateway_app = typer.Typer(help="Manage the sarathy gateway")
app.add_typer(gateway_app, name="gateway")


@gateway_app.command("start")
def gateway_start(
    port: int = typer.Option(18790, "--port", "-p", help="Gateway port"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
    foreground: bool = typer.Option(
        False, "--foreground", "-F", help="Run in the foreground (Docker/systemd)"
    ),
):
    """Start the sarathy gateway (background, or foreground with -F)."""
    if foreground:
        import asyncio

        from sarathy.gateway.run import run_gateway

        asyncio.run(run_gateway(port=port, verbose=verbose))
        return

    from sarathy.gateway.manager import get_log_file_path, is_gateway_running, start_gateway

    if is_gateway_running():
        console.print("[yellow]Gateway is already running.[/yellow]")
        raise typer.Exit(1)

    log_path = get_log_file_path()
    console.print(f"[dim]Starting gateway on port {port}...[/dim]")
    console.print(f"[dim]Logs: {log_path}[/dim]")

    try:
        start_gateway(port=port, verbose=verbose)
        console.print("[green]✓[/green] Gateway started (PID will be saved)")
    except RuntimeError as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@gateway_app.command("stop")
def gateway_stop():
    """Stop the running sarathy gateway."""
    from sarathy.gateway.manager import is_gateway_running, stop_gateway

    if not is_gateway_running():
        console.print("[yellow]Gateway is not running.[/yellow]")
        raise typer.Exit(1)

    if stop_gateway():
        console.print("[green]✓[/green] Gateway stopped")
    else:
        console.print("[red]Failed to stop gateway[/red]")
        raise typer.Exit(1)


@gateway_app.command("restart")
def gateway_restart(
    port: int = typer.Option(18790, "--port", "-p", help="Gateway port"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
):
    """Restart the sarathy gateway (stop and start)."""
    from sarathy.gateway.manager import (
        get_log_file_path,
        is_gateway_running,
        start_gateway,
        stop_gateway,
    )

    was_running = is_gateway_running()

    if was_running:
        console.print("[dim]Stopping gateway...[/dim]")
        if not stop_gateway():
            console.print("[red]Failed to stop gateway[/red]")
            raise typer.Exit(1)
        console.print("[green]✓[/green] Gateway stopped")

    console.print(f"[dim]Starting gateway on port {port}...[/dim]")
    console.print(f"[dim]Logs: {get_log_file_path()}[/dim]")

    try:
        start_gateway(port=port, verbose=verbose)
        console.print("[green]✓[/green] Gateway started")
    except RuntimeError as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@gateway_app.command("status")
def gateway_status():
    """Show gateway status."""
    from sarathy.gateway.manager import get_gateway_status

    status = get_gateway_status()

    if status["running"]:
        console.print("[green]✓[/green] Gateway is [bold]running[/bold]")
        console.print(f"  PID: {status['pid']}")
        console.print(f"  Log: {status['log_file']}")
    else:
        console.print("[dim]Gateway is [bold]not running[/bold]")


@gateway_app.command("logs")
def gateway_logs(
    lines: int = typer.Option(50, "--lines", "-n", help="Number of log lines to show"),
    follow: bool = typer.Option(False, "--follow", "-f", help="Follow log output (like tail -f)"),
):
    """Show gateway logs."""
    from sarathy.gateway.manager import get_recent_logs, is_gateway_running

    if not is_gateway_running():
        console.print("[yellow]Gateway is not running. No logs available.[/yellow]")
        raise typer.Exit(1)

    if follow:
        import signal
        import subprocess

        from sarathy.gateway.manager import get_latest_log_file

        log_file = get_latest_log_file()
        if not log_file or not log_file.exists():
            console.print("[red]No log file found.[/red]")
            raise typer.Exit(1)

        console.print(f"[dim]Following {log_file}... (Ctrl+C to exit)[/dim]")
        proc = None
        try:
            proc = subprocess.Popen(["tail", "-f", str(log_file)], stdout=1, stderr=1)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            proc.wait()
        except KeyboardInterrupt:
            if proc:
                proc.terminate()
        return

    logs = get_recent_logs(lines=lines)
    if logs:
        console.print(Panel(logs, title="Gateway Logs", border_style="dim"))
    else:
        console.print("[dim]No logs available.[/dim]")


# ============================================================================
# Agent Commands
# ============================================================================


@app.command()
def agent(
    message: str = typer.Option(None, "--message", "-m", help="Message to send to the agent"),
    session_id: str = typer.Option(None, "--session", "-s", help="Session ID"),
    markdown: bool = typer.Option(
        True, "--markdown/--no-markdown", help="Render assistant output as Markdown"
    ),
    logs: bool = typer.Option(
        False, "--logs/--no-logs", help="Show sarathy runtime logs during chat"
    ),
):
    """Interact with the agent directly (engine-backed REPL or one-shot)."""

    from loguru import logger

    from sarathy.engine.repl import run_agent

    if logs:
        logger.enable("sarathy")
    else:
        logger.disable("sarathy")

    asyncio.run(
        run_agent(
            message=message,
            session_id=session_id,
            markdown=markdown,
        )
    )


# ============================================================================
# Cron Commands
# ============================================================================

cron_app = typer.Typer(help="Manage scheduled tasks")
app.add_typer(cron_app, name="cron")


@cron_app.command("list")
def cron_list(
    all: bool = typer.Option(False, "--all", "-a", help="Include disabled jobs"),
):
    """List scheduled jobs."""
    from sarathy.config.loader import get_data_dir
    from sarathy.cron.service import CronService

    store_path = get_data_dir() / "cron" / "jobs.json"
    service = CronService(store_path)

    jobs = service.list_jobs(include_disabled=all)

    if not jobs:
        console.print("No scheduled jobs.")
        return

    table = Table(title="Scheduled Jobs")
    table.add_column("ID", style="cyan")
    table.add_column("Name")
    table.add_column("Schedule")
    table.add_column("Status")
    table.add_column("Next Run")

    import time
    from datetime import datetime as _dt
    from zoneinfo import ZoneInfo

    for job in jobs:
        # Format schedule
        if job.schedule.kind == "every":
            sched = f"every {(job.schedule.every_ms or 0) // 1000}s"
        elif job.schedule.kind == "cron":
            sched = (
                f"{job.schedule.expr or ''} ({job.schedule.tz})"
                if job.schedule.tz
                else (job.schedule.expr or "")
            )
        else:
            sched = "one-time"

        # Format next run
        next_run = ""
        if job.state.next_run_at_ms:
            ts = job.state.next_run_at_ms / 1000
            try:
                tz = ZoneInfo(job.schedule.tz) if job.schedule.tz else None
                next_run = _dt.fromtimestamp(ts, tz).strftime("%Y-%m-%d %H:%M")
            except Exception:
                next_run = time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))

        status = "[green]enabled[/green]" if job.enabled else "[dim]disabled[/dim]"

        table.add_row(job.id, job.name, sched, status, next_run)

    console.print(table)


@cron_app.command("add")
def cron_add(
    name: str = typer.Option(..., "--name", "-n", help="Job name"),
    message: str = typer.Option(..., "--message", "-m", help="Message for agent"),
    every: int = typer.Option(None, "--every", "-e", help="Run every N seconds"),
    cron_expr: str = typer.Option(None, "--cron", "-c", help="Cron expression (e.g. '0 9 * * *')"),
    tz: str | None = typer.Option(
        None, "--tz", help="IANA timezone for cron (e.g. 'America/Vancouver')"
    ),
    at: str = typer.Option(None, "--at", help="Run once at time (ISO format)"),
    deliver: bool = typer.Option(False, "--deliver", "-d", help="Deliver response to channel"),
    to: str = typer.Option(None, "--to", help="Recipient for delivery"),
    channel: str = typer.Option(
        None, "--channel", help="Channel for delivery (e.g. 'telegram', 'discord', 'email')"
    ),
):
    """Add a scheduled job."""
    from sarathy.config.loader import get_data_dir
    from sarathy.cron.service import CronService
    from sarathy.cron.types import CronSchedule

    if tz and not cron_expr:
        console.print("[red]Error: --tz can only be used with --cron[/red]")
        raise typer.Exit(1)

    # Determine schedule type
    if every:
        schedule = CronSchedule(kind="every", every_ms=every * 1000)
    elif cron_expr:
        schedule = CronSchedule(kind="cron", expr=cron_expr, tz=tz)
    elif at:
        import datetime

        dt = datetime.datetime.fromisoformat(at)
        schedule = CronSchedule(kind="at", at_ms=int(dt.timestamp() * 1000))
    else:
        console.print("[red]Error: Must specify --every, --cron, or --at[/red]")
        raise typer.Exit(1)

    store_path = get_data_dir() / "cron" / "jobs.json"
    service = CronService(store_path)

    try:
        job = service.add_job(
            name=name,
            schedule=schedule,
            message=message,
            deliver=deliver,
            to=to,
            channel=channel,
        )
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1) from e

    console.print(f"[green]✓[/green] Added job '{job.name}' ({job.id})")


@cron_app.command("remove")
def cron_remove(
    job_id: str = typer.Argument(..., help="Job ID to remove"),
):
    """Remove a scheduled job."""
    from sarathy.config.loader import get_data_dir
    from sarathy.cron.service import CronService

    store_path = get_data_dir() / "cron" / "jobs.json"
    service = CronService(store_path)

    if service.remove_job(job_id):
        console.print(f"[green]✓[/green] Removed job {job_id}")
    else:
        console.print(f"[red]Job {job_id} not found[/red]")


@cron_app.command("enable")
def cron_enable(
    job_id: str = typer.Argument(..., help="Job ID"),
    disable: bool = typer.Option(False, "--disable", help="Disable instead of enable"),
):
    """Enable or disable a job."""
    from sarathy.config.loader import get_data_dir
    from sarathy.cron.service import CronService

    store_path = get_data_dir() / "cron" / "jobs.json"
    service = CronService(store_path)

    job = service.enable_job(job_id, enabled=not disable)
    if job:
        status = "disabled" if disable else "enabled"
        console.print(f"[green]✓[/green] Job '{job.name}' {status}")
    else:
        console.print(f"[red]Job {job_id} not found[/red]")


@cron_app.command("run")
def cron_run(
    job_id: str = typer.Argument(..., help="Job ID to run"),
    force: bool = typer.Option(False, "--force", "-f", help="Run even if disabled"),
):
    """Manually run a job."""

    from loguru import logger

    from sarathy.config.loader import load_config
    from sarathy.engine.engine import SarathyEngine

    logger.disable("sarathy")

    async def run() -> None:
        engine = SarathyEngine(load_config())
        await engine.start()
        try:
            if await engine.cron_service.run_job(job_id, force=force):
                console.print("[green]✓[/green] Job executed")
            else:
                console.print(f"[red]Failed to run job {job_id}[/red]")
        finally:
            await engine.stop()

    asyncio.run(run())


# ============================================================================
# Status Commands
# ============================================================================


@app.command()
def status():
    """Show sarathy status."""
    from sarathy.config.loader import get_config_path, load_config

    config_path = get_config_path()
    config = load_config()
    workspace = config.workspace_path

    console.print(f"{__logo__} sarathy Status\n")

    console.print(
        f"Config: {config_path} {'[green]✓[/green]' if config_path.exists() else '[red]✗[/red]'}"
    )
    console.print(
        f"Workspace: {workspace} {'[green]✓[/green]' if workspace.exists() else '[red]✗[/red]'}"
    )

    if config_path.exists():
        label = {  # provider field name -> display label
            "custom": "Custom (OpenAI-compatible)",
            "ollama": "Ollama",
            "lmstudio": "LMStudio",
            "vllm": "vLLM",
        }

        console.print(f"Model: {config.agents.defaults.model}")

        # Show explicit provider from config
        provider_name = config.agents.defaults.provider
        console.print(f"Provider: {provider_name}")

        # Check API keys per configured provider
        for name, cfg in vars(config.providers).items():
            if not isinstance(cfg, type(config.providers.custom)):
                continue
            api_base = cfg.api_base
            if api_base:
                console.print(f"{label.get(name, name)}: [green]✓ {api_base}[/green]")
            else:
                has_key = bool(cfg.api_key) and cfg.api_key != "dummy"
                console.print(
                    f"{label.get(name, name)}: {'[green]✓[/green]' if has_key else '[dim]not set[/dim]'}"
                )

        # Web search status
        ws = config.tools.web.search
        if ws.enabled:
            env_key = "FIRECRAWL_API_KEY" if ws.provider == "firecrawl" else "BRAVE_API_KEY"
            has_key = bool(ws.api_key or os.environ.get(env_key))
            console.print(
                f"Web Search ({ws.provider}): {'[green]✓[/green]' if has_key else '[yellow]⚠ no API key[/yellow]'}"
            )
        else:
            console.print("Web Search: [dim]disabled[/dim]")


if __name__ == "__main__":
    app()

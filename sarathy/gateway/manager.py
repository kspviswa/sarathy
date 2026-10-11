"""Gateway manager for background process control and logging."""

import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from sarathy.utils.helpers import get_data_path

GATEWAY_PID_FILE = get_data_path() / "gateway.pid"


def get_logs_dir() -> Path:
    """Get the logs directory."""
    logs_dir = get_data_path() / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    return logs_dir


def get_log_file_path() -> Path:
    """Get a timestamp-based log file path."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return get_logs_dir() / f"gateway_{timestamp}.log"


def get_pid_file_path() -> Path:
    """Get the PID file path."""
    return GATEWAY_PID_FILE


def write_pid(pid: int) -> None:
    """Write the gateway PID to file."""
    get_pid_file_path().write_text(str(pid))


def read_pid() -> int | None:
    """Read the gateway PID from file."""
    try:
        if get_pid_file_path().exists():
            return int(get_pid_file_path().read_text().strip())
    except (ValueError, IOError):
        pass
    return None


def clear_pid() -> None:
    """Clear the PID file."""
    try:
        if get_pid_file_path().exists():
            get_pid_file_path().unlink()
    except IOError:
        pass


def is_gateway_running() -> bool:
    """Check if gateway is running."""
    pid = read_pid()
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        clear_pid()
        return False


def start_gateway(
    port: int = 18790,
    verbose: bool = False,
) -> subprocess.Popen:
    """
    Start the gateway as a background process.

    Args:
        port: Gateway port
        verbose: Enable verbose logging

    Returns:
        The subprocess.Popen object
    """
    if is_gateway_running():
        pid = read_pid()
        raise RuntimeError(f"Gateway is already running (PID: {pid})")

    log_file = get_log_file_path()

    cmd = [
        sys.executable,
        "-m",
        "sarathy.gateway.run",
        "--port",
        str(port),
    ]
    if verbose:
        cmd.append("--verbose")

    with open(log_file, "w") as log_fp:
        process = subprocess.Popen(
            cmd,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    import time

    time.sleep(1)

    if process.poll() is not None:
        clear_pid()
        raise RuntimeError("Gateway failed to start. Check logs for details.")

    write_pid(process.pid)

    return process


def _process_alive(pid: int) -> bool:
    """True while ``pid`` is a live, non-zombie process on this machine."""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
            state = f.read().split(") ", 1)[1].split(" ", 1)[0]
        return state != "Z"
    except FileNotFoundError:
        return False
    except Exception:
        # /proc unavailable — fall back to a signal-0 liveness probe.
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def stop_gateway(timeout: float = 5.0) -> bool:
    """
    Stop the gateway process (SIGTERM) and wait for it to actually exit.

    The gateway flushes its in-memory sessions during a graceful shutdown, so
    waiting for the process to exit means that flush finishes (and the listen
    port is released) before a replacement gateway starts — the two never race
    on the same session file or socket.

    Returns:
        True if the stop signal was delivered, False otherwise
    """
    pid = read_pid()
    if pid is None:
        return False

    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        clear_pid()
        return False

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and _process_alive(pid):
        time.sleep(0.05)

    clear_pid()
    return True


def get_gateway_status() -> dict:
    """
    Get the gateway status.

    Returns:
        Dict with status information
    """
    pid = read_pid()
    if pid is None:
        return {
            "running": False,
            "pid": None,
            "log_file": None,
        }

    running = is_gateway_running()
    log_file = get_logs_dir() / f"gateway_{datetime.now().strftime('%Y%m%d')}.log"

    return {
        "running": running,
        "pid": pid if running else None,
        "log_file": str(log_file) if running else None,
    }


def get_recent_logs(lines: int = 50) -> str:
    """
    Get recent log lines from the latest log file.

    Args:
        lines: Number of lines to retrieve

    Returns:
        Log content as string
    """
    latest_log = get_latest_log_file()
    if not latest_log:
        return ""

    try:
        content = latest_log.read_text()
        log_lines = content.strip().split("\n")
        return "\n".join(log_lines[-lines:])
    except IOError:
        return ""


def get_latest_log_file() -> Path | None:
    """Get the most recent gateway log file."""
    logs_dir = get_logs_dir()
    if not logs_dir.exists():
        return None

    log_files = sorted(logs_dir.glob("gateway_*.log"), reverse=True)
    if not log_files:
        return None

    return log_files[0]

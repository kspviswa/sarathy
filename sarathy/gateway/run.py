"""Gateway process: SarathyEngine + FastAPI portal in one process.

Entry point for ``python -m sarathy.gateway.run`` (spawned by the gateway
manager) and for running the server in the foreground.
"""

from __future__ import annotations

import asyncio
import sys
from contextlib import suppress
from pathlib import Path

from loguru import logger

from sarathy.config.loader import load_config
from sarathy.engine.engine import SarathyEngine
from sarathy.web.app import create_app
from sarathy.web.auth import Auth
from sarathy.web.notifier import Notifier


async def run_gateway(port: int = 18790, verbose: bool = False) -> None:
    """Run the sarathy portal until interrupted or a restart is requested."""
    if verbose:
        logger.enable("sarathy")

    config = load_config()
    engine = SarathyEngine(config, verbose=verbose)
    await engine.start()

    auth = Auth(data_dir=engine.data_dir, enabled=config.web.auth.enabled)
    notifier = Notifier(engine)
    app = create_app(engine, auth=auth, notifier=notifier)

    import uvicorn

    server = uvicorn.Server(
        uvicorn.Config(app, host=config.gateway.host, port=port, log_level="info")
    )

    pairing = (
        auth.token
        if config.web.auth.enabled
        else "(auth disabled)"
    )

    print("\n┌──────────────────────────────────────────────┐")
    print(f"│  Sarathy portal:  http://{config.gateway.host}:{port}")
    if engine.configured:
        print(f"│  Pairing token:   {pairing}")
    print("│  (data/config/extensions live in volumes)   │")
    print("└──────────────────────────────────────────────┘")
    if not engine.configured:
        print(
            "\n⚠  Sarathy is not configured yet — please configure it to start chatting.\n"
            "   Run `sarathy setup` (non-interactive) or `sarathy onboard` (wizard),\n"
            "   or edit the config file directly, then restart the gateway.\n"
        )

    restart_watcher = asyncio.create_task(_watch_restart(engine))

    try:
        await server.serve()
    except KeyboardInterrupt:
        pass
    finally:
        restart_watcher.cancel()
        with suppress(Exception):
            await engine.stop()
    logger.info("gateway shutdown complete")


async def _watch_restart(engine) -> None:
    """Watch for the restart flag (written by the web UI) and exit cleanly."""
    flag = Path(engine.data_dir) / "restart.flag"
    while True:
        await asyncio.sleep(2)
        if flag.exists():
            logger.info("restart flag detected — shutting down for restart")
            with suppress(Exception):
                flag.unlink()
            sys.exit(0)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18790)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    asyncio.run(run_gateway(port=args.port, verbose=args.verbose))


if __name__ == "__main__":
    main()

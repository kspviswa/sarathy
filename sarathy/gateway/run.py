"""Entry point for running the gateway directly (not via CLI)."""

import asyncio

from sarathy.agent.loop import AgentLoop
from sarathy.bus.queue import MessageBus
from sarathy.channels.manager import ChannelManager
from sarathy.config.loader import get_data_dir, load_config
from sarathy.cron.service import CronService
from sarathy.cron.types import CronJob
from sarathy.heartbeat.service import HeartbeatService
from sarathy.session.manager import SessionManager


async def run_gateway(port: int = 18790, verbose: bool = False):
    """Run the gateway (non-CLI entry point)."""
    if verbose:
        import logging

        logging.basicConfig(level=logging.DEBUG)

    config = load_config()

    # Ensure global skills are created on first run
    from sarathy.cli.commands import _create_global_skills

    _create_global_skills()

    bus = MessageBus()
    from sarathy.providers.manager import RuntimeProvider

    runtime = RuntimeProvider(config)

    provider = runtime.provider

    session_manager = SessionManager(
        config=config,
        workspace=config.workspace_path,
        max_cache_size=config.agents.defaults.session_cache_size,
        max_session_messages=config.agents.defaults.max_session_messages,
    )

    cron_store_path = get_data_dir() / "cron" / "jobs.json"
    cron = CronService(cron_store_path)

    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=config.workspace_path,
        model=runtime.model,
        temperature=runtime.temperature,
        max_tokens=runtime.max_tokens,
        max_iterations=config.agents.defaults.max_tool_iterations,
        memory_window=config.agents.defaults.memory_window,
        web_search_config=config.tools.web.search,
        exec_config=config.tools.exec,
        cron_service=cron,
        restrict_to_workspace=config.tools.restrict_to_workspace,
        session_manager=session_manager,
        session_cache_size=config.agents.defaults.session_cache_size,
        context_length=config.agents.defaults.context_length,
        mcp_servers=config.tools.mcp_servers,
        channels_config=config.channels,
        reasoning_effort=runtime.reasoning_effort,
        runtime=runtime,
    )

    # Initialize background reviewer for idle-time learning
    from sarathy.session.review import BackgroundReviewer
    reviewer = BackgroundReviewer(
        provider=provider,
        workspace=config.workspace_path,
        enabled=config.agents.review.enabled,
        cooldown_seconds=config.agents.review.cooldown_seconds,
        max_queue_size=config.agents.review.max_queue_size,
    )
    agent.reviewer = reviewer
    await reviewer.start()
    # Crash recovery: re-verify archives whose live review never completed.
    reviewer.schedule_archive_sweep(session_manager)

    async def on_cron_job(job: CronJob) -> str | None:
        response = await agent.process_direct(
            job.payload.message,
            session_key=f"cron:{job.id}",
            channel=job.payload.channel or "cli",
            chat_id=job.payload.to or "direct",
        )
        if job.payload.deliver and job.payload.to:
            from sarathy.bus.events import OutboundMessage

            await bus.publish_outbound(
                OutboundMessage(
                    channel=job.payload.channel or "cli",
                    chat_id=job.payload.to,
                    content=response or "",
                )
            )
        return response

    cron.on_job = on_cron_job

    # Initialize skill manager and command manager
    from sarathy.agent.skills import SkillManager
    from sarathy.core.commands import CommandManager

    skill_manager = SkillManager(config.workspace_path)
    command_manager = CommandManager()
    command_manager.sync_from_skill_manager(skill_manager)

    # Register built-in commands
    from sarathy.agent.builtin_commands import BUILTIN_COMMANDS

    for cmd in BUILTIN_COMMANDS.values():
        command_manager.register_command(
            name=cmd.name,
            description=cmd.description,
            skill_name="builtin",
            help_text=f"{cmd.description}\n\nUsage: /{cmd.name}"
            + (f" <{', '.join(cmd.subcommands)}>" if cmd.subcommands else ""),
        )

    # Start skill manager watching
    await skill_manager.start_watching()

    # Update commands when skills change
    async def on_skills_updated():
        command_manager.sync_from_skill_manager(skill_manager)
        await command_manager.notify_update()

    skill_manager.on_reload(on_skills_updated)

    # Initialize channels with command manager
    channels = ChannelManager(
        config,
        bus,
        command_manager=command_manager,
        session_manager=session_manager,
        runtime=runtime,
    )

    def _pick_heartbeat_target() -> tuple[str, str]:
        enabled = set(channels.enabled_channels)
        for item in session_manager.list_sessions():
            key = item.get("key") or ""
            if ":" not in key:
                continue
            channel, chat_id = key.split(":", 1)
            if channel in {"cli", "system"}:
                continue
            if channel in enabled and chat_id:
                return channel, chat_id
        return "cli", "direct"

    async def on_heartbeat_execute(tasks: str) -> str:
        channel, chat_id = _pick_heartbeat_target()

        async def _silent(*_args, **_kwargs):
            pass

        return await agent.process_direct(
            tasks,
            session_key="heartbeat",
            channel=channel,
            chat_id=chat_id,
            on_progress=_silent,
        )

    async def on_heartbeat_notify(response: str) -> None:
        from sarathy.bus.events import OutboundMessage

        channel, chat_id = _pick_heartbeat_target()
        if channel == "cli":
            return
        await bus.publish_outbound(
            OutboundMessage(channel=channel, chat_id=chat_id, content=response)
        )

    hb_cfg = config.gateway.heartbeat
    heartbeat = HeartbeatService(
        workspace=config.workspace_path,
        provider=provider,
        model=agent.model,
        on_execute=on_heartbeat_execute,
        on_notify=on_heartbeat_notify,
        interval_s=hb_cfg.interval_s,
        enabled=hb_cfg.enabled,
    )

    def _sync_heartbeat_runtime() -> None:
        heartbeat.provider = runtime.provider
        heartbeat.model = runtime.model

    runtime.on_change(_sync_heartbeat_runtime)

    async def _check_restart_flag() -> None:
        import json
        import os as _os

        from sarathy import __version__
        from sarathy.bus.events import OutboundMessage
        from sarathy.utils.helpers import get_data_path

        restart_flag_path = get_data_path() / "restart_pending.json"
        if not restart_flag_path.exists():
            return

        try:
            data = json.loads(restart_flag_path.read_text(encoding="utf-8"))
            channel = data.get("channel", "cli")
            chat_id = data.get("chat_id", "direct")

            from sarathy.providers.manager import describe_provider

            status_lines = ["✅ Gateway restarted successfully!", "", "📊 Sarathy Status:", ""]
            status_lines.append(f"Version: {__version__}")
            status_lines.append(f"Model: {config.agents.defaults.model}")
            status_lines.append(f"Provider: {config.get_provider_name()}")

            for pname, p in config.providers.items():
                try:
                    desc = describe_provider(pname, p)
                except Exception:
                    continue
                if desc["isLocal"]:
                    status_lines.append(
                        f"{desc['label']}: ✓ {desc['apiBase'] or 'not set'}"
                        if desc["apiBase"]
                        else f"{desc['label']}: not set"
                    )
                else:
                    has_key = bool(desc["hasApiKey"])
                    status_lines.append(f"{desc['label']}: {'✓' if has_key else 'not set'}")

            ws = config.tools.web.search
            if ws.enabled:
                env_key = "FIRECRAWL_API_KEY" if ws.provider == "firecrawl" else "BRAVE_API_KEY"
                has_key = bool(ws.api_key or _os.environ.get(env_key))
                status_lines.append(
                    f"Web Search ({ws.provider}): {'✓' if has_key else '⚠ no API key'}"
                )
            else:
                status_lines.append("Web Search: disabled")

            await bus.publish_outbound(
                OutboundMessage(channel=channel, chat_id=chat_id, content="\n".join(status_lines))
            )
        except Exception:
            pass
        finally:
            try:
                restart_flag_path.unlink(missing_ok=True)
            except Exception:
                pass

    channels_task = asyncio.create_task(channels.start_all())
    await asyncio.sleep(0.1)
    await _check_restart_flag()

    try:
        await cron.start()
        await heartbeat.start()
        await asyncio.gather(
            agent.run(),
            channels_task,
        )
    except KeyboardInterrupt:
        pass
    finally:
        await agent.close_mcp()
        heartbeat.stop()
        cron.stop()
        agent.stop()
        await channels.stop_all()


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18790)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    asyncio.run(run_gateway(port=args.port, verbose=args.verbose))


if __name__ == "__main__":
    main()

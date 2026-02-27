"""Entry point for running the gateway directly (not via CLI)."""

import asyncio

from sarathy.config.loader import load_config, get_data_dir
from sarathy.bus.queue import MessageBus
from sarathy.agent.loop import AgentLoop
from sarathy.channels.manager import ChannelManager
from sarathy.session.manager import SessionManager
from sarathy.cron.service import CronService
from sarathy.cron.types import CronJob
from sarathy.heartbeat.service import HeartbeatService


async def run_gateway(port: int = 18790, verbose: bool = False):
    """Run the gateway (non-CLI entry point)."""
    if verbose:
        import logging

        logging.basicConfig(level=logging.DEBUG)

    config = load_config()

    bus = MessageBus()
    from sarathy.providers.litellm_provider import LiteLLMProvider
    from sarathy.providers.custom_provider import CustomProvider
    from sarathy.providers.registry import find_by_name

    model = config.agents.defaults.model
    provider_name = config.get_provider_name(model)
    p = config.get_provider(model)

    if provider_name == "custom":
        provider = CustomProvider(
            api_key=p.api_key if p else "no-key",
            api_base=config.get_api_base(model) or "http://localhost:8000/v1",
            default_model=model,
        )
    else:
        spec = find_by_name(provider_name)
        if spec and spec.is_local:
            pass
        elif (
            not model.startswith("bedrock/")
            and not (p and p.api_key)
            and not (spec and spec.is_oauth)
        ):
            raise RuntimeError("No API key configured")

        provider = LiteLLMProvider(
            api_key=p.api_key if p else None,
            api_base=config.get_api_base(model),
            default_model=model,
            extra_headers=p.extra_headers if p else None,
            provider_name=provider_name,
        )

    session_manager = SessionManager(
        config.workspace_path,
        max_cache_size=config.agents.defaults.session_cache_size,
        max_session_messages=config.agents.defaults.max_session_messages,
    )

    cron_store_path = get_data_dir() / "cron" / "jobs.json"
    cron = CronService(cron_store_path)

    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=config.workspace_path,
        model=config.agents.defaults.model,
        temperature=config.agents.defaults.temperature,
        max_tokens=config.agents.defaults.max_tokens,
        max_iterations=config.agents.defaults.max_tool_iterations,
        memory_window=config.agents.defaults.memory_window,
        brave_api_key=config.tools.web.search.api_key or None,
        exec_config=config.tools.exec,
        cron_service=cron,
        restrict_to_workspace=config.tools.restrict_to_workspace,
        session_manager=session_manager,
        session_cache_size=config.agents.defaults.session_cache_size,
        context_length=config.agents.defaults.context_length,
        mcp_servers=config.tools.mcp_servers,
        channels_config=config.channels,
    )

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

    channels = ChannelManager(config, bus)

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

    try:
        await cron.start()
        await heartbeat.start()
        await asyncio.gather(
            agent.run(),
            channels.start_all(),
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

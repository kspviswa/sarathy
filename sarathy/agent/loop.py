"""Agent loop: the core processing engine."""

from __future__ import annotations

import asyncio
import json
import re
from contextlib import AsyncExitStack
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from loguru import logger

from sarathy.agent.builtin_commands import BUILTIN_COMMANDS, get_help_text
from sarathy.agent.context import ContextBuilder
from sarathy.agent.subagent import SubagentManager
from sarathy.agent.tools.cron import CronTool
from sarathy.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from sarathy.agent.tools.memory import MemoryTool
from sarathy.agent.tools.message import MessageTool
from sarathy.agent.tools.registry import ToolRegistry
from sarathy.agent.tools.shell import ExecTool
from sarathy.agent.tools.skill_manage import SkillManageTool
from sarathy.agent.tools.spawn import SpawnTool
from sarathy.agent.tools.web import WebFetchTool, create_web_search_tool
from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.providers.base import LLMProvider
from sarathy.session.manager import Session, SessionManager

if TYPE_CHECKING:
    from sarathy.config.schema import ChannelsConfig, ExecToolConfig, WebSearchConfig
    from sarathy.cron.service import CronService


class AgentLoop:
    """
    The agent loop is the core processing engine.

    It:
    1. Receives messages from the bus
    2. Builds context with history, memory, skills
    3. Calls the LLM
    4. Executes tool calls
    5. Sends responses back
    """

    def __init__(
        self,
        bus: MessageBus,
        provider: LLMProvider,
        workspace: Path,
        model: str | None = None,
        max_iterations: int = 40,
        temperature: float = 0.1,
        max_tokens: int = 4096,
        memory_window: int = 100,
        web_search_config: "WebSearchConfig | None" = None,
        exec_config: ExecToolConfig | None = None,
        cron_service: CronService | None = None,
        restrict_to_workspace: bool = False,
        session_manager: SessionManager | None = None,
        session_cache_size: int = 50,
        max_session_messages: int = 500,
        context_length: int = 8192,
        mcp_servers: dict | None = None,
        channels_config: ChannelsConfig | None = None,
        reasoning_effort: str | None = None,
        reviewer: Any | None = None,
        runtime: Any | None = None,
    ):
        from sarathy.config.schema import ExecToolConfig, WebSearchConfig

        self.bus = bus
        self.channels_config = channels_config
        self.provider = provider
        self.workspace = workspace
        self.model = model or provider.get_default_model()
        self.max_iterations = max_iterations
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.memory_window = memory_window
        self.context_length = context_length
        self.reasoning_effort = reasoning_effort
        self.runtime = runtime
        self.web_search_config = web_search_config or WebSearchConfig()
        self.exec_config = exec_config or ExecToolConfig()
        self.cron_service = cron_service
        self.restrict_to_workspace = restrict_to_workspace

        self.context = ContextBuilder(workspace)
        if session_manager is None:
            raise ValueError(
                "session_manager is required. Create one with SessionManager(config=config, ...) "
                "and pass it to AgentLoop."
            )
        self.sessions = session_manager
        self.memory_store = self.context.memory
        self.reviewer = reviewer
        self.tools = ToolRegistry()
        self.subagents = SubagentManager(
            provider=provider,
            workspace=workspace,
            bus=bus,
            model=self.model,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            web_search_config=self.web_search_config,
            exec_config=self.exec_config,
            restrict_to_workspace=restrict_to_workspace,
        )

        self._running = False
        self._mcp_servers = mcp_servers or {}
        self._mcp_stack: AsyncExitStack | None = None
        self._mcp_connected = False
        self._mcp_connecting = False
        self._active_tasks: dict[str, list[asyncio.Task]] = {}  # session_key -> tasks
        self._processing_lock = asyncio.Lock()
        self._register_default_tools()

    def _register_default_tools(self) -> None:
        """Register the default set of tools."""
        allowed_dir = self.workspace if self.restrict_to_workspace else None
        for cls in (ReadFileTool, WriteFileTool, EditFileTool, ListDirTool):
            self.tools.register(cls(workspace=self.workspace, allowed_dir=allowed_dir))
        self.tools.register(
            ExecTool(
                working_dir=str(self.workspace),
                timeout=self.exec_config.timeout,
                restrict_to_workspace=self.restrict_to_workspace,
                path_append=self.exec_config.path_append,
            )
        )
        if self.web_search_config.enabled:
            self.tools.register(
                create_web_search_tool(
                    provider=self.web_search_config.provider,
                    api_key=self.web_search_config.api_key,
                    max_results=self.web_search_config.max_results,
                )
            )
        self.tools.register(WebFetchTool())
        self.tools.register(
            MessageTool(
                send_callback=self.bus.publish_outbound, channels_config=self.channels_config
            )
        )
        self.tools.register(SpawnTool(manager=self.subagents))
        if self.cron_service:
            self.tools.register(CronTool(self.cron_service))
        self.tools.register(MemoryTool(memory_store=self.memory_store))
        self.tools.register(SkillManageTool(workspace=self.workspace))

    async def _connect_mcp(self) -> None:
        """Connect to configured MCP servers (one-time, lazy)."""
        if self._mcp_connected or self._mcp_connecting or not self._mcp_servers:
            return
        self._mcp_connecting = True
        from sarathy.agent.tools.mcp import connect_mcp_servers

        try:
            self._mcp_stack = AsyncExitStack()
            await self._mcp_stack.__aenter__()
            await connect_mcp_servers(self._mcp_servers, self.tools, self._mcp_stack)
            self._mcp_connected = True
        except Exception as e:
            logger.error("Failed to connect MCP servers (will retry next message): {}", e)
            if self._mcp_stack:
                try:
                    await self._mcp_stack.aclose()
                except Exception:
                    pass
                self._mcp_stack = None
        finally:
            self._mcp_connecting = False

    def _set_tool_context(self, channel: str, chat_id: str, message_id: str | None = None) -> None:
        """Update context for all tools that need routing info."""
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.set_context(channel, chat_id, message_id)

        if spawn_tool := self.tools.get("spawn"):
            if isinstance(spawn_tool, SpawnTool):
                spawn_tool.set_context(channel, chat_id)

        if cron_tool := self.tools.get("cron"):
            if isinstance(cron_tool, CronTool):
                cron_tool.set_context(channel, chat_id)

    @staticmethod
    def _strip_think(text: str | None, reasoning_content: str | None = None) -> str | None:
        """Strip <think>...</think> blocks that some models embed in content.

        If the text becomes empty after stripping, fall back to reasoning_content.
        """
        if not text:
            if reasoning_content:
                cleaned = re.sub(
                    r"<tool_call>[\s\S]*?</tool_call>\s*", "", reasoning_content
                ).strip()
                return cleaned if cleaned else None
            return None
        stripped = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
        return stripped if stripped else (reasoning_content if reasoning_content else None)

    @staticmethod
    def _tool_hint(tool_calls: list) -> str:
        """Format tool calls as concise hint, e.g. 'web_search("query")'."""

        def _fmt(tc):
            val = next(iter(tc.arguments.values()), None) if tc.arguments else None
            if not isinstance(val, str):
                return tc.name
            return f'{tc.name}("{val[:40]}…")' if len(val) > 40 else f'{tc.name}("{val}")'

        return ", ".join(_fmt(tc) for tc in tool_calls)

    @staticmethod
    def _extract_tool_calls_from_reasoning(reasoning_content: str | None) -> list[dict] | None:
        """Extract tool calls from reasoning_content (for models like Qwen3 via Ollama).

        Some backends (like Ollama) put tool calls in reasoning_content instead of
        structured tool_calls. This extracts them from the XML-like format.

        Returns list of tool call dicts with id, name, arguments, or None if no tool calls found.
        """
        if not reasoning_content:
            return None

        tool_calls = []
        pattern = r"<tool_call>\s*<function=(\w+)>(.*?)</function>\s*</tool_call>"
        matches = re.findall(pattern, reasoning_content, re.DOTALL)

        for func_name, params_block in matches:
            arguments = {}
            param_pattern = r"<parameter=(\w+)>(.*?)</parameter>"
            param_matches = re.findall(param_pattern, params_block, re.DOTALL)

            for key, value in param_matches:
                arguments[key] = value.strip()

            if arguments:
                tool_calls.append(
                    {
                        "id": f"reasoning_{len(tool_calls)}",
                        "type": "function",
                        "function": {
                            "name": func_name,
                            "arguments": json.dumps(arguments),
                        },
                    }
                )

        return tool_calls if tool_calls else None

    async def _run_agent_loop(
        self,
        initial_messages: list[dict],
        on_progress: Callable[..., Awaitable[None]] | None = None,
        reasoning_effort: str | None = None,
        channel: str | None = None,
        session_metadata: dict | None = None,
    ) -> tuple[str | None, list[str], list[dict], dict]:
        """Run the agent iteration loop. Returns (final_content, tools_used, messages, stats)."""
        import time

        streaming_enabled = False
        session_streaming = session_metadata.get("streaming", False) if session_metadata else False

        if session_streaming:
            streaming_enabled = True
        elif channel and self.channels_config:
            if channel == "telegram":
                streaming_enabled = self.channels_config.telegram.streaming
            elif channel == "discord":
                streaming_enabled = self.channels_config.discord.streaming
            elif channel == "dashboard":
                streaming_enabled = self.channels_config.dashboard.streaming

        messages = initial_messages
        iteration = 0
        final_content = None
        tools_used: list[str] = []
        total_tokens = 0
        total_time = 0.0

        while iteration < self.max_iterations:
            iteration += 1

            start_time = time.perf_counter()
            should_stream = streaming_enabled and on_progress is not None
            if self.reviewer:
                self.reviewer.mark_busy()
            try:
                response = await self.provider.chat(
                    messages=messages,
                    tools=self.tools.get_definitions(),
                    model=self.model,
                    temperature=self.temperature,
                    max_tokens=self.max_tokens,
                    reasoning_effort=reasoning_effort or self.reasoning_effort,
                    stream=should_stream,
                    on_progress=on_progress if should_stream else None,
                )
            finally:
                if self.reviewer:
                    self.reviewer.mark_idle()
            elapsed = time.perf_counter() - start_time

            if response.usage:
                total_tokens += response.usage.get("completion_tokens", 0)
                total_time += elapsed

            if response.has_tool_calls:
                if on_progress:
                    clean = self._strip_think(response.content, response.reasoning_content)
                    if clean:
                        await on_progress(clean)
                    await on_progress(self._tool_hint(response.tool_calls), tool_hint=True)

                tool_call_dicts = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                        },
                    }
                    for tc in response.tool_calls
                ]
                messages = self.context.add_assistant_message(
                    messages,
                    response.content,
                    tool_call_dicts,
                    reasoning_content=response.reasoning_content,
                )

                for tool_call in response.tool_calls:
                    tools_used.append(tool_call.name)
                    args_str = json.dumps(tool_call.arguments, ensure_ascii=False)
                    logger.info("Tool call: {}({})", tool_call.name, args_str[:200])
                    result = await self.tools.execute(tool_call.name, tool_call.arguments)
                    messages = self.context.add_tool_result(
                        messages, tool_call.id, tool_call.name, result
                    )
            else:
                # Check if tool calls are embedded in reasoning_content (Ollama/Qwen3 bug)
                extracted_tool_calls = self._extract_tool_calls_from_reasoning(
                    response.reasoning_content
                )

                if extracted_tool_calls:
                    # Found tool calls in reasoning_content - execute them!
                    logger.info(
                        "Found {} tool call(s) in reasoning_content", len(extracted_tool_calls)
                    )

                    if on_progress:
                        clean = self._strip_think(response.content, response.reasoning_content)
                        if clean:
                            await on_progress(clean)
                        # Create fake tool call objects for _tool_hint
                        fake_tcs = [
                            type(
                                "obj",
                                (object,),
                                {
                                    "name": tc["function"]["name"],
                                    "arguments": json.loads(tc["function"]["arguments"]),
                                },
                            )()
                            for tc in extracted_tool_calls
                        ]
                        await on_progress(self._tool_hint(fake_tcs), tool_hint=True)

                    # Add assistant message with tool calls
                    messages = self.context.add_assistant_message(
                        messages,
                        None,  # content is None, tool calls in reasoning
                        tool_calls=extracted_tool_calls,
                        reasoning_content=response.reasoning_content,
                    )

                    # Execute each tool call
                    for tc in extracted_tool_calls:
                        func_name = tc["function"]["name"]
                        func_args = json.loads(tc["function"]["arguments"])
                        tools_used.append(func_name)
                        logger.info(
                            "Tool call (from reasoning): {}({})",
                            func_name,
                            json.dumps(func_args)[:200],
                        )
                        result = await self.tools.execute(func_name, func_args)
                        messages = self.context.add_tool_result(
                            messages, tc["id"], func_name, result
                        )
                else:
                    # No tool calls found - regular response
                    # Don't persist error responses to session history — they can
                    # poison the context and cause permanent 400 loops (#1303).
                    if response.finish_reason == "error":
                        logger.error("LLM returned error: {}", (response.content or "")[:200])
                        final_content = (
                            response.content
                            or "Sorry, I encountered an error calling the AI model."
                        )
                        break

                    self.context.add_assistant_message(
                        messages,
                        response.content,
                        tool_calls=None,
                        reasoning_content=response.reasoning_content,
                    )
                    final_content = self._strip_think(response.content, response.reasoning_content)
                    if final_content is None:
                        logger.warning(
                            "Empty response from LLM (iteration {}). "
                            "This may be due to extended thinking tokens being stripped, "
                            "or an issue with the model/context. Consider checking reasoning_effort config.",
                            iteration,
                        )
                    break

        if final_content is None and iteration >= self.max_iterations:
            logger.warning("Max iterations ({}) reached", self.max_iterations)
            final_content = (
                f"I reached the maximum number of tool call iterations ({self.max_iterations}) "
                "without completing the task. You can try breaking the task into smaller steps."
            )

        stats = {
            "total_tokens": total_tokens,
            "total_time": total_time,
            "tokens_per_sec": (total_tokens / total_time) if total_time > 0 else 0,
        }

        return final_content, tools_used, messages, stats

    async def run(self) -> None:
        """Run the agent loop, dispatching messages as tasks to stay responsive to /stop."""
        self._running = True
        await self._connect_mcp()
        logger.info("Agent loop started")

        while self._running:
            try:
                msg = await asyncio.wait_for(self.bus.consume_inbound(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            if msg.content.strip().lower() == "/stop":
                await self._handle_stop(msg)
            else:
                task = asyncio.create_task(self._dispatch(msg))
                self._active_tasks.setdefault(msg.session_key, []).append(task)
                task.add_done_callback(
                    lambda t, k=msg.session_key: (
                        self._active_tasks.get(k, []) and self._active_tasks[k].remove(t)
                        if t in self._active_tasks.get(k, [])
                        else None
                    )
                )

    async def _handle_stop(self, msg: InboundMessage) -> None:
        """Cancel all active tasks and subagents for the session."""
        tasks = self._active_tasks.pop(msg.session_key, [])
        cancelled = sum(1 for t in tasks if not t.done() and t.cancel())
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        sub_cancelled = await self.subagents.cancel_by_session(msg.session_key)
        total = cancelled + sub_cancelled
        content = f"⏹ Stopped {total} task(s)." if total else "No active task to stop."
        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=content,
            )
        )

    async def _dispatch(self, msg: InboundMessage) -> None:
        """Process a message under the global lock."""
        async with self._processing_lock:
            try:
                response = await self._process_message(msg)
                if response is not None:
                    await self.bus.publish_outbound(response)
                elif msg.channel == "cli":
                    await self.bus.publish_outbound(
                        OutboundMessage(
                            channel=msg.channel,
                            chat_id=msg.chat_id,
                            content="",
                            metadata=msg.metadata or {},
                        )
                    )
            except asyncio.CancelledError:
                logger.info("Task cancelled for session {}", msg.session_key)
                raise
            except Exception:
                logger.exception("Error processing message for session {}", msg.session_key)
                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content="Sorry, I encountered an error.",
                    )
                )

    async def close_mcp(self) -> None:
        """Close MCP connections."""
        if self._mcp_stack:
            try:
                await self._mcp_stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                pass  # MCP SDK cancel scope cleanup is noisy but harmless
            self._mcp_stack = None

    def stop(self) -> None:
        """Stop the agent loop."""
        self._running = False
        logger.info("Agent loop stopping")

    def _refresh_runtime(self) -> bool:
        """Hot-reload model/provider/parameters from the persisted config.

        Returns True when settings changed (used by callers that need to react).
        """
        if self.runtime is None:
            return False
        return bool(self.runtime.apply_to(self))

    async def _process_message(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        """Process a single inbound message and return the response."""
        # Hot-reload model/provider/parameters (no gateway restart needed).
        self._refresh_runtime()

        # System messages: parse origin from chat_id ("channel:chat_id")
        if msg.channel == "system":
            channel, chat_id = (
                msg.chat_id.split(":", 1) if ":" in msg.chat_id else ("cli", msg.chat_id)
            )
            logger.info("Processing system message from {}", msg.sender_id)
            key = f"{channel}:{chat_id}"
            session = self.sessions.get_or_create(key)
            self._set_tool_context(channel, chat_id, msg.metadata.get("message_id"))
            history = session.get_history(max_messages=self.memory_window)
            messages = self.context.build_messages(
                history=history,
                current_message=msg.content,
                channel=channel,
                chat_id=chat_id,
            )
            final_content, _, all_msgs, _ = await self._run_agent_loop(messages, channel=channel)
            self._save_turn(session, all_msgs, 1 + len(history))
            self.sessions.save(session)
            return OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content=final_content or "Background task completed.",
            )

        preview = msg.content[:80] + "..." if len(msg.content) > 80 else msg.content
        logger.info("Processing message from {}:{}: {}", msg.channel, msg.sender_id, preview)

        key = session_key or msg.session_key
        session = self.sessions.get_or_create(key)

        # Slash commands - unified handler
        cmd = msg.content.strip().lower()

        # Check if it's a built-in command
        if cmd.startswith("/"):
            cmd_name = cmd.split()[0][1:]  # Remove leading /
            if cmd_name in BUILTIN_COMMANDS:
                builtin = BUILTIN_COMMANDS[cmd_name]
                # Parse command and args
                parts = cmd.split(None, 1)
                args = parts[1].strip() if len(parts) > 1 else ""

                # If no args AND has subcommands, show help
                # Otherwise, execute the command
                if not args and builtin.subcommands:
                    help_text = get_help_text(
                        builtin.name,
                        builtin.description,
                        builtin.subcommands,
                        builtin.has_status,
                    )
                    return OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content=help_text,
                    )

                # Handle each built-in command
                if cmd_name == "new":
                    return await self._handle_new_command(session, msg)
                elif cmd_name == "clear":
                    return self._handle_clear_command(session, msg)
                elif cmd_name == "think":
                    return self._handle_think_command(session, msg, args)
                elif cmd_name == "verbose":
                    return self._handle_verbose_command(session, msg, args)
                elif cmd_name == "streaming":
                    return self._handle_streaming_command(session, msg, args)
                elif cmd_name == "context":
                    return self._handle_context_command(session, msg)
                elif cmd_name == "remember":
                    return self._handle_remember_command(session, msg, args)
                elif cmd_name == "help":
                    return self._handle_help_command(session, msg)
                elif cmd_name == "stop":
                    # Stop is handled in the message loop, not here
                    pass
                elif cmd_name == "restart":
                    return await self._handle_restart_command(session, msg)
                elif cmd_name == "shell":
                    return await self._handle_shell_command(session, msg, args)
                elif cmd_name == "model":
                    return await self._handle_model_command(session, msg, args)
                elif cmd_name == "provider":
                    return await self._handle_provider_command(session, msg, args)

        self._set_tool_context(msg.channel, msg.chat_id, msg.metadata.get("message_id"))
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.start_turn()

        history = session.get_history(max_messages=self.memory_window)
        initial_messages = self.context.build_messages(
            history=history,
            current_message=msg.content,
            media=msg.media if msg.media else None,
            channel=msg.channel,
            chat_id=msg.chat_id,
        )

        async def _bus_progress(content: str, *, tool_hint: bool = False) -> None:
            meta = dict(msg.metadata or {})
            meta["_progress"] = True
            meta["_tool_hint"] = tool_hint
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=content,
                    metadata=meta,
                )
            )

        verbose_flag = session.metadata.get("verbose", False)

        effective_reasoning_effort = (
            session.metadata.get("reasoning_effort") or self.reasoning_effort
        )
        final_content, _, all_msgs, stats = await self._run_agent_loop(
            initial_messages,
            on_progress=on_progress or _bus_progress,
            reasoning_effort=effective_reasoning_effort,
            channel=msg.channel,
            session_metadata=session.metadata,
        )

        if final_content is None:
            logger.warning("Empty response generated - possible context length or model issue")
            final_content = (
                "I encountered an issue generating a response. This may be due to context length "
                "or model issues. Try /clear or starting a new conversation."
            )

        # Append tokens/sec if verbose is enabled
        if verbose_flag and stats:
            tps = stats.get("tokens_per_sec", 0)
            tokens = stats.get("total_tokens", 0)
            if tps > 0 and tokens > 0:
                final_content = f"{final_content}\n\n⚡ {tokens} tokens @ {tps:.1f} tokens/sec"

        self._save_turn(session, all_msgs, 1 + len(history))
        self.sessions.save(session)

        if self.reviewer and all_msgs:
            await self.reviewer.enqueue(all_msgs, session.key)

        metadata = dict(msg.metadata or {})
        metadata["_stats"] = stats
        metadata["_verbose"] = verbose_flag

        # Only suppress final reply if message tool sent to SAME target
        # Different targets = send to both (e.g., email + telegram)
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                sent_targets = message_tool.get_turn_sends()
                logger.info("Message tool sent to: {}", sent_targets)
                if (msg.channel, msg.chat_id) in sent_targets:
                    logger.info(
                        "Message tool sent to SAME target - suppressing final response to avoid duplicate"
                    )
                    # Message tool sent to same target - suppress to avoid duplicate
                    return None
                # Different target - don't suppress, let both responses through

        # Mark as final response so typing indicator knows to stop
        metadata["_final"] = True

        preview = final_content[:120] + "..." if len(final_content) > 120 else final_content
        logger.info("Response to {}:{}: {}", msg.channel, msg.sender_id, preview)

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=final_content,
            metadata=metadata,
        )

    async def _handle_new_command(self, session: Session, msg: InboundMessage) -> OutboundMessage:
        """Handle /new command - archive session and start fresh."""
        try:
            # Archive session to archived_sessions/ before clearing
            if session.messages:
                session.archive_session()
                logger.info("Archived session {} to archived_sessions/", session.key)
        except Exception as e:
            logger.error("Failed to archive session {}: {}", session.key, e)
            # Continue anyway - best effort archival

        # Clear session and start fresh
        session.clear()
        self.sessions.save(session)
        self.sessions.invalidate(session.key)

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content="✨ Session archived and started a new one.\n\nReady for a fresh conversation!",
        )

    def _handle_clear_command(self, session: Session, msg: InboundMessage) -> OutboundMessage:
        """Handle /clear command - clear session without saving."""
        session.clear()
        self.sessions.save(session)
        self.sessions.invalidate(session.key)
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content="🗑️ Session cleared (discarded without saving to memory).\n\nReady for a fresh conversation!",
        )

    def _handle_think_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /think command - set thinking level."""
        if args == "status":
            current = session.metadata.get("reasoning_effort") or self.reasoning_effort or "off"
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"🧠 Thinking: {current}\n\nUse /think <level> to change. Levels: off, low, medium, high, xhigh",
            )

        level = args.lower()
        valid_levels = {"off", "low", "medium", "high", "xhigh"}
        if level not in valid_levels:
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"Invalid level: {level}. Valid: off, low, medium, high, xhigh",
            )
        session.metadata["reasoning_effort"] = level
        self.sessions.save(session)
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=f"🧠 Thinking set to: {level}",
        )

    def _handle_verbose_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /verbose command - toggle token speed display."""
        if args == "status":
            current = session.metadata.get("verbose", False)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"📊 Verbose: {'on' if current else 'off'}",
            )

        if args in ("false", "off", "0"):
            session.metadata["verbose"] = False
            self.sessions.save(session)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="✅ Verbose mode disabled. Token speed will not be shown.",
            )
        elif args in ("true", "on", "1"):
            session.metadata["verbose"] = True
            self.sessions.save(session)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="✅ Verbose mode enabled. Token speed will be shown with responses.",
            )
        else:
            current = session.metadata.get("verbose", False)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"Usage: /verbose [true|false|status]\nCurrent: {'on' if current else 'off'}",
            )

    def _handle_streaming_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /streaming command - toggle streaming mode."""
        if args == "status":
            current = session.metadata.get("streaming", False)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"🔴 Streaming: {'enabled' if current else 'disabled'}",
            )

        if args in ("false", "off", "0"):
            session.metadata["streaming"] = False
            self.sessions.save(session)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="🔴 Streaming disabled for this session.",
            )
        elif args in ("true", "on", "1"):
            session.metadata["streaming"] = True
            self.sessions.save(session)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="🟢 Streaming enabled for this session.",
            )
        else:
            current = session.metadata.get("streaming", False)
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"Usage: /streaming [true|false|status]\nCurrent: {'enabled' if current else 'disabled'}",
            )

    def _handle_context_command(self, session: Session, msg: InboundMessage) -> OutboundMessage:
        """Handle /context command - show context usage."""
        msg_count = len(session.messages)
        unconsolidated = msg_count - session.last_consolidated
        context_length = self.context_length
        estimated_tokens = sum(len(m.get("content") or "") for m in session.messages) // 4
        estimated_tokens = min(estimated_tokens, unconsolidated * 500)
        usage_pct = (
            (min(unconsolidated, context_length) / context_length * 100) if context_length else 0
        )
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=f"""📊 Context Usage

Session: {msg.session_key}
Messages in session: {msg_count}
Messages to LLM: {unconsolidated} / {context_length}
Est. tokens (recent): ~{estimated_tokens:,}
Model context length: {self.context_length:,}

{"⚠️ Consider /new to start fresh" if usage_pct > 80 else "✅ Context OK"}""",
        )

    def _handle_remember_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /remember command - save to memory."""
        if not args:
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="Usage: /remember <text to save>\nExample: /remember My API key is abc123",
            )
        current_memory = self.context.memory.read_memory()
        new_memory = f"{current_memory}\n- {args}".strip()
        self.context.memory.write_memory(new_memory)
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=f'✅ Saved to memory: "{args}"',
        )

    def _handle_help_command(self, session: Session, msg: InboundMessage) -> OutboundMessage:
        """Handle /help command - show all commands."""
        lines = ["🪆 Available commands:"]
        for cmd in BUILTIN_COMMANDS.values():
            lines.append(f"/{cmd.name} — {cmd.description}")
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content="\n".join(lines),
        )

    async def _handle_restart_command(
        self, session: Session, msg: InboundMessage
    ) -> OutboundMessage:
        """Handle /restart command - restart the gateway service."""
        import json
        import subprocess

        from sarathy.utils.helpers import get_data_path

        restart_flag_path = get_data_path() / "restart_pending.json"

        restart_data = {
            "channel": msg.channel,
            "chat_id": msg.chat_id,
            "sender_id": msg.sender_id,
        }
        restart_flag_path.write_text(json.dumps(restart_data), encoding="utf-8")

        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="🔄 Gateway restart requested. Saving state and restarting...",
            )
        )

        subprocess.Popen(
            ["sarathy", "gateway", "restart"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        return None

    async def _handle_shell_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        if not args:
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="Usage: /shell <command>\n\nExecute a shell command and return raw output.",
            )

        result = await self.tools.execute("exec", {"command": args})

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=result,
            metadata={"_shell_raw": True},
        )

    async def _handle_model_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /model command - show/set the active model."""
        if self.runtime is None:
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="⚠️ Runtime settings are not available in this context.",
            )
        parts = args.split(None, 1)
        sub = parts[0].lower() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""

        if sub in ("status", ""):
            s = self.runtime.status()
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=(
                    f"🤖 Model: {s['model']}\n"
                    f"Provider: {s['provider']}\n"
                    f"Temperature: {s['temperature']}\n"
                    f"Max tokens: {s['max_tokens']}\n"
                    f"Reasoning: {s['reasoning_effort'] or 'off'}\n\n"
                    "Usage: /model set <name> · /model list · /model"
                ),
            )

        if sub == "list":
            from sarathy.providers.manager import list_models

            provider = self.runtime.config.agents.defaults.provider
            try:
                models = await asyncio.to_thread(list_models, provider, self.runtime.config)
            except ValueError as e:
                return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=f"⚠️ {e}")
            if not models:
                return OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=f"No models returned by provider '{provider}'.",
                )
            header = f"📦 Models available on '{provider}':\n\n"
            body = "\n".join(f"• {m}" for m in models)
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=header + body)

        if sub == "set" and rest:
            try:
                self.runtime.set_active(self.runtime.config.agents.defaults.provider, model=rest)
            except ValueError as e:
                return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=f"⚠️ {e}")
            self._refresh_runtime()
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"✅ Model set to {rest} (provider: {self.runtime.config.agents.defaults.provider}).",
            )

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content="Usage: /model [status] · /model list · /model set <model-name>",
        )

    async def _handle_provider_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /provider command - list/switch providers."""
        if self.runtime is None:
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="⚠️ Runtime settings are not available in this context.",
            )
        parts = args.split(None, 1)
        sub = parts[0].lower() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""

        if sub in ("status", ""):
            s = self.runtime.status()
            lines = [
                f"🔌 Provider: {s['provider']}",
                f"🤖 Model: {s['model']}",
                "",
                "Configured providers:",
            ]
            for name in s["providers"]:
                mark = "→" if name == s["provider"] else " "
                lines.append(f" {mark} {name}")
            lines.append("")
            lines.append("Usage: /provider list · /provider set <name> [model] · /provider models <name>")
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content="\n".join(lines))

        if sub == "list":
            s = self.runtime.status()
            lines = ["Configured providers:"]
            for name in s["providers"]:
                mark = "→" if name == s["provider"] else " "
                lines.append(f" {mark} {name}")
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content="\n".join(lines))

        if sub == "models" and rest:
            from sarathy.providers.manager import list_models

            try:
                models = await asyncio.to_thread(list_models, rest, self.runtime.config)
            except ValueError as e:
                return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=f"⚠️ {e}")
            if not models:
                return OutboundMessage(
                    channel=msg.channel, chat_id=msg.chat_id, content=f"No models from '{rest}'."
                )
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"📦 Models on '{rest}':\n\n" + "\n".join(f"• {m}" for m in models),
            )

        if sub == "set" and rest:
            pname = rest.split()[0]
            model = rest.split(None, 1)[1] if len(rest.split(None, 1)) > 1 else None
            try:
                self.runtime.set_active(pname, model=model)
            except ValueError as e:
                return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=f"⚠️ {e}")
            self._refresh_runtime()
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=(
                    f"✅ Switched provider to {pname}."
                    + (f" Model: {model}." if model else "")
                    + " Model changes apply immediately."
                ),
            )

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content="Usage: /provider [status] · /provider list · /provider set <name> [model] · /provider models <name>",
        )

    _TOOL_RESULT_MAX_CHARS = 500

    def _save_turn(self, session: Session, messages: list[dict], skip: int) -> None:
        """Save new-turn messages into session, truncating large tool results."""
        from datetime import datetime

        for m in messages[skip:]:
            # Skip assistant messages only if BOTH content AND tool_calls are empty
            # This preserves tool_calls in history (needed for context)
            if m.get("role") == "assistant":
                has_content = m.get("content")
                has_tool_calls = m.get("tool_calls")
                if not has_content and not has_tool_calls:
                    logger.debug("Skipping empty assistant message in _save_turn")
                    continue
            entry = {k: v for k, v in m.items() if k != "reasoning_content"}
            if entry.get("role") == "tool" and isinstance(entry.get("content"), str):
                content = entry["content"]
                if len(content) > self._TOOL_RESULT_MAX_CHARS:
                    entry["content"] = content[: self._TOOL_RESULT_MAX_CHARS] + "\n... (truncated)"
            entry.setdefault("timestamp", datetime.now().isoformat())
            session.messages.append(entry)
        session.updated_at = datetime.now()

    async def process_direct(
        self,
        content: str,
        session_key: str = "cli:direct",
        channel: str = "cli",
        chat_id: str = "direct",
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> str:
        """Process a message directly (for CLI or cron usage)."""
        await self._connect_mcp()
        msg = InboundMessage(channel=channel, sender_id="user", chat_id=chat_id, content=content)
        response = await self._process_message(
            msg, session_key=session_key, on_progress=on_progress
        )
        return response.content if response else ""

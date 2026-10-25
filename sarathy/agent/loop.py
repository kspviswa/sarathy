"""Agent loop: the core processing engine."""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from loguru import logger

from sarathy.agent.builtin_commands import BUILTIN_COMMANDS, get_help_text
from sarathy.agent.image_prep import prepare_image_data_url
from sarathy.providers.manager import RuntimeProvider
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
from sarathy.providers.thinking import strip_think
from sarathy.session.manager import Session, SessionManager
from sarathy.utils.tokens import estimate_messages_tokens, estimate_tokens

if TYPE_CHECKING:
    from sarathy.config.schema import ChannelsConfig, ExecToolConfig, WebSearchConfig
    from sarathy.cron.service import CronService


STEER_PROMPT_TEMPLATE = (
    "[⚡ Mid-turn steer from the user — this is the latest instruction. "
    "If it conflicts with the current task, the steer takes priority. "
    "Weave it into your next step.]\n\n{steer}"
)

# Fraction of the model context reserved for conversation history (the rest is
# system prompt + tool definitions). Used by the history trimmer on every turn.
HISTORY_BUDGET_RATIO = 0.6

# Session-topic piggyback signal: the main LLM ends every final user-facing
# response with exactly one trailing `<topic>{...}</topic>` machine line.
# End-anchored; tolerates trailing whitespace/newlines after the marker.
#
# The inner group is *tempered* (`(?:(?!</?topic>).)*`) so the match can never
# span across a marker boundary. Without this, a stray literal marker earlier
# in the reply (e.g. a quoted example) made the DOTALL `.*?` run from the FIRST
# `<topic>` to the trailing `</topic>`, truncating everything in between — see
# KB #457. Now only a genuine trailing marker is stripped.
TOPIC_MARKER_RE = re.compile(
    r"[ \t]*<topic>((?:(?!</?topic>).)*)</topic>[ \t]*\s*$", re.DOTALL
)
# Prompt asks for <= 6 words; hard-cap defensively at 8.
TOPIC_MAX_WORDS = 8

# Upper bound on the vision-provider describe call. A cold local model can take
# a while to load, but the turn must never hang indefinitely — on timeout the
# image is replaced by a "(timed out)" hint and the turn proceeds.
IMAGE_DESCRIBE_TIMEOUT_S = 120.0

# --------------------------------------------------------------------------- #
# /diary — the Charitham biographer side turn (spec 138)
# --------------------------------------------------------------------------- #

# The narrow prompt's craft source. Resolved against the gateway workspace
# first (~/.sarathy/workspace in production), then at its canonical location so
# the prompt survives a workspace that moved.
DIARY_SKILL_NAME = "diary-biographer"
DIARY_SKILL_PATH = "/home/kspviswa/.sarathy/workspace/skills/diary-biographer/SKILL.md"

# Charitham's capture CLI. Absolute path, invoked with python3 — the biographer
# has no other way in.
DIARY_CLI = "/home/kspviswa/portals/charitham/diary.py"

DIARY_SOURCES = ("telegram", "discord", "email", "dashboard", "cli")

# Instruction block that precedes the craft. Deliberately short and imperative:
# the failure this prompt exists to fix is a 12B model replying conversationally
# and never firing the tool, so the call is stated as mandatory and shown
# literally, twice, with the exact command shape.
DIARY_SYSTEM_PREAMBLE = """You are Sarathy's diary biographer. You write Viswa's life into \
Charitham.

You have exactly ONE job: the message below is first-person life content from
Viswa — record it into the diary by calling the `exec` tool, then reply with one
short line. You do not chat, you do not explain yourself, you do not ask
questions. Your only tool is `exec`; there is nothing else you can or need to do.

STEP 1 — DECIDE IF IT IS AN ENTRY.
Record it when the message is first-person life content: events that happened to
him, his family (Viyaan) or friends; moods and feelings; reflections and
realisations; decisions about his LIFE and the reasoning behind them.
Do NOT record technical instructions, work or task requests, code changes, job
commands, project admin, or anything addressed to Sarathy-as-assistant. If it is
clearly one of those, reply in ONE short line saying it is not a diary entry and
make NO tool call at all.
If it is genuinely ambiguous, record it anyway and pass `--confidence low`.

STEP 2 — WRITE THE THREE LAYERS.
  raw       : his exact words, verbatim and unedited. Never reword, never
              tidy, never translate them.
  narrative : 2-5 sentences of third-person biographical prose ("Viswa ...").
              What happened AND the mood underneath it — the arc, not a log
              line. Warm, precise, restrained. Never invent detail: the facts
              are his, the prose is yours. No advice, no judgement, no
              flattery, no moralising.
  thread    : 1-2 sentences connecting this entry to earlier ones — how it
              continues, echoes or turns a previous thread of his life. Run
              `python3 {cli} search "<topic>"` first if you need the thread.
              If it is genuinely the first of its kind, say so briefly.
  mood      : exactly one of
              joyful content calm grateful excited reflective curious
              determined tired anxious low sad angry restless mixed
  people    : comma-separated names, e.g. "Viyaan,Family" (omit the flag if none)
  tags      : comma-separated, lowercase, e.g. "family,milestone"

STEP 3 — RUN THE CAPTURE (MANDATORY).
For EVERY entry — even a single sentence — you MUST run this with `exec`:

  python3 {cli} add \\
    --raw "<his verbatim words>" \\
    --narrative "<your prose>" \\
    --thread "<how it connects>" \\
    --mood <one value from the taxonomy> \\
    --people "A,B" \\
    --tags "x,y" \\
    --source {source}

`--source {source}` is where this entry came from. The CLI prints the new entry
id; you do not need to quote it back, just make sure the call succeeded.

QUOTING IS YOUR PROBLEM TO SOLVE. His words can contain quotes, $, backticks
and newlines, so NEVER paste raw text straight into a double-quoted flag. Write
every long field to a temp file with a quoted heredoc and pass it with
"$(cat file)" — the shell never re-parses what comes out of the substitution:

  cat > /tmp/diary_raw.txt <<'DIARY_EOF'
  ...his verbatim words, exactly as written...
  DIARY_EOF
  python3 {cli} add \\
    --raw "$(cat /tmp/diary_raw.txt)" \\
    --narrative "$(cat /tmp/diary_narrative.txt)" \\
    --thread "$(cat /tmp/diary_thread.txt)" \\
    --mood calm --people "Viyaan" --tags "family" --source {source}

mood, people, tags and source are short and safe to write inline. Use
`--when <ISO>` only when he explicitly asks to backdate the entry.

STEP 4 — IMAGES.
When the message carries `[attached media: <paths>]`, the turn also carries
`[image description: ...]` text describing those images (one per image, in the
same order). Pass BOTH of them to the same `add` call:

  --images "<p1>,<p2>"        # comma-separated absolute paths, as listed
  --image-desc "<d1>||<d2>"    # double-pipe separated, positionally aligned

If the CLI rejects `--images` (an older build without the flag), run the same
add WITHOUT `--images`/`--image-desc` and append those descriptions to the end
of `--narrative` instead. Never drop the images silently.

STEP 5 — THE ACK.
After a successful call, reply with ONE short line in Sarathy's voice, e.g.
"Noted, sir." That is all. No summary of what you wrote, no quotation of the
command, no questions, no judgement, no advice.

THE ONE RULE THAT MATTERS: NO questions, NO judgement, NO advice. If he wants
advice he will ask for it outside this task. Violating that is the worst thing
you can do here."""

# Housekeeping that belongs to the gateway rather than the craft skill.
DIARY_SYSTEM_EPILOGUE = """Reference (CLI):
  python3 {cli} add ...   capture an entry (the command above)
  python3 {cli} search "<q>"   find earlier entries (for the thread layer)
  python3 {cli} list --limit 1   most recent entries
  python3 {cli} show <id>    one entry
  python3 {cli} stats     counts
Storage: ~/.sarathy/diary/diary.db (SQLite + FTS5), Markdown mirror in
~/.sarathy/diary/entries/YYYY-MM.md, browsable at http://127.0.0.1/charitham/."""


def _sanitize_source(channel: str | None) -> str:
    """Map a channel name onto a `--source` value the CLI understands."""
    c = (channel or "").strip().lower()
    return c if c in DIARY_SOURCES else "cli"


def _strip_frontmatter(text: str) -> str:
    """Drop a leading YAML frontmatter block (skill metadata, not craft)."""
    if not text.startswith("---"):
        return text
    parts = text.split("\n---", 1)
    if len(parts) == 2 and "\n" in parts[0]:
        return parts[1]
    return text


# Used when skills/diary-biographer/SKILL.md is missing: the same contract in
# miniature, so `/diary` still records correctly on a fresh workspace.
DIARY_CRAFT_FALLBACK = """# Diary craft (embedded fallback — SKILL.md not found)

Trigger: record first-person life content (events, family, moods, reflections,
life decisions). Refuse technical/work instructions with one short line and no
tool call. Ambiguous → record with `--confidence low`.

Three layers: `raw` is his exact words, verbatim. `narrative` is 2-4 sentences
of third-person biographical prose ("Viswa ..."), warm and restrained, capturing
what happened and the mood underneath. `thread` is 1-2 sentences connecting the
entry to earlier ones (`diary.py search "<topic>"` when needed).

Mood taxonomy (fixed, lowercase, one value): joyful content calm grateful
excited reflective curious determined tired anxious low sad angry restless
mixed. `people` and `tags` are comma-separated.

Tone: third person, past tense for the narrative, present for the thread. No
flattery, no diagnosis, no moralising, no invented detail. Facts are his; the
prose is mine.

The ack is one short line — "Noted, sir." — and nothing else."""


def strip_topic_marker(content: str) -> tuple[str, str | None]:
    """Split the trailing `<topic>` marker off user-facing content.

    Returns (cleaned_content, raw_json_or_None). When no marker is present
    the content is returned unchanged with None (graceful: model missed it).
    """
    match = TOPIC_MARKER_RE.search(content)
    if not match:
        return content, None
    cleaned = content[: match.start()].rstrip()
    return cleaned, match.group(1).strip()


def apply_topic_signal(metadata: dict, raw: str | None) -> str:
    """Apply one parsed topic signal against session metadata.

    Returns the action: "none" | "set" | "changed". Mutates ``metadata`` in
    place on set/change (persisted later via the existing sessions.save()
    path). Invalid JSON is ignored with a warning.
    """
    if raw is None:
        return "none"
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        logger.warning("Ignoring malformed topic marker: {}", raw[:100])
        return "none"
    if not isinstance(data, dict) or "set" not in data:
        logger.warning("Ignoring malformed topic marker (expected {{\"set\": ...}}): {}", raw[:100])
        return "none"
    if metadata.get("topic_user_set"):
        return "none"
    value = data.get("set")
    if value is None:
        return "none"
    if not isinstance(value, str) or not value.strip():
        return "none"
    title = " ".join(value.split())
    words = title.split()
    if len(words) > TOPIC_MAX_WORDS:
        title = " ".join(words[:TOPIC_MAX_WORDS])
    current = metadata.get("topic")
    if value_unchanged(current, title):
        return "none"
    action = "changed" if current else "set"
    metadata["topic"] = title
    return action


def value_unchanged(current: Any, title: str) -> bool:
    """Case-insensitive topic equality (gateway no-ops on repeats)."""
    return isinstance(current, str) and current.strip().lower() == title.strip().lower()


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
        # Back-off after a failed connect sweep, so a dead MCP endpoint does not
        # cost every single message its connect timeout.
        self._mcp_retry_at = 0.0
        self._mcp_retry_cooldown = 60.0
        self._active_tasks: dict[str, list[asyncio.Task]] = {}  # session_key -> tasks
        # Per-session lock registry (replaces single _processing_lock)
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()  # guards the _session_locks dict
        # Global lock for runtime hot-reload, config slash commands, archival sweep
        # Lock ordering: ALWAYS acquire _global_lock BEFORE any session lock (never reverse)
        self._global_lock = asyncio.Lock()
        # Optional semaphore to cap concurrent sessions
        # Read from agent config (channels_config has agents.defaults)
        max_concurrent = 4
        if channels_config is not None and hasattr(channels_config, 'agents'):
            max_concurrent = getattr(channels_config.agents.defaults, 'max_concurrent_sessions', 4)
        elif hasattr(self, 'sessions') and self.sessions is not None and hasattr(self.sessions, 'config'):
            max_concurrent = getattr(self.sessions.config.agents.defaults, 'max_concurrent_sessions', 4)
        if not isinstance(max_concurrent, int):
            max_concurrent = 4
        max_concurrent = max(1, min(16, max_concurrent))
        self._session_semaphore = asyncio.Semaphore(max_concurrent)
        self._active_main_turns: set[str] = set()  # session keys with a running main turn
        self._active_btw_turns: set[str] = set()  # session keys with a running /btw side turn
        # Authoritative per-session turn registry (spec 127 §A). Keyed by
        # session key; each entry is {active, state, turn_id, started_at}.
        # Dashboard clients render from this instead of guessing from the
        # best-effort WS stream, so a missed terminal frame can no longer strand
        # the UI. Popped at turn end.
        self._turn_registry: dict[str, dict[str, Any]] = {}

        self._register_default_tools()

    async def _acquire_session_lock(self, key: str) -> tuple[asyncio.Lock, str]:
        """Return (lock, key), creating the lock on first use."""
        async with self._locks_guard:
            lock = self._session_locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._session_locks[key] = lock
            return lock, key

    async def _release_session_lock(self, key: str) -> None:
        """Drop an idle lock so the registry cannot grow unbounded."""
        async with self._locks_guard:
            lock = self._session_locks.get(key)
            # _waiters is an internal asyncio.Lock attribute but stable across Python versions
            waiters = getattr(lock, '_waiters', None) if lock is not None else None
            if lock is not None and not lock.locked() and not waiters:
                self._session_locks.pop(key, None)

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
        """Connect to configured MCP servers (one-time, lazy).

        Bounded by each server's ``connect_timeout`` and never fatal: a server
        that is down is skipped, logged, and recorded in the persisted MCP
        health snapshot (surfaced by ``sarathy gateway status`` and the
        dashboard status page).
        """
        if self._mcp_connected or self._mcp_connecting or not self._mcp_servers:
            return
        if self._mcp_retry_at and time.monotonic() < self._mcp_retry_at:
            return
        self._mcp_connecting = True
        from sarathy.agent.tools.mcp import OK, connect_mcp_servers

        try:
            self._mcp_stack = AsyncExitStack()
            await self._mcp_stack.__aenter__()
            results = await connect_mcp_servers(
                self._mcp_servers, self.tools, self._mcp_stack
            )
            failed = [n for n, r in results.items() if r.get("status") != OK]
            if failed:
                # Partial success is still success — the working servers' tools
                # are registered and stay registered. Retry the broken ones on a
                # cooldown instead of on every message.
                logger.warning(
                    "MCP: {} of {} server(s) unavailable ({}); continuing without them",
                    len(failed),
                    len(results),
                    ", ".join(failed),
                )
                self._mcp_retry_at = time.monotonic() + self._mcp_retry_cooldown
            self._mcp_connected = True
        except Exception as e:
            logger.error("Failed to connect MCP servers (will retry later): {}", e)
            self._mcp_retry_at = time.monotonic() + self._mcp_retry_cooldown
            if self._mcp_stack:
                try:
                    await self._mcp_stack.aclose()
                except Exception:
                    pass
                self._mcp_stack = None
        finally:
            self._mcp_connecting = False

    def _set_tool_context(
        self, channel: str, chat_id: str, message_id: str | None = None, session_key: str | None = None
    ) -> None:
        """Update context for all tools that need routing info."""
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.set_context(channel, chat_id, message_id, session_key)

        if spawn_tool := self.tools.get("spawn"):
            if isinstance(spawn_tool, SpawnTool):
                spawn_tool.set_context(channel, chat_id)

        if cron_tool := self.tools.get("cron"):
            if isinstance(cron_tool, CronTool):
                cron_tool.set_context(channel, chat_id)

    @staticmethod
    def _strip_think(text: str | None) -> str | None:
        """Return the visible prose of ``text``, or ``None`` if there is none.

        Strips the ``<think>...</think>`` blocks some models (Qwen3, several
        local models) embed inline in their content. The monologue belongs to
        the thinking collapse — it is NEVER returned as visible text, and there
        is deliberately no fallback to the dedicated reasoning field: doing that
        published the private monologue as the message bubble while the same
        text was also streaming into the collapse (spec 131 §B).
        """
        return strip_think(text)

    @staticmethod
    def _has_image_content(messages: list[dict]) -> bool:
        """Return True if any message contains image content (image_url parts or [image: markers)."""
        for msg in messages:
            content = msg.get("content")
            if content is None:
                continue
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "image_url":
                        return True
            elif isinstance(content, str):
                if "[image:" in content:
                    return True
        return False

    def _local_image_to_data_url(self, path: str) -> str | None:
        """Convert a local image path to a data URL, downscaling large images.

        Multi-megabyte phone photos are shrunk to a sane vision budget before
        base64-encoding so the image provider isn't handed a huge pixel load.
        Returns the data URL if the file exists and is an image, None otherwise.
        """
        p = Path(path)
        if not p.is_absolute():
            # Resolve relative paths against workspace/media
            p = self.workspace / "media" / path
        return prepare_image_data_url(p)

    async def _describe_images_with_image_provider(
        self,
        messages: list[dict],
        image_provider: "LLMProvider",
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_thinking: Callable[..., Awaitable[None]] | None = None,
        channel: str | None = None,
        session_key: str | None = None,
    ) -> list[dict]:
        """Call the image provider to describe images, then rewrite user messages with description hints.

        Returns the rewritten messages with image parts replaced by [image description: ...] text hints.
        """
        # Find the last user message that contains image content
        user_msg_idx = -1
        user_msg = None
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            if msg.get("role") == "user" and self._has_image_content([msg]):
                user_msg_idx = i
                user_msg = msg
                break

        if user_msg is None:
            return messages

        # Extract image parts and text from the user message
        content = user_msg.get("content")
        image_parts = []
        text_parts = []

        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    image_parts.append(part)
                else:
                    text_parts.append(part)
        elif isinstance(content, str):
            # Handle [image: path] markers in string content
            import re
            parts = re.split(r"(\[image: [^\]]+\])", content)
            for part in parts:
                if part.startswith("[image:") and part.endswith("]"):
                    url = part[7:-1].strip()
                    # http(s) URLs pass through unchanged
                    if url.startswith("http://") or url.startswith("https://"):
                        image_parts.append({"type": "image_url", "image_url": {"url": url}})
                    else:
                        # Local path: resolve and base64-encode
                        data_url = self._local_image_to_data_url(url)
                        if data_url is not None:
                            image_parts.append({"type": "image_url", "image_url": {"url": data_url}})
                        # Missing file or non-image -> skip (drop marker)
                elif part.strip():
                    text_parts.append({"type": "text", "text": part})

        if not image_parts:
            return messages

        # Describe each image individually so a multi-image turn yields clean,
        # per-image descriptions (a single batched call tends to merge or drop
        # subjects). Each image gets its own progress frame and its own bounded
        # timeout, so the user always sees which image is in flight.
        system_prompt = (
            "You are an image description service. Describe the image in detail: "
            "subjects, text/OCR, layout, colors."
        )
        user_text = " ".join(
            p.get("text", "")
            for p in text_parts
            if isinstance(p, dict) and p.get("type") == "text"
        )

        total = len(image_parts)
        descriptions: list[str] = []

        async def _phase(label: str) -> None:
            """Announce one image-pipeline phase (spec 134 §A).

            A `tool_hint=True` progress frame so the dashboard can show it as
            the live status label — but ALSO tagged `phase=True`, which exempts
            it from the outbound dispatcher's `send_tool_hints` gate. These are
            user-facing narration, not tool-call noise: without the exemption
            they were silently dropped (send_tool_hints defaults to False) and
            the live strip never left "Sarathy is responding…" during the long,
            otherwise-silent image→VLM call. Best-effort by contract: a bus
            hiccup must never fail the turn.
            """
            if not on_progress:
                return
            try:
                await on_progress(label, tool_hint=True, phase=True)
            except Exception:
                pass  # progress is best-effort; never fail the turn for it

        for idx, image_part in enumerate(image_parts, 1):
            await _phase(
                f"🔍 Sending image {idx}/{total} to VLM…"
                if total > 1
                else "🔍 Sending image to VLM…"
            )

            description_messages = [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [image_part]
                    + ([{"type": "text", "text": user_text}] if user_text else []),
                },
            ]

            try:
                response = await asyncio.wait_for(
                    image_provider.chat(
                        messages=description_messages,
                        tools=[],
                        model=image_provider.get_default_model(),
                        temperature=0.1,
                        max_tokens=1024,
                        stream=False,
                    ),
                    timeout=IMAGE_DESCRIBE_TIMEOUT_S,
                )
                descriptions.append(response.content or "Image description unavailable")
            except asyncio.TimeoutError:
                logger.warning(
                    "Image provider description timed out after {}s (image {}/{})",
                    IMAGE_DESCRIBE_TIMEOUT_S,
                    idx,
                    total,
                )
                descriptions.append("Image description unavailable (timed out)")
            except Exception as e:
                logger.warning("Image provider description failed (image {}/{}): {}", idx, total, e)
                descriptions.append("Image description unavailable")
            else:
                # The vision round-trip for this image is done: name the phase so
                # the live status stops claiming we are still sending the image.
                await _phase(
                    f"✅ Image description received {idx}/{total}"
                    if total > 1
                    else "✅ Image description received"
                )

        # Rewrite the user message: replace image parts with description hints.
        if total == 1:
            hint = f"[image description: {descriptions[0]}]"
        else:
            hint = "\n".join(
                f"[image {i} description: {d}]" for i, d in enumerate(descriptions, 1)
            )
        new_content = text_parts + [{"type": "text", "text": hint}]

        # Create new messages list with rewritten user message
        new_messages = list(messages)
        new_messages[user_msg_idx] = {**user_msg, "content": new_content}

        return new_messages

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
        on_thinking: Callable[..., Awaitable[None]] | None = None,
        reasoning_effort: str | None = None,
        channel: str | None = None,
        session_metadata: dict | None = None,
        steer_queue: asyncio.Queue | None = None,
        session_key: str | None = None,
        tools_override: list[dict] | None = None,
    ) -> tuple[str | None, list[str], list[dict], dict]:
        """Run the agent iteration loop. Returns (final_content, tools_used, messages, stats).

        ``tools_override`` narrows the advertised tool set for one turn (the
        `/diary` biographer gets `exec` only). ``None`` keeps the live registry
        lookup on every iteration, exactly as before.
        """
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

        # Resolve the current session epoch for this turn (non-advancing read)
        epoch = 0
        if session_key:
            try:
                from sarathy.usage.store import get_usage_store

                epoch = get_usage_store().get_session_epoch(session_key)
            except Exception:
                epoch = 0

        messages = initial_messages
        iteration = 0
        final_content = None
        tools_used: list[str] = []
        total_tokens = 0
        total_time = 0.0

        while iteration < self.max_iterations:
            iteration += 1

            # Steer injection point: the top of each iteration. A /steer that
            # arrived during a running tool call is picked up here — immediately
            # before the next model call, exactly when the running step ends.
            if steer_queue is not None:
                steers = []
                while not steer_queue.empty():
                    try:
                        steers.append(steer_queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break
                for steer in steers:
                    messages.append(
                        {"role": "user", "content": STEER_PROMPT_TEMPLATE.format(steer=steer)}
                    )
                    if on_progress:
                        await on_progress("🎯 Steer injected", tool_hint=True)

            start_time = time.perf_counter()
            should_stream = streaming_enabled and on_progress is not None
            if self.reviewer:
                self.reviewer.mark_busy()

            # Describe-then-inject: if messages contain images and an image provider is configured,
            # call the image provider to describe images and rewrite user message with description hint
            if self.runtime is not None and self._has_image_content(messages):
                image_provider = self.runtime.provider_for("image")
                if image_provider is not None:
                    messages = await self._describe_images_with_image_provider(
                        messages,
                        image_provider,
                        on_progress=on_progress,
                        on_thinking=on_thinking,
                        channel=channel,
                        session_key=session_key,
                    )
                else:
                    logger.warning("Image content detected but no image provider configured; passing raw images to main model")

            try:
                response = await self.provider.chat(
                    messages=messages,
                    tools=(
                        tools_override
                        if tools_override is not None
                        else self.tools.get_definitions()
                    ),
                    model=self.model,
                    temperature=self.temperature,
                    max_tokens=self.max_tokens,
                    reasoning_effort=reasoning_effort or self.reasoning_effort,
                    stream=should_stream,
                    on_progress=on_progress if should_stream else None,
                    on_thinking=on_thinking if should_stream else None,
                    session_id=session_key,
                )
            finally:
                if self.reviewer:
                    self.reviewer.mark_idle()
            elapsed = time.perf_counter() - start_time

            # Record usage telemetry (benign - never fails the turn)
            self._record_usage(
                response, session_key=session_key, channel=channel, elapsed=elapsed, epoch=epoch
            )

            if response.usage:
                total_tokens += response.usage.get("completion_tokens", 0)
                total_time += elapsed

            if response.has_tool_calls:
                # Genuine prose shipped alongside a tool call (e.g. "Noted — I'll
                # remember that." + memory write) is a real reply and must not
                # be swallowed by the turn's final, so it is published SEALED.
                # Reasoning never reaches here: it left the loop on the thinking
                # channel and `content` is visible prose by construction (131 §B).
                clean = self._strip_think(response.content)
                if on_progress:
                    if clean:
                        await on_progress(clean, seal=True)
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

                    # Same rule as the structured-tool-call branch above: prose
                    # here is genuine, so seal it rather than let the follow-up
                    # final overwrite it (131 §C).
                    clean = self._strip_think(response.content)
                    if on_progress:
                        if clean:
                            await on_progress(clean, seal=True)
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
                    final_content = self._strip_think(response.content)
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
            "epoch": epoch,
        }

        return final_content, tools_used, messages, stats

    def _record_usage(
        self,
        response: Any,
        session_key: str | None,
        channel: str | None,
        elapsed: float,
        epoch: int = 0,
    ) -> None:
        """Record usage telemetry for a single LLM call. Never raises."""
        try:
            from sarathy.usage.store import get_usage_store

            usage = response.usage or {}
            provider_name = (
                getattr(self.provider, "provider_name", None)
                or getattr(self.provider, "api_base", None)
                or "local"
            )
            event = {
                "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "session_key": session_key,
                "channel": channel,
                "model": self.model or "",
                "provider": provider_name,
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "cached_tokens": usage.get("cached_tokens", 0),
                "cache_write_tokens": usage.get("cache_write_tokens"),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "cache_discount": usage.get("cache_discount"),
                "cost": usage.get("cost"),
                "duration_ms": int(elapsed * 1000),
                "finish_reason": response.finish_reason,
                "epoch": epoch,
            }
            get_usage_store().record(event)
        except Exception:
            # Benign: telemetry failure must never break a turn
            pass

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

            lowered = msg.content.strip().lower()
            if lowered == "/stop":
                await self._handle_stop(msg)
            elif lowered.startswith("/steer"):
                await self._handle_steer(msg)
            elif lowered.startswith("/btw"):
                await self._handle_btw(msg)
            elif lowered.startswith("/local"):
                await self._handle_local(msg)
            elif lowered.startswith("/diary"):
                await self._handle_diary(msg)
            else:
                self._spawn_dispatch(msg)

    def _spawn_dispatch(self, msg: InboundMessage) -> asyncio.Task:
        """Dispatch a message to the processing pipeline (tracked for /stop)."""
        task = asyncio.create_task(self._dispatch(msg))
        self._active_tasks.setdefault(msg.session_key, []).append(task)
        task.add_done_callback(
            lambda t, k=msg.session_key: (
                self._active_tasks.get(k, []) and self._active_tasks[k].remove(t)
                if t in self._active_tasks.get(k, [])
                else None
            )
        )
        return task

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
                metadata={"_notice": True},
            )
        )

    async def _handle_steer(self, msg: InboundMessage) -> None:
        """Handle /steer: inject a mid-turn instruction into the current turn.

        Enqueues the steer text into the session's queue; the running turn
        drains it at its next boundary (right after the current tool call
        finishes). If the session is idle, the prefix is stripped and the text
        is dispatched as a normal message.
        """
        parts = msg.content.split(None, 1)
        text = parts[1].strip() if len(parts) > 1 else ""
        if not text:
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=(
                        "Usage: /steer <message>\n\n"
                        "Inject a mid-turn instruction into the current response "
                        "as soon as the running step finishes."
                    ),
                    metadata={"_notice": True},
                )
            )
            return

        key = msg.session_key
        session = self.sessions.get_or_create(key)

        if key in self._active_main_turns or key in self._active_btw_turns:
            session.steer_queue = session.steer_queue or asyncio.Queue()
            await session.steer_queue.put(text)
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content="🎯 Steer noted — I'll fold that into the current turn at the next pause.",
                    metadata={"_notice": True},
                )
            )
        else:
            # Session idle: strip the prefix and run as a normal message.
            new_msg = InboundMessage(
                channel=msg.channel,
                sender_id=msg.sender_id,
                chat_id=msg.chat_id,
                content=text,
                metadata=dict(msg.metadata or {}),
            )
            self._spawn_dispatch(new_msg)

    async def _handle_btw(self, msg: InboundMessage) -> None:
        """Handle /btw: start a separate, concurrent side LLM turn."""
        parts = msg.content.split(None, 1)
        text = parts[1].strip() if len(parts) > 1 else ""
        if not text:
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=(
                        "Usage: /btw <message>\n\n"
                        "Ask a side question. It runs concurrently and is delivered as soon as it's ready."
                    ),
                    metadata={"_notice": True},
                )
            )
            return

        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="💬 BTW noted — running as a side question. I'll deliver the answer as soon as it's ready.",
                metadata={"_notice": True},
            )
        )
        asyncio.create_task(self._run_btw_turn(msg, text))

    async def _handle_local(self, msg: InboundMessage) -> None:
        """Handle /local: a /btw-style side turn pinned to the local role.

        `/local <msg>` runs the side turn on the provider tagged `local` in the
        config (set with `/provider role local <name> [model]`) rather than the
        active one. The main session's provider and model are never touched —
        the swap happens inside the side turn and is restored in its `finally`.
        """
        parts = msg.content.split(None, 1)
        text = parts[1].strip() if len(parts) > 1 else ""
        if not text:
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=(
                        "Usage: /local <message>\n\n"
                        "Ask a side question on the local provider/model configured for the "
                        "local role. It runs concurrently and is delivered as soon as it's ready."
                    ),
                    metadata={"_notice": True},
                )
            )
            return

        # No local provider configured → tell the user to set one and stop. This
        # must NOT silently fall back to the active provider: the whole point of
        # `/local` is that the answer comes from the local model.
        if self._resolve_side_provider("local") is None:
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=(
                        "⚠️ No local provider is configured. "
                        "Set one first with `/provider role local <name> [model]`."
                    ),
                    metadata={"_notice": True},
                )
            )
            return

        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=(
                    "🏠 LOCAL noted — running on the local provider. "
                    "I'll deliver the answer as soon as it's ready."
                ),
                metadata={"_notice": True},
            )
        )
        asyncio.create_task(self._run_btw_turn(msg, text, provider_role="local", side_tag="local"))

    async def _handle_diary(self, msg: InboundMessage) -> None:
        """Handle /diary: capture first-person life content into Charitham.

        A side turn like `/local` — but pinned to the `local` role AND given a
        narrow biography-only system prompt with the `exec` tool alone. The
        full ~19k-token prompt (AGENTS/SOUL/skills/KB) plus all 8 tools let a
        12B local model answer conversationally with zero tool calls (proven
        2026-10-14 on `/local`); this turn gives it exactly one job and one way
        to do it, so the `diary.py add` call actually fires.
        """
        parts = msg.content.split(None, 1)
        text = parts[1].strip() if len(parts) > 1 else ""
        if not text:
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=(
                        "Usage: /diary <text>\n\n"
                        "Write a life entry into your Charitham diary. Runs on the local "
                        "biographer model — first-person prose only, no technical requests."
                    ),
                    metadata={"_notice": True},
                )
            )
            return

        # No local provider → say so and stop. Silently logging from the main
        # (cloud) model would break the whole point of `/diary`.
        if self._resolve_side_provider("local") is None:
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=(
                        "⚠️ No local provider is configured. "
                        "Set one first with `/provider role local <name> [model]`."
                    ),
                    metadata={"_notice": True},
                )
            )
            return

        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="📔 DIARY noted — logging on the local biographer model.",
                metadata={"_notice": True},
            )
        )
        asyncio.create_task(
            self._run_btw_turn(
                msg,
                text,
                provider_role="local",
                side_tag="diary",
                system_prompt_override=self._build_diary_system_prompt(channel=msg.channel),
                tools_override=self._diary_tool_definitions(),
                media=msg.media or None,
            )
        )

    def _diary_tool_definitions(self) -> list[dict]:
        """The exec-only tool set a `/diary` turn is allowed to see."""
        return [
            t for t in self.tools.get_definitions() if t.get("function", {}).get("name") == "exec"
        ]

    def _build_diary_system_prompt(self, channel: str | None = None) -> str:
        """Build the narrow `/diary` system prompt.

        The craft comes from the workspace skill `diary-biographer/SKILL.md`
        (read at runtime so editing the skill edits the biographer), wrapped in
        the explicit instruction block a 12B model needs: what to record, the
        three layers, and the mandatory `diary.py add` call. Falls back to a
        compact embedded prompt when the skill file is missing, so a `/diary`
        turn degrades to "less craft", never to a crash.
        """
        source = _sanitize_source(channel)
        craft = self._read_diary_skill_craft()
        return (
            DIARY_SYSTEM_PREAMBLE.format(cli=DIARY_CLI, source=source)
            + "\n\n---\n\n"
            + DIARY_SYSTEM_EPILOGUE.format(cli=DIARY_CLI)
            + "\n\n---\n\n"
            + craft
        )

    def _read_diary_skill_craft(self) -> str:
        """Read the diary-biographer skill; return the embedded fallback if absent."""
        candidates = [
            self.workspace / "skills" / DIARY_SKILL_NAME / "SKILL.md",
            Path(DIARY_SKILL_PATH),
        ]
        for path in candidates:
            try:
                if path.is_file():
                    return _strip_frontmatter(path.read_text(encoding="utf-8")).strip()
            except OSError as e:
                logger.warning("Could not read diary skill {}: {}", path, e)
        logger.info("Diary skill not found; using the embedded biographer prompt")
        return DIARY_CRAFT_FALLBACK

    def _resolve_side_provider(self, provider_role: str) -> Any | None:
        """Resolve the provider a side turn should run on.

        Returns ``None`` when no runtime is available or the role is unassigned,
        so callers can tell "run on the active provider" from "no local provider
        is configured" and refuse the turn instead of quietly answering from the
        wrong model.
        """
        if not provider_role or self.runtime is None:
            return None
        try:
            return self.runtime.provider_for(provider_role)
        except Exception as e:
            logger.warning("Side-turn provider '{}' lookup failed ({}); using active", provider_role, e)
            return None

    async def _run_btw_turn(
        self,
        msg: InboundMessage,
        btw_text: str,
        *,
        provider_role: str | None = None,
        side_tag: str = "btw",
        system_prompt_override: str | None = None,
        tools_override: list[dict] | None = None,
        media: list[str] | None = None,
    ) -> None:
        """Run a concurrent side turn against a snapshot of the main session.

        Shared by `/btw` (the active provider), `/local` (the provider tagged
        with ``provider_role``) and `/diary` (the local role, narrowed further).
        The provider swap is scoped to this task and restored in the `finally`,
        so the main session's active provider/model is never mutated by a side
        turn. Frames keep the `_btw` tagging that the dashboard transcript and
        the Telegram channel already understand.

        ``system_prompt_override`` / ``tools_override`` / ``media`` are opt-in
        and all default to ``None``, which leaves `/btw` and `/local` byte-for-byte
        on the full prompt, the full registry and no media.
        """
        key = msg.session_key
        try:
            main_session = self.sessions.get_or_create(key)
            snapshot = main_session.get_history(max_messages=self.memory_window)
            # A distinct side session per turn keeps concurrent /btw and /local
            # turns from colliding with each other or with the main session.
            side_key = f"{key}##{side_tag}##{uuid.uuid4().hex[:8]}"
            side_session = self.sessions.get_or_create(side_key)
            self._active_btw_turns.add(key)

            # Resolve the role's provider BEFORE the turn and swap it in for the
            # duration only. `self.provider`/`self.model` are the loop-wide
            # active pair, so restoring them here is what keeps /local from
            # changing what the main session talks to.
            override_provider = self._resolve_side_provider(provider_role) if provider_role else None
            override_model = None
            saved_provider: tuple[Any, str] | None = None
            if override_provider is not None:
                override_model = override_provider.get_default_model()
                saved_provider = (self.provider, self.model)
                self.provider = override_provider
                self.model = override_model
            side_model = override_model or self.model

            # Protect MessageTool per-turn state so the side turn cannot pollute
            # the main turn's duplicate-suppression tracking.
            mt = self.tools.get("message")
            saved_state = None
            if mt is not None and isinstance(mt, MessageTool):
                saved_state = (
                    mt._default_channel,
                    mt._default_chat_id,
                    mt._default_message_id,
                    list(mt._turn_sends),  # raw (channel, chat_id, session) tuples
                    mt._response_metadata,
                )
                mt.start_turn()
                mt.set_context(msg.channel, msg.chat_id, msg.metadata.get("message_id"))

            try:
                messages = self.context.build_messages(
                    history=snapshot,
                    current_message=btw_text,
                    media=media,
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    history_budget_tokens=self._history_budget_tokens(),
                    model=side_model,
                    system_prompt_override=system_prompt_override,
                )

                effective_reasoning_effort = (
                    main_session.metadata.get("reasoning_effort") or self.reasoning_effort
                )

                # A btw turn only consumes steers when no main turn is active
                # (avoids double-consumption when both could target the queue).
                steer_queue = (
                    main_session.steer_queue if key not in self._active_main_turns else None
                )

                async def _btw_progress(
                    content: str, *, tool_hint: bool = False, seal: bool = False, phase: bool = False
                ) -> None:
                    await self.bus.publish_outbound(
                        OutboundMessage(
                            channel=msg.channel,
                            chat_id=msg.chat_id,
                            content=content,
                            metadata={
                                "_btw": True,
                                "_progress": True,
                                "_tool_hint": tool_hint,
                                "_seal": seal,
                                "_phase": phase,
                            },
                        )
                    )

                final_content, _, all_msgs, _ = await self._run_agent_loop(
                    messages,
                    on_progress=_btw_progress,
                    reasoning_effort=effective_reasoning_effort,
                    channel=msg.channel,
                    steer_queue=steer_queue,
                    session_key=side_key,
                    tools_override=tools_override,
                )

                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content=final_content or "⚠️ No response.",
                        metadata={"_btw": True, "_final": True},
                    )
                )

                # Persist only the side exchange into the side session — the
                # main session's history is never touched.
                self._save_turn(side_session, all_msgs, 1 + len(snapshot))
                self.sessions.save(side_session)
            finally:
                # Restore the loop-wide active provider/model BEFORE anything
                # else can observe them: a /local turn must never leave the main
                # session pointed at the local model.
                if saved_provider is not None:
                    self.provider, self.model = saved_provider
                if mt is not None and saved_state is not None:
                    (
                        mt._default_channel,
                        mt._default_chat_id,
                        mt._default_message_id,
                    ) = saved_state[:3]
                    mt._turn_sends = list(saved_state[3])
                    mt._response_metadata = dict(saved_state[4])
        except Exception as e:
            logger.exception("Side (/{}) turn failed for session {}", side_tag, key)
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=f"⚠️ Side question failed: {e}",
                    metadata={"_btw": True, "_final": True},
                )
            )
        finally:
            self._active_btw_turns.discard(key)

    async def _dispatch(self, msg: InboundMessage) -> None:
        """Process a message under the per-session lock with optional global cap."""
        key = msg.session_key
        # Hot-reload config (global lock, acquired BEFORE session lock per lock ordering)
        async with self._global_lock:
            self._refresh_runtime()
        # Acquire semaphore first (global cap), then session lock
        async with self._session_semaphore:
            lock, _ = await self._acquire_session_lock(key)
            async with lock:
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
            # Release lock after the async with lock block exits (lock is now unlocked)
            await self._release_session_lock(key)

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

    # ------------------------------------------------------------------ turn registry

    def _begin_turn(self, key: str) -> dict[str, Any]:
        """Mint and register a fresh turn for ``key``; return its registry entry."""
        turn = {
            "active": True,
            "state": "thinking",
            "turn_id": uuid.uuid4().hex,
            "started_at": time.time(),
        }
        self._turn_registry[key] = turn
        return turn

    def _end_turn(self, key: str) -> None:
        """Drop the turn entry so ``turn_state`` reports idle."""
        self._turn_registry.pop(key, None)

    def _set_turn_phase(self, key: str, state: str) -> None:
        """Update the live phase (thinking/streaming/tool) of an active turn."""
        turn = self._turn_registry.get(key)
        if turn is not None and turn.get("active"):
            turn["state"] = state

    def turn_state(self, key: str) -> dict[str, Any]:
        """Return the authoritative turn block for ``session_key``.

        Idle sessions return ``active: False`` with a null ``turn_id``.
        """
        turn = self._turn_registry.get(key)
        if turn and turn.get("active"):
            return dict(turn)
        return {"active": False, "state": "idle", "turn_id": None, "started_at": None}

    def is_turn_active(self, key: str) -> bool:
        """True while a main turn is running for ``session_key``."""
        return key in self._active_main_turns

    async def _emit_turn_state(
        self, channel: str, chat_id: str, key: str, active: bool
    ) -> None:
        """Publish a ``turn_state`` frame over the bus (spec 127 §A.2).

        The frame is routed by the dashboard channel to ``type:"turn_state"``.
        ``_turn_state`` marks it for the outbound dispatcher, which sends it
        only to the dashboard (never to Telegram). The body is carried in
        ``metadata.turn``. Turn-end (``active:false``) is always emitted —
        including error and stop paths — because callers invoke it from a
        ``finally``.
        """
        try:
            block = self.turn_state(key) if active else {
                "active": False,
                "state": "idle",
                "turn_id": None,
                "started_at": None,
            }
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=channel,
                    chat_id=chat_id,
                    content="",
                    metadata={"_turn_state": True, "turn": block},
                )
            )
        except Exception as e:  # never let telemetry break the turn
            logger.debug("turn_state emit failed for {}: {}", key, e)

    async def _process_message(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        """Process a single inbound message and return the response.

        Records the session as an active main turn so /steer can target it, and
        brackets the turn with ``turn_state`` frames so the dashboard can render
        server-owned state (spec 127 §A).
        """
        key = session_key or msg.session_key
        self._active_main_turns.add(key)
        turn = self._begin_turn(key)
        await self._emit_turn_state(msg.channel, msg.chat_id, key, active=True)
        try:
            return await self._process_message_inner(
                msg, session_key, on_progress, turn_id=turn["turn_id"]
            )
        finally:
            self._active_main_turns.discard(key)
            self._end_turn(key)
            await self._emit_turn_state(msg.channel, msg.chat_id, key, active=False)

    def _maybe_stamp_provider(
        self, content: str | None, role: str, provider: Any
    ) -> str | None:
        """Append a small provider stamp to an async-task response when verbose.

        Keeps cost/behavior transparent without disturbing the main voice.
        """
        if content is None:
            return content
        try:
            name = getattr(provider, "provider_name", None) or getattr(
                provider, "api_base", None
            ) or "local"
        except Exception:
            name = "local"
        return f"{content}\n\n— run via {role} provider ({name})"

    @staticmethod
    def _is_automated_session(key: str) -> bool:
        """Cron/backend sessions skip the topic machinery entirely."""
        return key.startswith("cron:") or key.startswith("backend:")

    def _apply_topic_marker(
        self, session: Session, key: str, content: str | None
    ) -> tuple[str | None, str]:
        """Strip the `<topic>` marker and apply topic rules.

        Returns (content_for_user, action) where action is one of
        "none" | "set" | "changed". On set/change a `📌 <topic>` footer line
        is appended BEFORE any usage footer (callers must invoke this before
        appending the usage footer). The marker is always stripped so it never
        leaks to the user. Automated (cron:/backend:) sessions are stripped
        but otherwise untouched. Persistence happens via the caller's existing
        sessions.save() path.
        """
        if not content:
            return content, "none"
        cleaned, raw = strip_topic_marker(content)
        if raw is None:
            return content, "none"
        if self._is_automated_session(key):
            return cleaned, "none"
        action = apply_topic_signal(session.metadata, raw)
        if action in ("set", "changed"):
            topic = (session.metadata or {}).get("topic")
            if topic:
                cleaned = f"{cleaned}\n\n📌 {topic}"
        return cleaned, action

    def _history_budget_tokens(self) -> int:
        """Token budget for history trimming: 60% of context minus system + tools.

        Deterministic and offline: system prompt and tool definitions are
        estimated once, the remainder is set aside for conversation history.
        """
        system_prompt = self.context.build_system_prompt()
        tools_defs = json.dumps(self.tools.get_definitions(), ensure_ascii=False)
        overhead = estimate_tokens(system_prompt, self.model) + estimate_tokens(
            tools_defs, self.model
        )
        return max(0, int(self.context_length * HISTORY_BUDGET_RATIO) - overhead)

    def _detected_context_length(self) -> tuple[int | None, str]:
        """Return (context_length, label) from the active provider, else fallback."""
        cfg = getattr(self.runtime, "config", None)
        provider_name = cfg.agents.defaults.provider if cfg else None
        if provider_name and cfg:
            try:
                from sarathy.providers.manager import get_context_length

                detected = get_context_length(provider_name, cfg, self.model)
            except Exception:
                detected = None
            if detected:
                return detected, "detected"
        return None, "config"

    async def _process_message_inner(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        turn_id: str | None = None,
    ) -> OutboundMessage | None:
        """Process a single inbound message and return the response.

        ``turn_id`` is the stable id minted by :meth:`_process_message`; it is
        stamped onto every streamed frame so the dashboard can key all frames of
        a turn to one bubble (spec 127 §C.4).
        """

        # System messages: parse origin from chat_id ("channel:chat_id")
        if msg.channel == "system":
            channel, chat_id = (
                msg.chat_id.split(":", 1) if ":" in msg.chat_id else ("cli", msg.chat_id)
            )
            logger.info("Processing system message from {}", msg.sender_id)
            key = f"{channel}:{chat_id}"
            session = self.sessions.get_or_create(key)
            self._set_tool_context(channel, chat_id, msg.metadata.get("message_id"), key)
            history = session.get_history(max_messages=self.memory_window)
            messages = self.context.build_messages(
                history=history,
                current_message=msg.content,
                channel=channel,
                chat_id=chat_id,
                history_budget_tokens=self._history_budget_tokens(),
                model=self.model,
            )
            final_content, _, all_msgs, _ = await self._run_agent_loop(messages, channel=channel, session_key=key)
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
                elif cmd_name == "topic":
                    return self._handle_topic_command(session, msg, args)
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
                elif cmd_name == "status":
                    return await self._handle_status_command(session, msg, args)
                elif cmd_name == "version":
                    from sarathy import __version__

                    return OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content=f"sarathy v{__version__}",
                    )

        self._set_tool_context(msg.channel, msg.chat_id, msg.metadata.get("message_id"), key)
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.start_turn()

        async def _bus_progress(
            content: str, *, tool_hint: bool = False, seal: bool = False, phase: bool = False
        ) -> None:
            meta = dict(msg.metadata or {})
            meta["_progress"] = True
            meta["_tool_hint"] = tool_hint
            # Pipeline narration (spec 134 §A) is exempt from the dispatcher's
            # `send_tool_hints` gate: it exists precisely to narrate the long,
            # otherwise-silent image→VLM call, so it must always ship.
            if phase:
                meta["_phase"] = True
            # Sealed prose (131 §C): genuine reply text that shipped with a tool
            # call. The SPA renders it as its own bubble that the turn's `_final`
            # cannot overwrite — an answer emitted together with a memory/KB
            # write yields exactly two bubbles, not one per tool call.
            if seal:
                meta["_seal"] = True
            if turn_id:
                meta["turn_id"] = turn_id
            self._set_turn_phase(key, "tool" if tool_hint else "streaming")
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=content,
                    metadata=meta,
                )
            )

        # Signal image preprocessing (downscale/re-encode) before the message is
        # built — a multi-megabyte upload is otherwise a silent pause. Named
        # apart from the describe phase below so the two are never confused in
        # the live status line (spec 134 §A).
        media_paths = msg.media if msg.media else None
        if media_paths and (on_progress is None):
            count = len(media_paths)
            label = (
                f"🖼️ Preparing {count} images…" if count > 1 else "🖼️ Preparing image…"
            )
            try:
                await _bus_progress(label, tool_hint=True, phase=True)
            except Exception:
                pass  # progress is best-effort; never fail the turn for it

        history = session.get_history(max_messages=self.memory_window)
        initial_messages = self.context.build_messages(
            history=history,
            current_message=msg.content,
            media=media_paths,
            channel=msg.channel,
            chat_id=msg.chat_id,
            history_budget_tokens=self._history_budget_tokens(),
            model=self.model,
        )

        async def _bus_thinking(content: str) -> None:
            # Thinking is a dashboard-only stream. Non-dashboard channels (e.g.
            # telegram) treat any outbound message without `_progress` as a
            # final message, so publishing thinking there would spam one
            # telegram message per reasoning token. Scope it to the dashboard.
            if msg.channel != "dashboard":
                return
            meta = dict(msg.metadata or {})
            meta["_thinking"] = True
            if turn_id:
                meta["turn_id"] = turn_id
            self._set_turn_phase(key, "thinking")
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
        # Per-turn provider override: a task payload may declare which provider
        # role should run this turn (e.g. {"provider_role": "local"} for cron /
        # manana-fill / wiki-lint async work). Resolve once, swap for the turn,
        # restore after. Fall back to the active provider when unset or unresolvable.
        override_provider = None
        override_model = None
        provider_role = (msg.metadata or {}).get("provider_role")
        if provider_role and self.runtime is not None:
            try:
                override_provider = self.runtime.provider_for(provider_role)
            except Exception as e:
                logger.warning("Provider override '{}' failed ({}); using active", provider_role, e)
                override_provider = None
            if override_provider is not None:
                override_model = override_provider.get_default_model()
                _saved = (self.provider, self.model)
                self.provider = override_provider
                self.model = override_model
                try:
                    final_content, _, all_msgs, stats = await self._run_agent_loop(
                        initial_messages,
                        on_progress=on_progress or _bus_progress,
                        on_thinking=_bus_thinking,
                        reasoning_effort=effective_reasoning_effort,
                        channel=msg.channel,
                        session_metadata=session.metadata,
                        steer_queue=session.steer_queue,
                        session_key=key,
                    )
                finally:
                    self.provider, self.model = _saved
                final_content = self._maybe_stamp_provider(final_content, provider_role, override_provider)
                if final_content:
                    final_content, _ = self._apply_topic_marker(session, key, final_content)
                self._save_turn(session, all_msgs, 1 + len(history))
                self.sessions.save(session)
                return OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=final_content or "Background task completed.",
                    metadata=({"turn_id": turn_id} if turn_id else {}),
                )
        final_content, _, all_msgs, stats = await self._run_agent_loop(
            initial_messages,
            on_progress=on_progress or _bus_progress,
            on_thinking=_bus_thinking,
            reasoning_effort=effective_reasoning_effort,
            channel=msg.channel,
            session_metadata=session.metadata,
            steer_queue=session.steer_queue,
            session_key=key,
        )

        if final_content is None:
            logger.warning("Empty response generated - possible context length or model issue")
            final_content = (
                "I encountered an issue generating a response. This may be due to context length "
                "or model issues. Try /clear or starting a new conversation."
            )

        # Session-topic piggyback: strip the machine marker and apply topic
        # rules BEFORE the usage footer is appended.
        if final_content:
            final_content, _ = self._apply_topic_marker(session, key, final_content)

        # Append usage footer if verbose is enabled
        if verbose_flag:
            from sarathy.usage.footer import format_usage_footer

            epoch = stats.get("epoch", 0)
            footer = format_usage_footer(stats, key, epoch)
            if footer:
                final_content = f"{final_content}{footer}"

        self._save_turn(session, all_msgs, 1 + len(history))
        self.sessions.save(session)

        if self.reviewer and all_msgs:
            await self.reviewer.enqueue(all_msgs, session.key)

        # Late-steer handling: steers that arrived during the final response
        # generation were never injected into the loop. Drain them and dispatch
        # each as a follow-up normal turn (they wait on the lock, run right after).
        leftover = []
        q = session.steer_queue
        if q is not None:
            while not q.empty():
                try:
                    leftover.append(q.get_nowait())
                except asyncio.QueueEmpty:
                    break
        for text in leftover:
            followup = InboundMessage(
                channel=msg.channel,
                sender_id=msg.sender_id,
                chat_id=msg.chat_id,
                content=text,
                metadata=dict(msg.metadata or {}),
            )
            self._spawn_dispatch(followup)

        metadata = dict(msg.metadata or {})
        metadata["_stats"] = stats
        metadata["_verbose"] = verbose_flag
        if turn_id:
            metadata["turn_id"] = turn_id

        # Only suppress final reply if message tool sent to SAME target
        # within THIS session's turn. The MessageTool is shared across
        # concurrent dispatch tasks (telegram + backend job turns run as
        # parallel asyncio tasks), so without session scoping one turn's
        # relay would suppress another turn's reply — the job 118/119
        # collision that ate Viswa's reply (2026-10-05).
        # Different targets / different sessions = send to both.
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                sent_targets = message_tool.get_turn_sends(session_key=key)
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
            # Archive session to archived_sessions/ before clearing.
            # Stamp archived=True only when the reviewer has no pending
            # snapshots for this session (live review finished); otherwise
            # leave False so unverified archives are re-checked later.
            if session.messages:
                learned = self.reviewer is None or not self.reviewer.has_pending(session.key)
                session.archive_session(learned=learned)
                logger.info(
                    "Archived session {} to archived_sessions/ (learned={})",
                    session.key,
                    learned,
                )
        except Exception as e:
            logger.error("Failed to archive session {}: {}", session.key, e)
            # Continue anyway - best effort archival

        # Clear session and start fresh
        session.clear()
        self.sessions.save(session)
        self.sessions.invalidate(session.key)

        # Advance the session epoch so the next conversation starts a fresh cost bucket
        try:
            from sarathy.usage.store import get_usage_store

            new_epoch = get_usage_store().reset_session_epoch(session.key)
            logger.info("Advanced session epoch for {} to {}", session.key, new_epoch)
        except Exception as e:
            logger.debug("Failed to advance session epoch for {}: {}", session.key, e)

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
        history = session.get_history(max_messages=self.memory_window)
        system_prompt = self.context.build_system_prompt()
        tools_defs = json.dumps(self.tools.get_definitions(), ensure_ascii=False)
        prompt_tokens = (
            estimate_tokens(system_prompt, self.model)
            + estimate_tokens(tools_defs, self.model)
            + estimate_messages_tokens(history, self.model)
        )

        detected, source = self._detected_context_length()
        context_length = detected or self.context_length
        usage_pct = (prompt_tokens / context_length * 100) if context_length else 0
        remaining = max(0, context_length - prompt_tokens)

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=f"""📊 Context Usage

Session: {msg.session_key}
Messages in session: {msg_count}
Messages to LLM: {len(history)}

Model context length: ~{context_length:,} tokens ({source})
Est. prompt tokens: ~{prompt_tokens:,}
Usage: {usage_pct:.1f}%
Remaining: ~{remaining:,} tokens

{"⚠️ Consider /new to start fresh" if usage_pct > 85 else "✅ Context OK"}""",
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
        # Note: write_memory is now async, but this is a sync method.
        # Schedule the write; the memory tool uses async writes for concurrent safety.
        import asyncio
        asyncio.create_task(self.context.memory.write_memory(new_memory))
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=f'✅ Saved to memory: "{args}"',
        )

    def _handle_topic_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /topic command - show/set/clear the session topic (manual lock).

        - `/topic` → show current topic (or "none").
        - `/topic <name>` → set topic manually and lock it (LLM signal ignored).
        - `/topic clear` → clear topic and unlock.
        """
        # Re-derive from the raw message to preserve the user's casing
        # (the dispatch `args` is lowercased).
        text = msg.content.strip()
        parts = text.split(None, 1)
        name = parts[1].strip() if len(parts) > 1 else ""

        def _reply(content: str) -> OutboundMessage:
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=content)

        if not name:
            current = (session.metadata or {}).get("topic")
            locked = bool((session.metadata or {}).get("topic_user_set", False))
            if current:
                lock_note = " (locked 🔒 — LLM signal ignored)" if locked else ""
                return _reply(f"📌 Current topic: {current}{lock_note}")
            return _reply(
                "No topic set for this session yet.\n\n"
                "Usage: /topic <name> · /topic clear"
            )

        if name.lower() == "clear":
            session.metadata.pop("topic", None)
            session.metadata["topic_user_set"] = False
            self.sessions.save(session)
            return _reply("🗑️ Topic cleared and unlocked.")

        title = " ".join(name.split())
        words = title.split()
        if len(words) > TOPIC_MAX_WORDS:
            title = " ".join(words[:TOPIC_MAX_WORDS])
        session.metadata["topic"] = title
        session.metadata["topic_user_set"] = True
        self.sessions.save(session)
        return _reply(f"📌 Topic set to: {title} (locked 🔒 — LLM signal ignored)")

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
        """Handle /restart command - restart the gateway service.

        A restart kills this process mid-turn, so everything this turn wants to
        say must be durable BEFORE the restart is spawned. The turn used to be
        persisted only by the end-of-turn ``_save_turn`` — which never ran, so
        the "/restart" ask and its ack vanished from the transcript (spec §A1).
        Persist first, then notify, then restart.
        """
        import subprocess
        from datetime import datetime

        from sarathy.core.notify import write_restart_flag

        # Multi-target flag: the originating channel, the Telegram live chat and
        # the dashboard console all get the boot ping (spec §C3).
        write_restart_flag(
            origin_channel=msg.channel,
            origin_chat_id=msg.chat_id,
            sender_id=msg.sender_id,
        )

        ack = "🔄 Gateway restart requested. Saving state and restarting..."

        # Durability first — a restart mid-turn must never drop the exchange
        # (this is the exact 18:19 → 18:26 hole Viswa reported).
        now = datetime.now().isoformat()
        session.messages.append(
            {"role": "user", "content": msg.content, "timestamp": now}
        )
        session.messages.append(
            {"role": "assistant", "content": ack, "timestamp": now}
        )
        session.updated_at = datetime.now()
        try:
            self.sessions.save(session)
        except Exception as e:
            # Never let a persistence failure block the restart itself.
            logger.warning("Failed to persist restart turn: {}", e)

        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=ack,
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
            async with self._global_lock:
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
            lines.append("Usage: /provider list · /provider set <name> [model] · /provider models <name> · /provider role main|local|image|none <name> [model] · /provider roles")
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
            async with self._global_lock:
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

        if sub == "add":
            return await self._handle_provider_add(session, msg, rest)

        if sub == "roles":
            r = self.runtime.role_status()
            lines = [
                "🎭 Provider roles:",
                f"  🎙 main  → {r['main']} ({r.get('main_model') or '—'})",
                f"  🏷 local → {r['local'] or '(none — async jobs fall back to main)'}"
                + (f" ({r.get('local_model') or '—'})" if r["local"] else ""),
                f"  🖼 image  → {r['image'] or '(none — image turns fall back to active)'}"
                + (f" ({r.get('image_model') or '—'})" if r["image"] else ""),
                f"  🔌 active → {r['active']}",
            ]
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content="\n".join(lines))

        if sub == "role" and rest:
            rparts = rest.split()
            role = rparts[0].lower()
            if role == "none":
                role = ""
            pname = rparts[1] if len(rparts) > 1 else None
            model = rparts[2] if len(rparts) > 2 else None
            if role not in ("", "main", "local", "image"):
                return OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content="Usage: /provider role main|local|image|none <provider-name> [model]",
                )
            if not pname:
                return OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content="Usage: /provider role main|local|image|none <provider-name> [model]",
                )
            try:
                self.runtime.set_role(role, pname, model)
            except ValueError as e:
                return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=f"⚠️ {e}")
            async with self._global_lock:
                self._refresh_runtime()
            if role == "":
                return OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=f"✅ Cleared the role on {pname}.",
                )
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=(
                    f"✅ Tagged {pname} as {role} provider"
                    + (f" with model {model}." if model else ".")
                    + " Model changes apply immediately."
                ),
            )

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content="Usage: /provider [status] · /provider list · /provider set <name> [model] · /provider models <name> · /provider add <name> [--api-base <url>] [--kind <kind>] [--set-active] · /provider role main|local|image|none <name> [model] · /provider roles",
        )

    async def _handle_provider_add(
        self, session: Session, msg: InboundMessage, rest: str
    ) -> OutboundMessage:
        """Handle /provider add — create a new provider from chat.

        Syntax: /provider add <name> [--api-base <url>] [--kind openai|anthropic]
                [--api-key <key>] [--label <label>] [--set-active]
        """
        from sarathy.config.loader import load_config, save_config
        from sarathy.config.schema import ProviderConfig

        if not rest:
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=(
                    "Usage: /provider add <name> [--api-base <url>] "
                    "[--kind openai|anthropic] [--api-key <key>] [--set-active]\n"
                    "Example: /provider add mylms --api-base http://localhost:1234/v1 --set-active"
                ),
            )

        parts = rest.split()
        name = parts[0]
        api_base = None
        kind = "openai"
        label = None
        api_key = None
        set_active = False

        i = 1
        while i < len(parts):
            p = parts[i]
            if p == "--api-base" and i + 1 < len(parts):
                api_base = parts[i + 1]
                i += 2
            elif p == "--kind" and i + 1 < len(parts):
                kind = parts[i + 1].lower()
                i += 2
            elif p == "--api-key" and i + 1 < len(parts):
                api_key = parts[i + 1]
                i += 2
            elif p == "--label" and i + 1 < len(parts):
                label = parts[i + 1]
                i += 2
            elif p == "--set-active":
                set_active = True
                i += 1
            else:
                return OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=f"⚠️ Unknown option: {p}",
                )

        if kind not in ("openai", "anthropic"):
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="⚠️ Kind must be 'openai' (chat completions) or 'anthropic' (messages).",
            )

        if kind == "openai":
            api_base = api_base or "https://api.openai.com/v1"
            if not api_base.endswith("/v1"):
                api_base = api_base.rstrip("/") + "/v1"
        else:
            api_base = api_base or "https://api.anthropic.com"

        config = load_config()
        if name in config.providers:
            return OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content=f"⚠️ Provider '{name}' already exists. Use /provider set {name} to activate it.",
            )

        config.providers[name] = ProviderConfig(
            kind=kind,
            api_base=api_base,
            api_key=api_key or "dummy",
            label=label or name.title(),
        )
        save_config(config)
        if set_active:
            config.agents.defaults.provider = name
            save_config(config)
        async with self._global_lock:
            self._refresh_runtime()

        reply = f"✅ Added provider '{name}' ({kind} → {api_base})."
        if set_active:
            reply += (
                f"\nNow active. Model: {config.agents.defaults.model} "
                "(change via /model set <name> or /model list)."
            )
        else:
            reply += "\nActivate it with: /provider set <name> [model]"
        return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id, content=reply)

    async def _handle_status_command(
        self, session: Session, msg: InboundMessage, args: str
    ) -> OutboundMessage:
        """Handle /status command - system status like the CLI's `sarathy status`."""
        from sarathy.config.loader import get_config_path, load_config

        config = load_config()
        config_path = get_config_path()
        lines = ["🪆 sarathy Status", ""]

        lines.append(
            f"Config: {config_path} {'✓' if config_path.exists() else '✗'}"
        )
        lines.append(
            f"Workspace: {config.workspace_path} {'✓' if config.workspace_path.exists() else '✗'}"
        )

        if config_path.exists():
            from sarathy.providers.manager import describe_provider

            lines.append(f"Model: {config.agents.defaults.model}")
            lines.append(f"Provider: {config.agents.defaults.provider or '(none set)'}")

            for pname, p in config.providers.items():
                try:
                    desc = describe_provider(pname, p)
                except Exception:
                    continue
                if desc["isLocal"]:
                    state = f"✓ {desc['apiBase']}" if desc["apiBase"] else "not set"
                else:
                    state = "✓" if desc["hasApiKey"] else "not set"
                lines.append(f"{desc['label']}: {state}")

            ws = config.tools.web.search
            if ws.enabled:
                env_key = "FIRECRAWL_API_KEY" if ws.provider == "firecrawl" else "BRAVE_API_KEY"
                import os as _os

                has_key = bool(ws.api_key or _os.environ.get(env_key))
                lines.append(
                    f"Web Search ({ws.provider}): {'✓' if has_key else '⚠ no API key'}"
                )
            else:
                lines.append("Web Search: disabled")

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content="\n".join(lines),
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
            # Strip the trailing session-topic marker before persisting so it
            # never leaks into stored history (and thus into the dashboard /
            # mobile history view). The outbound copy is already stripped by
            # _apply_topic_marker; this keeps the on-disk transcript clean too.
            if entry.get("role") == "assistant" and isinstance(
                entry.get("content"), str
            ):
                entry["content"], _ = strip_topic_marker(entry["content"])
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
        metadata: dict | None = None,
    ) -> str:
        """Process a message directly (for CLI or cron usage)."""
        await self._connect_mcp()
        msg = InboundMessage(
            channel=channel,
            sender_id="user",
            chat_id=chat_id,
            content=content,
            metadata=metadata or {},
        )
        response = await self._process_message(
            msg, session_key=session_key, on_progress=on_progress
        )
        return response.content if response else ""

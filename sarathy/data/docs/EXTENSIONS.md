# Writing Sarathy Extensions

An extension is a Python module with a `setup(sarathy)` entry point. It
receives an `ExtensionAPI` and can register tools, slash commands, prompt
guidelines and event hooks. Extensions import **only** the public
`tau_*` / `sarathy.*` APIs — never internal engine internals.

## Where extensions live

- `~/.sarathy/extensions/*.py` — single-file extensions
- `~/.sarathy/extensions/<name>/extension.py` (or `__init__.py`) — package-style
- `~/.sarathy/extensions/<name>/pyproject.toml` with
  `[tool.tau] extensions = ["src/my_ext/extension.py"]` — a manifest listing
  entry files for larger `src/` layouts; the manifest takes precedence over an
  `extension.py` in the same directory.

A directory is an extension if it contains `extension.py` (or `__init__.py`),
or a `pyproject.toml` declaring `[tool.tau] extensions`. Names starting with
`_`/`.` are skipped; on name conflicts the first-loaded extension wins.
Package-style extensions load as real packages, so sibling modules are reached
with **relative imports** (`from . import helper`) — never `import helper`.

## Minimal extension

```python
from tau_agent.tools import AgentTool, AgentToolResult
from tau_agent.messages import TextContent


def setup(sarathy):
    sarathy.add_prompt_guideline("For date questions, prefer ISO-8601.")

    async def utc_now(tool_call_id, arguments, signal=None, on_update=None) -> AgentToolResult:
        from datetime import datetime, timezone
        ts = datetime.now(timezone.utc).isoformat()
        return AgentToolResult(content=[TextContent(text=f"Now: {ts}")])

    sarathy.register_tool(
        AgentTool(
            name="utc_now",
            label="UTC Now",
            description="Return the current UTC time as ISO-8601.",
            parameters={"type": "object", "properties": {}},
            execute_fn=utc_now,
        )
    )
```

The `setup` function must be a plain `def` (not `async def`); it may store
closures for async hooks.

## Registering slash commands

```python
def handler(args, ctx):
    return f"you said: {args}"

sarathy.register_command(
    "echo",
    handler,
    description="Repeat back the arguments",
    usage="/echo <text>",
    aliases=("say",),
)
```

## Event hooks

Use `sarathy.on(event)` — either as a decorator or called with a handler.
Supported event types:

- **Agent events**: `agent_start`, `agent_end`, `agent_settled`,
  `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`,
  `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
  `session_start`, `session_shutdown`, `session_created`, `run_start`,
  `run_end`.
- **Lifecycle hooks**: `input`, `tool_call`, `tool_result`.

```python
from sarathy.extensions.api import InputHookResult

@sarathy.on("input")
def on_input(event, ctx):
    # transform or fully handle the user input before the model sees it
    return InputHookResult(action="transform", text=event.text.upper())
```

```python
from sarathy.extensions.api import ToolCallHookResult

@sarathy.on("tool_call")
def on_tool_call(event, ctx):
    if event.tool_name == "dangerous_tool":
        return ToolCallHookResult(block=True, reason="blocked by policy")
    return None
```

Hooks may be `async def`; sarathy awaits them.

## Sending messages and notifications

```python
# inject a follow-up into the conversation
sarathy.send_user_message("The user asked me to remind them.")


# fire a UI notification
sarathy.notify("Backup completed", level="success")


# append structured data to the session store
sarathy.append_entry("metrics", {"calls": 42})
```

## Context

Handlers receive an `ExtensionContext` (`ctx`) with read-only access to the
runtime: `ctx.cwd`, `ctx.model`, `ctx.provider_name`, `ctx.session_id`,
`ctx.is_running`, `ctx.transcript`, `ctx.ui`. Use `ctx.ui.notify(...)` for
user-facing notifications when a UI is attached.

## Reloading

Extensions are watched and reloaded. To install from git:

```python
client.extensions.install("https://github.com/user/sarathy-ext-myext.git")
```

Use `GET /api/extensions`, `POST /api/extensions/reload` from the web API.

## Reference

See `examples/extensions/` for runnable examples. Full API surface is in
`sarathy.extensions.api`:
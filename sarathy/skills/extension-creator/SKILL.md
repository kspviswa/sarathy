---
name: extension-creator
description: Create or update Sarathy extensions. Use when the user asks to add a tool, slash command, start/end hook, prompt guideline, or a new extension module to Sarathy.
---

# Extension Creator

This skill guides creating a Pi-style Sarathy extension. An extension is a
Python module exposing `setup(sarathy)` that receives an `ExtensionAPI`.

## Before you start

Read the bundled reference material first:

- `sarathy/data/docs/EXTENSIONS.md` (where extensions live, the API)
- Example extensions under `sarathy/data/examples/extensions/`:
  - `simple.py` — a tool + a slash command
  - `hooks.py` — input/tool_call/tool_result hooks
  - `echo-package/` — package-style extension with pyproject.toml

## Decide the shape

- Single file `~/.sarathy/extensions/<name>.py` for small extensions.
- Directory `~/.sarathy/extensions/<name>/extension.py` (or `__init__.py`),
  optionally with a `pyproject.toml` declaring `[tool.tau] name = "..."`, for
  multi-module extensions.

## Recipe

1. **Read EXTENSIONS.md** and the matching example before writing code.
2. Define `def setup(sarathy):`.
3. For a tool: import `AgentTool`/`AgentToolResult`/`TextContent` from
   `tau_agent`; build an `AgentTool` with a JSON Schema `parameters`
   (`{"type": "object", "properties": {...}}`) and an async `execute_fn` that
   returns `AgentToolResult(content=[TextContent(text=...)])`.
4. For a command: `sarathy.register_command(name, handler, description=...,
   usage=..., aliases=...)` where `handler(args, ctx)` returns text.
5. For hooks: decorate with `@sarathy.on("input" | "tool_call" |
   "tool_result")`; return the matching hook result dataclass or `None`.
6. For guidance: `sarathy.add_prompt_guideline("...")`.
7. Confirm it loads by restarting sarathy and checking the log line
   `extensions: N (...)`, or the web portal's Extensions tab.

## Rules of thumb

- Extensions import only public `tau_agent.*` / `tau_agent.tools.*` /
  `sarathy.extensions.api` names — never internal engine internals.
- `setup()` is synchronous; async behaviour belongs in `execute_fn` and hooks,
  which sarathy awaits.
- Validate that the tool's JSON Schema is accurate — the model relies on it.
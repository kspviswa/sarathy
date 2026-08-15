<div align="center">
  <img src="https://raw.githubusercontent.com/kspviswa/sarathy/refs/heads/main/sarathy_logo.png" alt="sarathy" width="500">
  <h1>Sarathy : My Personal Assistant</h1>
  <p>
    <a href="https://pypi.org/project/sarathy/"><img src="https://img.shields.io/pypi/v/sarathy" alt="PyPI"></a>
    <img src="https://img.shields.io/badge/python-≥3.12-blue" alt="Python">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  </p>
</div>

## What is Sarathy?

Sarathy is a **next-generation, local-first personal AI assistant**. Inspired by
[nanoclaw](https://github.com/qwibitai/nanoclaw) and good engineering, it adopts
[tau](https://github.com/huggingface/tau) (`tau-ai`) as its portable agentic
core: the agent loop, sessions, tool execution and event stream all come from
`tau_agent.AgentHarness`. Sarathy wraps that brain in a thin, understandable
shell — a mobile-first web portal, a REPL, skills, long-term memory, cron and a
Pi-compatible extension system.

> _Sarathy_ means helper, guide, driver, mentor in both Sanskrit & Tamil.
> It runs 100% local against your own models (Ollama, LMStudio, vLLM, or any
> OpenAI-compatible endpoint).

## Highlights

- **Adopts tau as its brain** (`tau_agent.AgentHarness`): stateful agent loop,
  typed tools, JSONL session persistence, live event stream.
- **Mobile-first web portal** (FastAPI PWA): chat, sessions, extensions, tools,
  skills, cron — with pairing auth and SSE updates.
- **REPL** (`sarathy agent`): interactive prompt-toolkit chat on the CLI.
- **Pi-compatible extensions**: write plain Python (`setup(sarathy)`) to add
  tools, slash commands, prompt guidelines and hooks.
- **Skills with hot-reload**: SKILL.md packages discovered at runtime; no restarts.
- **Long-term memory**: `memory/MEMORY.md` writer + background archivist that
  summarizes sessions into durable facts.
- **Cron**: schedule messages with cron expressions and IANA timezones.
- **Self-extension guides** bundled under `data/docs/` and `data/examples/`.

---

## Supported Models

Sarathy focuses on local models via `tau_ai`'s OpenAI-compatible provider. The
following providers are supported (all are just configuration):

| Provider | Endpoint | Description |
|----------|----------|-------------|
| **Ollama** | `http://localhost:11434/v1` | Local models via Ollama API |
| **LMStudio** | `http://localhost:1234/v1` | Local models with OpenAI-compatible API |
| **vLLM** | `http://localhost:8000/v1` | Local models with OpenAI-compatible API |
| **Custom** | configurable | Any OpenAI-compatible `/v1` endpoint |

## Frontends

| Frontend | Description |
|----------|-------------|
| **Web portal** | Mobile-first PWA served by the gateway (chat/sessions/extensions/skills/tools/cron), pairing auth, SSE updates |
| **REPL** | `sarathy agent` interactive CLI chat |

> Legacy Telegram / Discord / Email channel adapters, the message bus and the
> custom provider adapters were removed in v2; the web portal + REPL are the
> two frontends.

## Installation

### Install from source (latest features, recommended for development)

```bash
git clone https://github.com/kspviswa/sarathy.git
cd sarathy
pip install -e ".[dev]"
```

### Install from PyPI (stable)

```bash
pip install sarathy
```

> Requires Python 3.12+.

## Quick Start

> [!TIP]
> Make sure you have Ollama, LMStudio, or vLLM running before starting Sarathy.

**1. Set up** — non-interactive (generate a config from args):

```bash
sarathy setup --provider ollama --model llama3.2
```

or the interactive TUI wizard:

```bash
sarathy onboard
```

Both create `~/.sarathy/config.json`, the workspace, memory files, and starter
skills. Override anything later with flags:

```bash
sarathy setup --provider custom --model llama-3-70b-instruct \
  --api-base http://localhost:8000/v1 --api-key sk-... --force
```

**2. Chat (REPL)**

```bash
sarathy agent -m "Hello!"
# or drop the flag for interactive mode, exit with exit / /quit / Ctrl+D
```

**3. Start the web portal**

```bash
sarathy gateway start
```

Then open `http://localhost:18790`. On first run the gateway prints a
**pairing token** — log in with it to get a signed cookie (and you can use it as
a Bearer token for HTTP clients).

---

## CLI Reference

### Main Commands

| Command | Description |
|---------|-------------|
| `sarathy setup` | Generate a config file non-interactively from args |
| `sarathy onboard` | Interactive TUI wizard for setup |
| `sarathy agent [OPTIONS]` | Chat with the agent (REPL or one-shot) |
| `sarathy status` | Show sarathy status / config |
| `sarathy provider` | Manage providers (`list`, `login`) |
| `sarathy gateway` | Manage the web gateway (`start/stop/restart/status/logs`) |
| `sarathy cron` | Manage scheduled tasks (`list/add/remove/enable/run`) |

#### `setup` Options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --provider` | `ollama` | Provider: ollama, lmstudio, vllm, custom |
| `-m, --model` | per-provider | Model name |
| `--api-base` | provider default | Provider base URL (`.../v1`) |
| `--api-key` | — | API key for remote/custom providers |
| `--host` | `0.0.0.0` | Gateway bind host |
| `--port` | `18790` | Gateway port |
| `-w, --workspace` | `<SARATHY_HOME>/workspace` | Workspace dir |
| `-c, --config` | `~/.sarathy/config.json` | Where to write the config |
| `-f, --force` | — | Overwrite an existing config |

#### `agent` Options

| Option | Description |
|--------|-------------|
| `-m, --message TEXT` | Message to send to the agent (one-shot) |
| `-s, --session TEXT` | Session ID |
| `--markdown / --no-markdown` | Render assistant output as Markdown (default: on) |
| `--logs / --no-logs` | Show runtime logs during chat |

#### `gateway` subcommands

| Command | Description |
|---------|-------------|
| `gateway start [-p PORT] [-F]` | Start the gateway (`--foreground` for Docker/systemd) |
| `gateway stop` / `restart` | Stop / restart the gateway |
| `gateway status` | Show gateway status |
| `gateway logs [-n N] [-f]` | Show gateway logs (`--follow` to tail) |

#### `cron` subcommands

| Command | Description |
|---------|-------------|
| `cron list [-a]` | List scheduled jobs (`--all` includes disabled) |
| `cron add --name N --message M --cron "0 9 * * *" [--tz TZ]` | Add a job |
| `cron remove JOB_ID` | Remove a job |
| `cron enable JOB_ID` / `cron disable JOB_ID` | Enable / disable a job |
| `cron run JOB_ID` | Manually run a job |

## Configuration Schema

Key configuration sections in `~/.sarathy/config.json`:

```json
{
  "agents": {
    "defaults": {
      "provider": "ollama",
      "model": "llama3.2",
      "workspace": "~/.sarathy/workspace",
      "maxTokens": 4096,
      "temperature": 0.1,
      "contextLength": 8192
    },
    "memoryArchival": {
      "enabled": true,
      "intervalSeconds": 1800
    }
  },
  "providers": {
    "ollama": { "apiBase": "http://localhost:11434/v1" },
    "lmstudio": {},
    "vllm": {},
    "custom": { "apiBase": "http://localhost:8000/v1" }
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": 18790
  },
  "tools": {
    "restrictToWorkspace": false,
    "exec": { "timeout": 60 },
    "web": {
      "search": {
        "enabled": true,
        "provider": "firecrawl",
        "apiKey": "",
        "maxResults": 5
      }
    },
    "mcpServers": {}
  },
  "web": {
    "auth": { "enabled": true }
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `SARATHY_HOME` | Data directory (sessions, memory, cron, extensions). Default `~/.sarathy` |
| `SARATHY_CONFIG` | Config file path (used by Docker). Default `~/.sarathy/config.json` |

### Web Search Configuration

Set `tools.web.search`: `enabled`, `provider` (`firecrawl` or `brave`),
`api_key` (falls back to env `FIRECRAWL_API_KEY` / `BRAVE_API_KEY`), and
`max_results`.

### MCP Servers

Configure Model Context Protocol servers under `tools.mcpServers`:

```json
"mcpServers": {
  "my-server": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem"],
    "env": {}
  }
}
```

---

## Architecture

```
iPhone PWA (SPA) ──REST / SSE / polling──► FastAPI portal (inside gateway)
                                                  │
                                  SarathyEngine (sarathy/engine/)
                                    ├─ AgentHarness (tau_agent) per session
                                    ├─ tools: fs / shell / web / cron / MCP → AgentTool
                                    ├─ skills: SKILL.md loader + hot reload
                                    ├─ memory: MEMORY.md writer + archivist
                                    └─ ExtensionHost (sarathy/extensions/)
                                          │  tools · commands · events · guidelines
                                          ▼
                                  tau_ai (OpenAI-compatible providers)
```

Data flows: a message arrives via the web portal or REPL → the engine routes it
to the session → `AgentHarness` runs the loop (calling tools) → events stream to
the portal (SSE) and the REPL → the archivist periodically summarizes sessions
into `memory/MEMORY.md`.

---

## Extending Sarathy

Sarathy can extend itself with **plain Python** — no knowledge of the engine
internals required. Read the bundled guides at runtime:

- `docs/EXTENSIONS.md` — the extension reference
- `docs/SKILLS.md` — how to author skills
- `examples/extensions/` — runnable example extensions

An extension is a module with a `setup(sarathy)` entry point:

```python
from tau_agent.messages import TextContent
from tau_agent.tools import AgentTool, AgentToolResult

def setup(sarathy):
    async def greet(tool_call_id, arguments, signal=None, on_update=None):
        return AgentToolResult(content=[TextContent(text=f"Hello, {arguments.get('who', 'world')}!")])

    sarathy.register_tool(AgentTool(
        name="greet", label="Greet", description="Greet someone.",
        parameters={"type": "object", "properties": {"who": {"type": "string"}}},
        execute_fn=greet,
    ))
```

Place it in `~/.sarathy/extensions/greet.py` and it is available on the next
reload. Extensions can also register slash commands (`register_command`),
prompt guidelines (`add_prompt_guideline`) and event hooks (`on("input" |
"tool_call" | "tool_result")`).

---

## Workspace Structure

```
~/sarathy/.sarathy/
├── config.json         # configuration
├── workspace/
│   ├── memory/
│   │   ├── MEMORY.md   # long-term memory (archived facts)
│   │   └── HISTORY.md
│   ├── skills/         # YOUR skills (SKILL.md) — hot-reloaded
│   └── sessions/tau/   # JSONL session transcripts
├── extensions/         # YOUR extensions (*.py)
└── cron/               # scheduled jobs
```

With `SARATHY_HOME` set (e.g. in Docker), all of this lives under that dir.

---

## Built-in Skills

| Skill | Description |
|-------|-------------|
| `cron` | Schedule and manage tasks |
| `github` | GitHub repository operations |
| `summarize` | Summarize URLs, files, and videos |
| `tmux` | Terminal multiplexer control |
| `weather` | Get weather information |
| `clawhub` | Search/install skills from ClawHub |
| `skill-creator` | Create new skills |
| `extension-creator` | Create or update Sarathy extensions |

---

## Running with Docker

Build and run with volumes so **data, config and extensions live outside the
container**:

```bash
docker build -t sarathy .
docker run -d --rm --name sarathy \
  -p 18790:18790 \
  -v sarathy-config:/config -v sarathy-data:/data \
  -e SARATHY_CONFIG=/config/config.json -e SARATHY_HOME=/data \
  sarathy
```

The default entrypoint runs `sarathy gateway start --foreground`. Generate a
config inside the container first (or mount one in):

```bash
docker run --rm --entrypoint sarathy \
  -v sarathy-config:/config -v sarathy-data:/data \
  -e SARATHY_HOME=/data \
  sarathy setup --provider ollama --model llama3.2 --config /config/config.json
```

`docker compose up` (and `docker compose --profile apple up` for the Apple
Containers / arm64 variant) orchestrate the same flow.

---

## Development

```bash
# Install in development mode
pip install -e ".[dev]"

# Run tests
pytest

# Lint
ruff check sarathy/
```

## Contribution Guidelines

As you can probably guess, I'm NOT interested (at the moment) to accept either
feature requests or contributions to Sarathy. It is just for my own purposes. I
have opened it to the public for others to get motivated (just like nanoclaw
did). But if you find some security flaws and wanna be a good samaritan to
point out, by all means do it..

---

## Changelog

### 0.2.0a1 (2026-08-14) — v2 "tau-core" rewrite
- Adopt `tau_agent.AgentHarness` as the portable agentic core; sarathy becomes
  a thin shell (web portal + REPL + skills + memory + extensions).
- Add a **mobile-first web portal** (FastAPI PWA) with pairing auth, sessions,
  extensions, skills, tools, cron, and SSE event streaming.
- Add a **Pi-compatible extension system**: plain-Python `setup(sarathy)`
  modules adding tools, slash commands, prompt guidelines and lifecycle hooks.
- Add **self-extension guides** bundled under `data/docs/` and
  `data/examples/extensions/`, plus an `extension-creator` skill.
- Add a non-interactive `sarathy setup` command to generate config from args.
- Remove legacy v1 channel adapters (Telegram/Discord/Email), the message bus,
  custom providers and the old agent loop.
- Rewrite the test suite (87 passing) and add containerized e2e checks via
  `tests/test_docker.sh`.
<div align="center">
  <img src="https://raw.githubusercontent.com/kspviswa/sarathy/refs/heads/main/sarathy_logo.png" alt="sarathy" width="500">
  <h1>Sarathy : My Personal Assistant</h1>
  <p>
    <a href="https://pypi.org/project/sarathy/"><img src="https://img.shields.io/pypi/v/sarathy" alt="PyPI"></a>
    <img src="https://img.shields.io/badge/python-≥3.11-blue" alt="Python">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  </p>
</div>

## Who is Sarathy and Why ?

Sarathy is my own AI assistant implementation focused on **local models**. While [Openclaw](https://github.com/openclaw/openclaw) was a revolutionary idea, it’s heavily bloated and impossible for me to understand the data flow. It caters to all needs. Other similar OC variants also quickly becoming bloated even though they start small. 

Inspired by [nanoclaw](https://github.com/qwibitai/nanoclaw) and [karpathy tweet](https://x.com/karpathy/status/2024987174077432126?s=20) on personalizing agents, I decided to fork an implementation in the language I’m comfortable with. I forked off [nanobot](https://github.com/HKUDS/nanobot) and I made _Sarathy_. 

I built this to run 100% local with only the features I need.

> _Sarathy_ means helper, guide, driver, mentor in both Sanskrit & Tamil.


## What's Different in Sarathy?

While nanobot served as the initial inspiration, Sarathy has evolved significantly with many architectural changes and new features focused on local-first AI assistance.

### Textual-based Interactive Onboarding
- `sarathy onboard` launches a TUI wizard for first-time setup
- Guided provider selection and configuration
- Automatic workspace and skill template creation

### Dynamic Skills System with Hot-Reload
- Skills auto-discovered at runtime from `~/.sarathy/skills/` and workspace
- File watcher monitors for changes (using **watchdog** instead of watchfiles)
- No restart needed when adding/modifying skills
- YAML-based skill definitions with multi-line help text support

### Gateway Management
- Full lifecycle management: `start`, `stop`, `restart`, `status`, `logs`
- Background daemon with log rotation
- `tail -f` style log streaming with `--follow` flag

### Agent Enhancements
- **Token usage tracking**: Real-time display of token count and generation speed
- **Context length configuration**: Adjustable context window per session
- **Reasoning effort**: Control model reasoning depth (low/medium/high)
- **Session caching**: Configurable history and message limits

### Channel Features
- **Typing indicators**: Real-time typing status for Telegram and Discord
- **Progress updates**: Tool execution progress shown in channels
- **Verbose mode**: Detailed stats (token count, speed) in responses
- **Streaming mode**: Real-time response streaming in Telegram (uses sendMessageDraft API)
- **Message reactions**: Emoji reaction on user's message while processing (configurable)
- **Media progress**: Download and processing progress shown for images/attachments

### Built-in Commands
- `/think` - Enable reasoning mode
- `/streaming` - Toggle real-time response streaming
- `/clear` - Clear conversation context
- `/context` - Show conversation context
- `/remember` - Persist information to memory
- `/verbose` - Toggle detailed stats display
- Unified handling across Telegram and Discord

---

## Supported Models

Sarathy focuses on local models. The following providers are supported:

| Provider | Endpoint | Description |
|----------|----------|-------------|
| **Ollama** | `http://localhost:11434` | Local models via Ollama API |
| **LMStudio** | `http://localhost:1234/v1` | Local models with OpenAI-compatible API |
| **vLLM** | `http://localhost:8000/v1` | Local models with OpenAI-compatible API |
| **Custom** | configurable | Any OpenAI-compatible endpoint |

## Supported Channels

| Channel | Description |
|---------|-------------|
| **Telegram** | Bot via @BotFather |
| **Discord** | Bot via Discord Developer Portal |
| **Email** | IMAP/SMTP |

## Installation

### Install from source (latest features, recommended for development)

```bash
git clone https://github.com/kspviswa/sarathy.git
cd sarathy
pip install -e .
```

### Install with [uv](https://github.com/astral-sh/uv) (stable, fast)

```bash
uv tool install sarathy
```

### Install from PyPI (stable)

```bash
pip install sarathy
```

## Quick Start

> [!TIP]
> Make sure you have Ollama, LMStudio, or vLLM running before starting Sarathy.

**1. Initialize** (Interactive TUI wizard)

```bash
sarathy onboard
```

**2. Configure** (`~/.sarathy/config.json`)

Example for **Ollama**:
```json
{
  "agents": {
    "defaults": {
      "model": "llama3"
    }
  },
  "providers": {
    "ollama": {}
  }
}
```

Example for **LMStudio**:
```json
{
  "agents": {
    "defaults": {
      "model": "llama-3-8b"
    }
  },
  "providers": {
    "lmstudio": {}
  }
}
```

Example for **Custom** (e.g., local vLLM or other OpenAI-compatible):
```json
{
  "agents": {
    "defaults": {
      "model": "llama-3-70b-instruct"
    }
  },
  "providers": {
    "custom": {
      "apiBase": "http://localhost:8000/v1"
    }
  }
}
```

**3. Chat**

```bash
sarathy agent -m "Hello!"
```

Or start the **gateway** for multi-channel support:

```bash
sarathy gateway start
```

---

## CLI Reference

### Main Commands

| Command | Description |
|---------|-------------|
| `sarathy onboard` | Interactive TUI wizard for initial setup |
| `sarathy agent [OPTIONS]` | Chat with the agent |
| `sarathy status` | Show sarathy status |
| `sarathy version` | Show version information |

#### Agent Options

| Option | Description |
|--------|-------------|
| `-m, --message TEXT` | Message to send to the agent |
| `-s, --session TEXT` | Session ID (default: `cli:direct`) |
| `--markdown / --no-markdown` | Render output as Markdown (default: true) |
| `--logs / --no-logs` | Show runtime logs during chat |

#### Interactive Mode

When running `sarathy agent` without `-m`:
- Type messages to chat with the agent
- Exit with: `exit`, `quit`, `/exit`, `/quit`, `:q`, or `Ctrl+D`

---

### Gateway Management

| Command | Description |
|---------|-------------|
| `sarathy gateway start [OPTIONS]` | Start the gateway in background |
| `sarathy gateway stop` | Stop the running gateway |
| `sarathy gateway restart [OPTIONS]` | Restart the gateway |
| `sarathy gateway status` | Show gateway status |
| `sarathy gateway logs [OPTIONS]` | Show gateway logs |

#### Gateway Options

| Option | Description |
|--------|-------------|
| `-p, --port INTEGER` | Gateway port (default: 18790) |
| `-v, --verbose` | Verbose output |
| `-n, --lines INTEGER` | Number of log lines (default: 50) |
| `-f, --follow` | Follow log output (like `tail -f`) |

---

### Channel Management

| Command | Description |
|---------|-------------|
| `sarathy channels status` | Show channel status (Telegram, Discord, Email) |

---

### Scheduled Tasks (Cron)

| Command | Description |
|---------|-------------|
| `sarathy cron list [OPTIONS]` | List scheduled jobs |
| `sarathy cron add [OPTIONS]` | Add a new scheduled job |
| `sarathy cron remove JOB_ID` | Remove a scheduled job |
| `sarathy cron enable JOB_ID` | Enable a job |
| `sarathy cron disable JOB_ID` | Disable a job |
| `sarathy cron run JOB_ID` | Manually run a job |

#### Cron Options

| Option | Description |
|--------|-------------|
| `-a, --all` | Include disabled jobs in list |
| `-n, --name TEXT` | Job name (required for add) |
| `-m, --message TEXT` | Message for agent (required for add) |
| `-e, --every INTEGER` | Run every N seconds |
| `-c, --cron TEXT` | Cron expression (e.g., `0 9 * * *`) |
| `--tz TEXT` | IANA timezone (e.g., `America/Vancouver`) |
| `--at TEXT` | Run once at time (ISO format) |
| `-d, --deliver` | Deliver response to channel |
| `--to TEXT` | Recipient for delivery |
| `--channel TEXT` | Channel for delivery |

---

## Configuration Schema

Key configuration sections in `~/.sarathy/config.json`:

```json
{
  "agents": {
    "defaults": {
      "model": "llama3",
      "temperature": 0.7,
      "max_tokens": 4096,
      "max_tool_iterations": 10,
      "memory_window": 10,
      "session_cache_size": 100,
      "max_session_messages": 50,
      "context_length": 8192,
      "reasoning_effort": "low"
    }
  },
  "providers": {
    "ollama": {},
    "lmstudio": {},
    "custom": {
      "apiBase": "http://localhost:8000/v1"
    }
  },
  "channels": {
    "sendProgress": true,
    "sendToolHints": false,
    "telegram": {
      "enabled": false,
      "token": "YOUR_BOT_TOKEN",
      "replyToMessage": true,
      "streaming": true,
      "reactToMessage": true,
      "reactionEmoji": "👀"
    },
    "discord": {
      "enabled": false,
      "gateway_url": "YOUR_WEBHOOK_URL"
    },
    "email": {
      "enabled": false,
      "imap_host": "imap.example.com",
      "smtp_host": "smtp.example.com"
    }
  },
  "tools": {
    "exec": {
      "enabled": true
    },
    "web": {
      "search": {
        "enabled": true,
        "provider": "firecrawl",
        "api_key": "",
        "max_results": 5
      }
    },
    "restrict_to_workspace": true,
    "mcp_servers": {}
  },
  "workspace_path": "~/sarathy-workspace"
}
```

### Web Search Configuration

The web search tool can be configured under `tools.web.search`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable web search tool |
| `provider` | string | `"firecrawl"` | Search provider: `"firecrawl"` or `"brave"` |
| `api_key` | string | `""` | Provider API key (falls back to env var if empty) |
| `max_results` | integer | `5` | Maximum number of results to return (1-10) |

**Environment Variables:**
- Firecrawl: `FIRECRAWL_API_KEY`
- Brave: `BRAVE_API_KEY`

If `api_key` is empty in config, the corresponding environment variable will be used.

### Telegram Configuration

The Telegram channel supports additional options under `channels.telegram`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable Telegram channel |
| `token` | string | `""` | Bot token from @BotFather |
| `replyToMessage` | boolean | `false` | Reply inline to user's message |
| `streaming` | boolean | `false` | Stream responses in real-time via drafts |
| `reactToMessage` | boolean | `false` | Add emoji reaction to user's message while processing |
| `reactionEmoji` | string | `"👀"` | Emoji to use for reaction |

**Features:**
- `replyToMessage`: When enabled, bot responses appear as inline replies to user's messages
- `streaming`: Shows real-time progress as draft messages (requires `sendProgress: true` in channels)
- `reactToMessage`: Adds an emoji reaction to user's message while processing, removes when done
- Media attachments show download and processing progress via drafts

**Environment Variables:**
- Firecrawl: `FIRECRAWL_API_KEY`
- Brave: `BRAVE_API_KEY`

If `api_key` is empty in config, the corresponding environment variable will be used.

---

## Workspace Structure

```
~/sarathy-workspace/
├── memory/
│   ├── MEMORY.md      # Persistent memory
│   └── HISTORY.md     # Conversation history
├── skills/            # Workspace-specific skills
└── ...                # Your files and projects
```

---

## Built-in Skills

Sarathy includes several built-in skills:

| Skill | Description |
|-------|-------------|
| `memory` | Read/write persistent memory |
| `github` | GitHub repository operations |
| `cron` | Schedule and manage tasks |
| `tmux` | Terminal multiplexer control |
| `summarize` | Summarize long content |
| `weather` | Get weather information |
| `clawhub` | ClawHub integration |
| `skill-creator` | Create new skills |

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

As you can probably guess, I'm NOT interested (at the moment) to accept either feature requests or contributions to Sarathy. It is just for my own purposes. I have opened it to the public for others to get motivated (just like nanoclaw did). But if you find some security flaws and wanna be a good samaritan to point out, by all means do it.

At some point in future, I might consider making sarathy as a general purpose tool ^[Although the chance is pretty slim since there are tons of such claws out there.].

---

## Changelog

### 2026-03-04
- **Fix**: Handle thinking/reasoning tokens from models like Qwen3, DeepSeek-R1, Kimi K2.5
  - Updated `_strip_think()` to fall back to `reasoning_content` when content becomes empty after stripping thinking blocks
  - Added `thinking_blocks` field to `LLMResponse` for Anthropic Claude thinking
  - Preserved `reasoning_content` in session history for multi-turn conversations with reasoning models 
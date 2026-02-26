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

Sarathy is my own AI assistant implementation focused on **local models**. Frustrated with bloated alternatives and API costs, I built this to run 100% offline with only the features I need.

_Sarathy_ means helper, guide, driver, mentor in both Sanskrit & Tamil.

## Supported Models

### Local Providers (Primary)
- **Ollama** - `http://localhost:11434`
- **LMStudio** - `http://localhost:1234/v1`
- **vLLM** - any OpenAI-compatible local endpoint

### Custom Endpoints
- **Custom** - any OpenAI-compatible API (local or cloud)

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

**1. Initialize**

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
sarathy gateway
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `sarathy onboard` | Initialize config & workspace |
| `sarathy agent -m "..."` | Chat with the agent |
| `sarathy agent` | Interactive chat mode |
| `sarathy gateway` | Start the gateway (Telegram/Discord/Email) |
| `sarathy status` | Show status |

Interactive mode exits: `exit`, `quit`, `/exit`, `/quit`, `:q`, or `Ctrl+D`.

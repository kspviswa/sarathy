<div align="center">
  <img src="sarathy_logo.png" alt="sarathy" width="500">
  <h1>Sarathy : My Personal Assistant</h1>
  <p>
    <a href="https://pypi.org/project/sarathy/"><img src="https://img.shields.io/pypi/v/sarathy" alt="PyPI"></a>
    <img src="https://img.shields.io/badge/python-≥3.11-blue" alt="Python">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  </p>
</div>

## Who is Sarathy and Why ?

Sarathy is my own openclaw implementation to solve my own needs. Frustrated with bloated openclaw and the likes and other derivatives, I finally came to conclusion that I need to own my bot's implementation to fit to my needs. Especially, I need a bot that run 100% local with only features I care for. This project is not to offer a competing openclaw alternatives.

I was thinking about this internally and then saw Andrej Karpathy's take on [nanoclaw](https://github.com/qwibitai/nanoclaw). Although I'm not keen using a live organism that can either patch its own code or rich enough to continuously use claude code to keep customizing the bot to my needs.

I need a bot implemented in a language I'm comfortable with, so that I can _vibe engineer_ it the way that makes sense for me to maintain. So I decided to fork [nanobot](https://github.com/qwibitai/nanoclaw) to make it as _my_ Sarathy.

For the curious, _Sarathy_ means helper, guide, driver, mentor in both Sanskrit & Tamil.


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
> Set your API key in `~/.sarathy/config.json`.
> Get API keys: [OpenRouter](https://openrouter.ai/keys) (Global)

**1. Initialize**

```bash
sarathy onboard
```

**2. Configure** (`~/.sarathy/config.json`)

Add or merge these **two parts** into your config (other options have defaults).

*Set your API key* (e.g. OpenRouter, recommended for global users):
```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-v1-xxx"
    }
  }
}
```

*Set your model*:
```json
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-opus-4-5"
    }
  }
}
```

**3. Chat**

```bash
sarathy agent
```

That's it! You have a working AI assistant.

## CLI Reference

| Command | Description |
|---------|-------------|
| `sarathy onboard` | Initialize config & workspace |
| `sarathy agent -m "..."` | Chat with the agent |
| `sarathy agent` | Interactive chat mode |
| `sarathy gateway` | Start the gateway |
| `sarathy status` | Show status |

Interactive mode exits: `exit`, `quit`, `/exit`, `/quit`, `:q`, or `Ctrl+D`.

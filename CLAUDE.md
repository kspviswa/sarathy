# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sarathy is a personal AI assistant framework focused on local models (Ollama, LMStudio, vLLM). It supports multiple chat channels (Telegram, Discord, Email) and provides extensible tool execution capabilities.

## Common Commands

```bash
# Install in development mode
pip install -e ".[dev]"

# Run tests
pytest

# Run a single test
pytest tests/test_file.py::test_function_name

# Lint
ruff check sarathy/
```

## Architecture

The system follows a message-bus architecture:

```
Channels (Telegram/Discord/Email) → MessageBus → AgentLoop → LLM + Tools
                                                            ↓
                            SessionManager ←──────────── Persistence
```

### Core Components

- **AgentLoop** (`agent/loop.py`): Core processing engine - consumes messages, calls LLM with tools, executes tool calls, manages memory consolidation
- **Providers** (`providers/`): LLM abstraction layer via LiteLLM - supports Ollama, LMStudio, vLLM, custom endpoints
- **Channels** (`channels/`): Chat platform integrations (Telegram, Discord, Email) with a common interface
- **SessionManager** (`session/manager.py`): LRU-cached conversation history with JSONL persistence
- **MessageBus** (`bus/`): Async queue system routing messages between components
- **ToolRegistry** (`agent/tools/`): Extensible tool system (filesystem, shell, web, cron, MCP)

### Data Flow

1. Channel receives message → creates `InboundMessage` → publishes to MessageBus
2. AgentLoop consumes from bus → runs agent loop (LLM call → tool execution → repeat)
3. AgentLoop publishes `OutboundMessage` → ChannelManager routes to appropriate channel
4. SessionManager tracks conversation history and handles memory consolidation (summarization)

### Key Patterns

- **Provider abstraction**: `LLMProvider` base class defines `chat()` method; implementations handle different backends
- **Channel interface**: `BaseChannel` defines `start()`, `stop()`, `send()`; new channels implement this
- **Tool registry**: Tools are discovered at runtime and registered; MCP servers supported via `agent/tools/mcp.py`
- **Session-based**: Conversations keyed by `channel:chat_id` format

## Configuration

Config is in `~/.sarathy/config.json` (see README.md for schema). The config loader (`config/loader.py`) supports environment variable interpolation.

## Testing

Tests are in `tests/` directory using pytest with asyncio mode enabled. Key test patterns:
- Async tests use `@pytest.mark.asyncio`
- Fixtures often use tmp_path for workspace isolation

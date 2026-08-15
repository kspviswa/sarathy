# Sarathy v2 — Installation & Usage

Sarathy is a personal AI assistant framework built on **tau** (`tau-ai`). The
agentic core (prompts, tool execution, sessions, event stream) is provided by
`tau_agent.AgentHarness`; sarathy is a thin shell that adds a mobile-first web
portal, a REPL, skills, long-term memory and a Pi-compatible extension system.

## Requirements

- Python 3.12+
- A local model endpoint: Ollama (`http://localhost:11434/v1`),
  LM Studio (`http://localhost:1234/v1`), vLLM (`http://localhost:8000/v1`),
  or any OpenAI-compatible `/v1` server.

## Install

```bash
pip install sarathy
```

## Configure

Create `~/.sarathy/config.json` (see `config.schema` in the source for the full
schema). The provider is just configuration:

```json
{
  "agents": {
    "default": {
      "provider": "ollama",
      "model": "llama3.2"
    }
  },
  "gateway": {
    "host": "127.0.0.1",
    "port": 18790
  }
}
```

## Run

```bash
sarathy agent            # interactive REPL on the CLI
sarathy gateway start    # web portal + REST/SSE API
sarathy cron run "0 9 * * *" --message "Good morning"
```

## Web portal

`sarathy gateway start` serves:

- `GET /` — mobile-first PWA (chat, sessions, extensions, tools, skills, cron)
- `POST /api/chat?session_id=...` — send a message
- `GET /api/events` — SSE stream of agent events
- `GET /api/sessions`, `GET /api/sessions/{id}/transcript`, `POST /api/sessions`

Pairing auth: the first run prints a pairing token stored in the gateway data
dir; log in with it to receive a signed cookie.

## Extending

Sarathy can extend itself: extensions, skills and custom tools. Read
`EXTENSIONS.md` before creating an extension, and look at the working examples
under `examples/extensions/`. Skills are documented in `SKILLS.md`.
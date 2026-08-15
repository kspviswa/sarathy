# Sarathy v2 — Migration Plan (tau-core)

> Status: implemented on branch `feat/tau-core-migration`.
> Archetype: drop the hand-rolled agentic core, adopt **tau** (`tau-ai`) as the
> portable brain, and keep sarathy as a thin shell (web portal + TUI + skills +
> memory + extensions).

## 1. Why

Sarathy v1 wrote its own agent loop, sessions, providers, memory, skills and
extension plumbing (~10.6k LOC). Every one of those concerns is generic and
already solved better upstream. Reinventing them costs maintenance, not value.

Tau (huggingface/tau, published as `tau-ai`) is an MIT-licensed Python port of
Pi's minimalist coding-agent harness with a **Pi-compatible event and extension
protocol**. It provides exactly the reusable core sarathy needs:

- `tau_agent.AgentHarness` — stateful agent loop: prompts, steering, follow-up
  queuing, cancellation, tool execution, event stream, token repair.
- `tau_agent.tools.AgentTool` — typed tools (schema + async executor + progress).
- `tau_agent.session` — append-only JSONL session tree primitives.
- `tau_ai.OpenAICompatibleProvider` — all four sarathy provider targets
  (Ollama / LMStudio / vLLM / custom OpenAI-compatible `/v1`) are just config.
- A Pi-like extension model: a standalone `setup(api)` module that registers
  tools, slash commands, event hooks, prompt guidelines and messages.

Sarathy keeps what is *sarathy*-specific: the skill/SKILL.md system, MEMORY.md
archival, cron, the mobile-first web portal, and the self-extension guides.

## 2. Target architecture

```
iPhone PWA (SPA) ──REST / SSE / polling──► FastAPI portal (inside gateway)
                                                  │
                                  SarathyEngine (sarathy/engine/)
                                    ├─ AgentHarness (tau_agent) per session
                                    ├─ tools: fs / shell / web / cron / MCP, adapted to AgentTool
                                    ├─ skills: SKILL.md loader + hot reload (kept)
                                    ├─ memory: MEMORY.md writer + archivist
                                    └─ ExtensionHost (pi-like, sarathy/extensions/)
                                          │  tools · commands · events · guidelines
                                          ▼
                                  tau_ai (providers → event stream)
```

Channels are reduced to two frontends that speak to the engine:

1. **Web portal** — chat/sessions-first mobile PWA with pairing auth.
2. **TUI/REPL** — `sarathy agent` interactive prompt-toolkit chat.

Telegram / Discord / Email channels, the custom provider adapters, the message
bus, the LRU session manager and the 992-line `AgentLoop` are removed.

## 3. Phases

### Phase 0 — Foundation
- `requires-python >= 3.12`; `version = 0.2.0a1` (next semver, alpha tag).
- New deps: `tau-ai`, `fastapi`, `uvicorn`. Keep pydantic, httpx, prompt-toolkit,
  watchdog, croniter, loguru, rich.

### Phase 1 — Engine layer (`sarathy/engine/`)
- `provider.py`: build a `tau_ai.OpenAICompatibleProvider` from sarathy config
  (ollama → `http://localhost:11434/v1`, lmstudio → `:1234/v1`, vllm →
  `:8000/v1`, custom).
- `tools.py`: adapt existing `Tool` implementations (filesystem, shell, web,
  cron, MCP) to `tau_agent.AgentTool` while keeping all workspace guards.
- `context.py`: sarathy system prompt (identity/bootstrap files, MEMORY.md,
  skills summary, tool snippets) **plus a documentation-routing block** that
  teaches sarathy how to read its own bundled docs/examples (self-extension).
- `session.py`: `SessionApp` = one `AgentHarness` + `JsonlSessionStorage`
  persistence under `workspace/sessions/tau/`.
- `memory.py`: `Memory` (MEMORY.md) + periodic archivist that summarizes
  sessions to durable facts.
- `engine.py`: `SarathyEngine` — owns provider/skills/extensions/sessions; async
  event pub-sub; cron + heartbeat workers; cancel/restart plumbing.

### Phase 2 — Channels (only two)
- `repl.py`: `sarathy agent` interactive chat (TUI channel).
- Web portal (`sarathy/web/`): FastAPI + static SPA.
  - **Pairing auth**: token generated on first run, printed to console, stored in
    gateway data dir; login screen + signed cookie / Bearer header; the token
    works from both the web UI and HTTP clients.
  - `/api/events` SSE stream + `/api/notifications` polling endpoint → unread
    badge counts on mobile.
  - Sessions (list/resume/transcript/send/cancel), settings (config GET/PUT +
    restart), extensions (list/install/reload), skills, tools, cron.
  - Mobile-first PWA: manifest, service worker, safe-area, bottom tabs, installable.

### Phase 3 — Extension mechanism (pi-like)
- `sarathy/extensions/`: loader (discover `~/.sarathy/extensions/*.py`,
  `*/extension.py`, and dirs with `pyproject.toml [tool.tau] extensions`) +
  `ExtensionAPI` (register_tool / register_command / add_prompt_guideline / on /
  send_user_message / notify / append_entry / context) + `ExtensionHost`
  (reload, bake tools into sessions, dispatch events, expose commands).
- Extensions import only `tau_*`/`sarathy.*` public APIs — **no core source
  sharing required**.

### Phase 4 — Self-extension guides (teaching aspects)
Tau ships its docs + examples in the package (`data/docs/`, `data/examples/`)
and routes the model to them from the system prompt. Sarathy does the same:
- `sarathy/data/docs/` — `README.md`, `EXTENSIONS.md`, `SKILLS.md`,
  `ARCHITECTURE.md`, `MEMORY.md`.
- `sarathy/data/examples/extensions/` — working example extensions.
- `sarathy/skills/extension-creator/` — a skill that walks the agent through
  writing and reloading an extension on its own.
- System prompt routing block (`context.format_sarathy_documentation()`).

### Phase 5 — Distribution
- Versions: `0.2.0a1` (PyPI alpha).
- `Dockerfile`: `python:3.12-slim`, installs the sarathy wheel + runtime deps,
  non-root user, `SARATHY_HOME`/`SARATHY_CONFIG` env pointers so **data, config
  and extensions live on volumes**.
- `docker-compose.yml`: one `sarathy` service with config/extension/data
  volumes; run with any setup: `docker compose up`.

### Phase 6 — Cleanup & verification
- Delete `channels/`, `providers/` (adapters), `bus/`, `session/` (old LRU +
  archival), `heartbeat/`, `agent/loop.py`, `agent/subagent.py`, stale channel
  tools (`message.py`, `spawn.py`) and LE-context files that are replaced.
- Rewrite tests (legacy suite imports a phantom `sarathi` package).
- `ruff check`, package install smoke test, docker build.

## 4. What maps where

| Sarathy v1                    | Sarathy v2                                   |
|-------------------------------|----------------------------------------------|
| `agent/loop.py` (992 LOC)     | `tau_agent.AgentHarness` + `engine/` glue    |
| `session/manager.py` (LRU)    | `tau_agent.session` + `engine/session.py`    |
| `providers/` (litellm/custom) | `tau_ai.OpenAICompatibleProvider` (config)   |
| `agent/context.py`            | `engine/context.py` (+ self-doc routing)     |
| `agent/tools/*`               | adapted to `AgentTool` (guards preserved)    |
| `channels/` (TG/DC/email)     | web portal + REPL                            |
| `agent/skills.py`             | kept as-is (SKILL.md hot reload)             |
| `session/archival.py`+`memory.py` | `engine/memory.py` + archivist           |
| `cron/`, `heartbeat/`         | `engine/` workers                            |
| — (custom commands)           | `sarathy/extensions/` (Pi-compatible)        |

## 5. Risks
- Tau is under active development: pin `tau-ai` to a release, don't track main.
- Requires Python 3.12+ (sarathy v1 was 3.11).
- No subagents in tau core: deferred; extensions can spawn secondary harnesses.
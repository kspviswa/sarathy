# Sarathy Architecture

Sarathy v2 adopts **tau** (`tau-ai`) as its portable agentic core and keeps the
sarathy-specific shell around it: web portal, REPL, skills, memory, cron and
the extension system.

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

## Layers

### Engine (`sarathy/engine/`)

- `provider.py` — builds a `tau_ai.OpenAICompatibleProvider` from config
  (ollama / lmstudio / vllm / custom `/v1`).
- `session.py` — one `AgentHarness` + `JsonlSessionStorage` per session,
  persisted under `workspace/sessions/tau/`.
- `tools.py` — adapters over the filesystem / shell / web / cron / MCP tools,
  keeping workspace guards, exposed as `tau_agent.AgentTool`.
- `context.py` — system prompt assembly (identity, bootstrap files, memory,
  skills, tool snippets) plus the documentation-routing block for self-extension.
- `memory.py` — `Memory` (MEMORY.md, size-capped, HARD LESSONS protected) and a
  periodic `MemoryArchivist` that summarizes sessions into durable facts.
- `engine.py` — `SarathyEngine`: owns provider/skills/extensions/sessions,
  async event pub-sub, cron + heartbeat workers, cancel/restart plumbing.
- `repl.py` — the `sarathy agent` interactive CLI chat.

### Frontends (`sarathy/web/`, `sarathy/gateway/`)

The web portal is a FastAPI app serving a mobile-first PWA (static SPA) and the
REST/SSE API: chat, sessions, config, extensions, skills, tools, cron, plus
pairing auth (token printed on first run, signed cookie/Bearer thereafter).
The gateway runs the portal in-process.

### Extensions (`sarathy/extensions/`)

Pi-compatible extension model: loader (discovers `~/.sarathy/extensions/*`),
`ExtensionAPI` handed to each `setup(sarathy)`, and `ExtensionHost` that reloads
extensions, bakes their tools into sessions, dispatches events and exposes slash
commands. Extensions import only `tau_*` / `sarathy.*` public APIs.

### Skills (`sarathy/skills/`)

SKILL.md packages with hot reload (watchdog). Built-ins ship with the package;
user skills live in the workspace. Loaded on demand by reading SKILL.md.

## Data flow

1. User message arrives via REPL or web API → engine sends it to the session.
2. The session's `AgentHarness` runs the loop, calling tools (including
   extension tools) and emitting events.
3. Events flow: tau events → `ExtensionHost.dispatch` → engine pub-sub → SSE to
   the portal and REPL output.
4. The archivist periodically summarizes sessions into `memory/MEMORY.md`.

## Removed from v1

The hand-rolled `AgentLoop`, message bus, channel adapters (Telegram / Discord /
Email), LRU session manager and custom provider adapters are all replaced by
tau + this thin shell.
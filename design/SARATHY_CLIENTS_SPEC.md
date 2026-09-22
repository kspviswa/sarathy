# Sarathy Clients (SC) — Architecture & Implementation Spec

**Status:** Draft v1.0 — 2026-09-22
**Author:** Sarathy (with Viswa)
**Scope:** Distributed node fleet (SCs), gateway extensions, job workload management, dashboard visibility.

---

## 1. Vision

Sarathy (the brain, running in a VM) controls a fleet of **Sarathy Clients (SCs)** — deterministic,
whitelisted executor daemons running on user-owned hosts (macOS, Linux, Raspberry Pi, and later iOS as a
mobile surface). The SC is **not an agent**: it has no LLM, no improvisation, no free shell. It is a small,
auditable program exposing a strictly typed capability surface. All intelligence stays with Sarathy; all
execution stays sandboxed on the nodes.

The system is a combination of:

- **K8s-like control plane** — fleet registry, node health, workload distribution.
- **Task allocation & workload management** — jobs submitted to nodes, status streamed, artifacts returned.
- **Tailscale-like node experience** — nodes dial out, are always connected, expose services back to the brain.
- **MCP/A2A standards** — tool surface via MCP-shaped schemas, task lifecycle via A2A semantics.

## 2. Non-negotiable principles

1. **Deterministic executors.** SCs run only typed, pre-registered capabilities. No arbitrary command execution, no eval, no LLM on the node.
2. **Brain separation.** The LLM (Sarathy) never holds node credentials or SSH keys. It requests; the SC decides within its own policy.
3. **Node dials out.** SC → Gateway WebSocket. No inbound connections, no SSH exposure.
4. **Enforcement on the SC.** The allowlist and grant store live on the node; the gateway cannot widen them.
5. **Elevation, not circumvention.** Anything not allowed → `approval.request` → Viswa directly (Telegram). No fallback, no workaround path.
6. **Typed everything.** Every message, command, capability, and job has a schema. Versioned. Extendable by registration, not by editing the core.
7. **Extensibility by design.** New capabilities, services, and job types are plugins with a lifecycle (register → enable → deprecate). Core is stable.

## 3. Reference architectures adopted

| Source | Adopted idea |
|---|---|
| OpenClaw Nodes | Node dials out over WS; node declares command surface; allowlist per node |
| Meta Muse | Sentinel = sole permission authority; credential surrogation (authd); capability-bound grants; user prompts out-of-band |
| A2A v1.0 (Linux Foundation) | AgentCard discovery; task state machine (submitted → working → input-required → completed/failed); streaming updates |
| MCP | Tool surface as named tools with JSON schemas; service proxy = MCP servers hosted by the node |
| Hermes (Nous) | Validation of FTS5 memory + self-hosted model (already in Sarathy) |
| sarathyos (own repo, Mar 2026) | Seed: FastAPI host service exposing capabilities via MCP + API key. Evolves into the SC runtime's HTTP/MCP layer. |

## 4. System overview

```
┌────────────────────────────────────────────────────────────────┐
│  macOS / Linux / RPi host                                     │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Tauri Shell (system tray + UI)                        │  │
│  │  - start/stop SC, status, logs                         │  │
│  │  - allow/deny inspector, grant viewer                  │  │
│  │  - workspaces (folders) mgmt                           │  │
│  │  - host service ports (proxy config)                   │  │
│  └───────────────────────────┬─────────────────────────────┘  │
│  ┌───────────────────────────▼─────────────────────────────┐  │
│  │  SC Core (Go)                                          │  │
│  │  - protocol client (WS dial-out, pairing)              │  │
│  │  - capability registry (plugins)                       │  │
│  │  - allowlist + grant engine (enforcement point)        │  │
│  │  - job manager (spawn opencode / typed job templates)  │  │
│  │  - service proxy (MCP bridge to local ports)           │  │
│  │  - keyring (OS keychain for creds, never leaves node)  │  │
│  │  - audit log (append-only, local)                      │  │
│  └───────────────────────────┬─────────────────────────────┘  │
└──────────────────────────────┼────────────────────────────────┘
                               │ WSS (dial-out) + pairing key
                               ▼
┌────────────────────────────────────────────────────────────────┐
│  Sarathy Gateway (VM) — Python                                │
│  - WS listener / node registry (sqlite)                       │
│  - capability & grant mirrors                                 │
│  - job ledger (A2A state machine)                             │
│  - approval router → Telegram (ask-Viswa)                     │
│  - MCP client bridge (consume node services)                  │
│  - Dashboard API (fleet, jobs, sub-agents)                    │
└────────────────────────────────────────────────────────────────┘
```

## 5. Protocol

### 5.1 Transport

- **Now:** WebSocket (wss), SC dials out to Gateway listener. Auth = **node pairing key** (pre-shared at pairing, stored in OS keychain on SC, hashed in gateway DB).
- **Later:** mutual TLS with per-node certificates (replaces/upgrades pairing key).

### 5.2 Envelope (JSON, versioned)

```json
{
  "v": 1,
  "type": "job.status",
  "id": "msg-uuid",
  "node": "node-id",
  "ts": "2026-09-22T18:40:00Z",
  "payload": { }
}
```

Every message is validated against the schema registry before dispatch. Unknown type → dropped + error reply. No free-form fields.

### 5.3 Message types (dispatch table — strict)

**Fleet / control**
- `hello` — handshake after connect (node-id, version, capabilities hash)
- `heartbeat` — health, load, uptime (every 30s)
- `capability.update` — node announces capability changes (register/enable/deprecate)

**Registry (gateway side)**
- `node.list` / `node.add` / `node.revoke` — gateway commands (UI/API)
- `pair.request` / `pair.confirm` — pairing flow

**Tools (MCP-shaped)**
- `tool.call` — { capability, arguments } (validated against schema)
- `tool.result` — { ok, data | error }
- `tool.stream` — incremental results (long ops)

**Jobs (A2A task lifecycle)**
- `job.submit` — { job_id, type, node, workspace, spec, env_refs }
- `job.status` — { job_id, state, progress, message }
- `job.events` — streaming events (stdout chunks, sub-agent activity)
- `job.cancel` — { job_id }
- `job.artifact` — { job_id, path, kind }

**Services (proxy / MCP bridge)**
- `svc.register` — { name, port, type: "mcp"|"http", schema_uri }
- `svc.proxy` — gateway forwards tool calls to node-local service (e.g. searxng)

**Approvals (ask-Viswa)**
- `approval.request` — { id, capability, scope, reason, suggested_grant }
- `approval.response` — { id, decision, grant }

### 5.4 Job state machine (A2A)

```
submitted → running → input-required ⇄ running → completed | failed | canceled
```

States are owned by the **gateway job ledger**; the SC reports transitions via `job.status`. The SC never decides final state — the gateway does, on SC evidence.

## 6. Capability model (typed & strict)

A capability is the atomic unit of SC behavior. Nothing executes outside a registered capability.

```json
{
  "name": "files.read",
  "version": "1.0.0",
  "kind": "tool",
  "risk": "auto",
  "schema": { "type": "object", "properties": { "path": {"type":"string"} } },
  "scopes": ["/Users/viswa/ws", "/Users/viswa/Documents"],
  "state": "enabled",
  "deprecated_at": null
}
```

### 6.1 Risk classes

| Class | Meaning | Default |
|---|---|---|
| `auto` | Read-only / safe (files.read, calendar.list) | Allowed if capability enabled |
| `ask` | Write / sensitive / external effect (files.write, message.send, svc.start) | Requires grant or approval |
| `deny` | Never allowed, regardless of grant | Hard-coded |

### 6.2 Allowlist + grants

- **Allowlist** — per node, per capability, with scopes. Lives on the SC; gateway keeps a mirror for UI only.
- **Grant** — temporary or permanent permission elevation:
  `{ capability, node, scope, mode: one|session|task|time|perpetual, ttl, created, revoked }`
- Grants are created only by: (a) Viswa via Tauri UI, (b) Viswa via Telegram approval, (c) pairing-time defaults.

### 6.3 Capability lifecycle (extensibility)

```
register → enable → (deprecate) → disable → remove
```

New capabilities are **plugins** — they register themselves with the SC core at startup (Go plugin or compiled-in adapter), declare their schema + risk, and appear in the registry. No core changes needed. Deprecation keeps the old schema for compatibility during a grace window, then disables.

## 7. Job model

### 7.1 Job types (v1)

| Type | Description | Node action |
|---|---|---|
| `sdd` | SDD job (0xAlpha-style) | Spawn `opencode` headless in workspace; OC uses its own LLM; stream events; return artifacts |
| `run` | Typed job template (pre-registered only) | Executes an allowlisted template with validated args (e.g. `git status`, `pytest <path>`) — **never freeform** |
| `svc` | Service bring-up | Start/stop a registered local service (e.g. searxng) and register its port |

More job types = new plugins, same lifecycle.

### 7.2 SDD-on-node flow (the flagship)

1. Viswa: "Start an SDD job on node `home-mac`, workspace `~/ws/decode`."
2. Gateway: validates node + workspace + capability `jobs.sdd` (granted) → `job.submit {type: sdd, spec: <spec ref>}`.
3. SC: pulls spec, spawns `opencode` in the workspace with env from its own keyring (API keys injected at spawn, **never sent to the gateway**).
4. SC streams `job.events` (OC output, progress) → gateway updates job ledger + dashboard.
5. If OC needs an out-of-scope action → SC raises `approval.request` → Telegram → Viswa → grant → resumes.
6. On completion: `job.artifact` (diffs, summary) → gateway closes job → dashboard shows result.
7. From Sarathy's perspective this is a normal SDD job — same lifecycle as today, just executed remotely.

### 7.3 Job ledger

Event-sourced, append-only per job: every `job.status` / `job.events` / `job.artifact` is recorded. Enables replay, audit, and dashboard timelines.

## 8. SC software architecture (Go + Tauri)

### 8.1 Repo layout (new monorepo: `sarathy-os`)

```
sarathy-os/
  protos/            # JSON schemas (envelope, capabilities, jobs) — single source of truth
  sc/
    cmd/sc/          # entrypoint
    internal/
      core/          # engine, dispatch, FSM
      protocol/      # WS client, envelope codec, reconnect
      registry/      # capability registry + plugin loader
      allowlist/     # policy engine, grants, scopes
      jobs/          # job manager, spawner (opencode, templates)
      svcproxy/      # service proxy + MCP bridge
      keyring/       # OS keychain (creds, pairing key)
      audit/         # append-only audit log
    ui/              # Tauri shell (Rust + Svelte)
  gateway/           # Python: sc module (registry, ledger, approvals, dashboard API)
  dashboard/         # fleet + jobs views (extend existing sarathy dashboard)
  docs/
```

### 8.2 Design patterns

| Pattern | Where |
|---|---|
| Hexagonal (ports & adapters) | SC core: capability adapters behind ports; protocol is a port |
| Plugin registry | capability + job-type registration lifecycle |
| Command pattern | strict typed dispatch table — no eval, no dynamic dispatch |
| FSM | job lifecycle, connection lifecycle |
| Event sourcing | job ledger, audit log |
| Schema registry | versioned protos validated at both ends |
| Capability-bound grants | Muse-style, enforced at the SC |
| Surrogate credentials | keys live in SC keyring; gateway sees results only |

### 8.3 Tauri shell (macOS)

- **System tray:** status dot, start/stop SC, open UI, quit.
- **UI panes:**
  - **Activity** — live inbound tool calls / jobs; approve / deny / grant inline.
  - **Workspaces** — add/remove folders the SC may touch (scopes).
  - **Services** — list local ports (`searxng: 8888`), register them for gateway proxy.
  - **Grants** — view/revoke active grants.
  - **Logs** — local audit log viewer.

## 9. Gateway additions (Python)

- `sc/registry.py` — node DB (id, name, pairing hash, last_seen, capabilities mirror, state).
- `sc/ws.py` — listener, pairing handshake, heartbeat watchdog.
- `sc/ledger.py` — job ledger + A2A state machine.
- `sc/approvals.py` — approval router → Telegram inline buttons (approve/deny + grant picker).
- `sc/mcp_bridge.py` — MCP client side: node-registered services appear as tools to Sarathy (e.g. `searxng.search` → proxied to node port).
- `dashboard/` — fleet mgmt (list/add/revoke SC), job mgmt (submit/status/artifacts), sub-agents (future), approvals queue, audit view.

## 10. Security model

| Layer | Now (v1) | Later |
|---|---|---|
| Transport | WSS + pairing key | mTLS per-node certs |
| Node identity | pairing key (keychain) | cert-based identity |
| Enforcement | allowlist + grants on SC | same + signed policy bundles |
| Credentials | SC keyring, injected at spawn | surrogate/JIT tokens (Muse authd pattern) |
| Audit | append-only local log + ledger | signed/tamper-evident log |
| Egress | SC binds only to gateway + local services | egress policy on node |

**Elevation pipeline (ask-Viswa):** any capability not in `auto` or already granted → SC returns `needs_approval` and raises `approval.request` directly to Viswa via Telegram. The gateway (and therefore the LLM) cannot grant. No circumvention path exists by construction.

## 11. Phased roadmap

### Phase 0 — Spec freeze & scaffolding
- Freeze this spec; create `sarathy-os` monorepo; define protos; git init; CI skeleton.
- **Exit:** schemas versioned, repo builds.

### Phase 1 — SC core (Go) + gateway registry
- SC: WS client, pairing, heartbeat, capability registry, allowlist engine, audit log.
- Gateway: `sc` module — listener, registry, heartbeat watchdog, `node.list/add/revoke`.
- **Exit:** SC registers, heartbeats, gateway shows it in registry. No tools yet.

### Phase 2 — Tauri shell
- Tray + UI: start/stop, status, workspaces, grants, logs.
- **Exit:** macOS app manages SC lifecycle; Viswa can add a workspace folder via UI.

### Phase 3 — Tool calls + service proxy
- First capabilities: `files.read`, `files.write` (scoped), `sys.info` (typed template).
- Service proxy: register `searxng:8888` → gateway gets `searxng.search` MCP tool.
- Approval flow end-to-end: un-granted capability → Telegram prompt → grant → retry.
- **Exit:** Sarathy reads a file on the node and queries local searxng through the SC — no SSH.

### Phase 4 — Jobs + remote workspace (SDD-on-node)
- Job ledger, A2A state machine, `job.submit/status/events/artifact/cancel`.
- `sdd` job type: spawn opencode on node, stream events, return artifacts.
- `run` job type: typed templates (`git status`, `pytest`).
- **Exit:** "SDD job on node home-mac, workspace decode" works end-to-end with dashboard visibility.

### Phase 5 — Dashboard & fleet mgmt
- Fleet view (health, capabilities, grants), job view (timeline, artifacts), approvals queue, sub-agents placeholder.
- **Exit:** full visibility; revoke a node from the dashboard.

### Phase 6 — Hardening + iPhone SC
- mTLS, signed audit, credential surrogation.
- iPhone SC via Shortcuts bridge first (Phase 0 mobile), then native companion app.
- **Exit:** mTLS fleet; iPhone as mobile surface (calendar, reminders, photos, location, HomeKit).

## 12. Open questions

1. Go plugin model vs compiled-in adapters for capabilities? (Probably compiled-in for v1 — simpler, safer; plugins later.)
2. Should `run` job templates be shipped with SC or registered from gateway? (Ship with SC — enforcement on node.)
3. Dashboard: extend existing `~/ws/sarathy/dashboard` (React+Vite) or new? (Extend — reuse auth/UX.)
4. opencode on node: interactive TUI or headless mode? (Headless with event streaming for v1.)
5. iOS native app: separate build pipeline (Xcode) — timeline after Shortcuts bridge proves value.

## 13. Risks

- **iOS background limits** — mobile SC is on-demand (APNs wake), not always-on. Accepted; macOS/Linux are the workhorses.
- **opencode on node needs API keys** — keys stay in SC keyring; gateway never sees them. Requires trusting the node host (Viswa's own machines — fine).
- **Protocol drift** — schema registry + versioned envelopes mitigate; both ends validate.
- **Scope creep** — phases are exit-criteria gated; nothing moves forward without a demo.

---

*Next action: Phase 0 — freeze spec, scaffold `sarathy-os`, define protos.*
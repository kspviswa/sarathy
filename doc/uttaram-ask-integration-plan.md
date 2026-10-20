# Uttaram → Sarathy "Ask" mode: analysis & plan

Status: proposal (2026-10-20). No code changed yet.

---

## 1. What is actually in the source drop

`/home/kspviswa/vault/Uttaram_source_from_host/`

- `Uttaram/` — 1.4 GB working tree (incl. `.next/` build), Next.js 15 app, `package.json` v1.12.2,
  fork of Vane, git history present. `~/ws/Uttaram` is the same tree (src identical).
- `searxng/` — 36 KB of compose + config only (settings.yml, `.env`, valkey dump). No source.

Runtime shape:

- One Node process serves both FE and BE (`next start`, port 3000 → published 7777).
- SQLite via Drizzle at `data/db.sqlite`; app config at `data/config.json`; uploads in `uploads/`.
- Scraper = Playwright `chromium-headless-shell`, launched lazily, killed after 30 s idle
  (`src/lib/scraper.ts`). This is why the image is large and why RAM spikes during crawls.
- SearXNG is a separate container (core + valkey), JSON API on 8888.

Answer engine (`src/lib/agents/search/`):

- Modes map to researcher loop budget: speed = 2 iterations, balanced = 6, quality = 25.
- Sources: `web` | `discussions` | `academic`; each source is a tool the researcher LLM calls.
- Pipeline: researcher loop (search + scrape actions) → findings → writer prompt → streamed
  answer blocks with citations. Phase events: classifying → researching → writing.
- Widgets (weather/calc/stock) run in parallel, optional.
- Media search (`/api/images`, `/api/videos`) = LLM rewrites the query, then SearXNG image/video engines.

API surface relevant to integration (all plain HTTP):

- `POST /api/chat` → **NDJSON over `text/event-stream`** (`block`, `updateBlock`, `phase`,
  `researchComplete`, `messageEnd`, `error`). Body carries `chatModel{providerId,key}`,
  `embeddingModel`, `visionModel`, `optimizationMode`, `sources`, `history`, `files`,
  `systemInstructions`, `userProfile`, `enableMemories`. This is the clean seam.
- `POST /api/search` — headless search agent (non-UI), returns blocks/stream.
- `POST /api/images`, `POST /api/videos` — media search.
- `GET/POST /api/chats`, `/api/memories`, `/api/settings`, `/api/providers`, `/api/config`.
- `POST /api/mcp` — JSON-RPC: `search`, `crawl_as_html`, `crawl_as_md`, `crawl_batch`
  (this is what Sarathy already consumes today).
- Providers supported: `ollama`, `lmstudio`, `openai` (OpenAI-compatible → OpenRouter works),
  `anthropic`, `transformers` (local embeddings). Provider config lives in Uttaram's own DB/config.

Memory: `memories` table (content, category, embedding, sourceChatId). Extraction runs
asynchronously after each turn (`extractMemories()`), injection happens in the search agent via
`memoryStore.queryMemories()` with embeddings. There is also a health-check (dedup/merge) routine.

---

## 2. Integration models

**A. Separate portal only.** nginx `/ask/` → 7777. Zero code. Keeps every Uttaram feature
(graph, analytics, projects, PDF export). But: second UI, second settings screen, second memory
store, no link to Sarathy's providers or KB. Contradicts "reuse Sarathy's model setup".

**B. Rebuild everything inside the dashboard SPA.** Full control, one UI, one settings page.
But knowledge graph + analytics + projects + PDF export is weeks of work, and it forks upstream.

**C. Hybrid (recommended).** Sarathy is the front door; Uttaram is the engine.

- Dashboard gets an **Ask tab** (desktop + mobile) for the daily flow: query → mode → sources →
  streamed cited answer → media strip → history rail.
- Uttaram's own UI stays available as a portal for power features (library, graph, insights),
  behind the same tailnet edge, with a single "Open in Uttaram" link from the Ask tab.
- One backend of record: Uttaram's DB for ask threads; Sarathy's KB for memories; Sarathy's
  config for providers/models. Bridges keep them consistent.

Why an Ask **tab** and not a chat toggle: the two modes have different transcripts, different
composer (mode/sources/media), different stop semantics, and different history. A toggle would
force one transcript model and collide with `/stop`, `/steer`, `/btw`, session archiving and job
notifications. A tab keeps 1:1 chat clean. Cross-entry stays one click: quote a chat message →
"Research this" opens Ask prefilled; an Ask answer → "Continue in chat" seeds a chat turn.

---

## 3. Target architecture

```
dashboard SPA (desktop + mobile, shared module)
   │  POST /api/ask/stream   (SSE, dashboard token auth)
   ▼
Sarathy gateway (aiohttp, 18790)  ── /api/ask/*  ──►  Uttaram 127.0.0.1:7777
   │                                                   │
   │ provider/model config (single source of truth)     ├─► SearXNG 127.0.0.1:8888
   │ KB (kb.db) ◄── memory bridge ──────────────────────┤
   │                                                   └─► Playwright chromium
   └─ 1:1 chat unchanged, still uses MCP search/crawl
```

Sarathy gateway is the **only** client of Uttaram. The SPA never talks to 7777 directly, so
auth, rate limiting, model injection and memory bridging all live in one place.

New gateway endpoints:

- `POST /api/ask/stream` — proxy to Uttaram `/api/chat`; re-emit NDJSON frames as-is plus an
  `ask_meta` preamble (chatId, mode, sources). `fetch` + `ReadableStream` on the SPA (nginx
  `proxy_buffering off;`), so no WS protocol change.
- `POST /api/ask/stop` — abort the upstream request.
- `GET /api/ask/history?limit&q` — proxy `/api/chats` (+ `/api/chats/search`).
- `GET /api/ask/chat/{id}` — proxy `/api/chats/{id}` for reload.
- `POST /api/ask/media` — proxy `/api/images` or `/api/videos`.
- `GET /api/ask/memories` / `POST /api/ask/memories` — view + add, writing through to KB.
- `GET /api/ask/health` — Uttaram + SearXNG reachability, for Status tab.

---

## 4. Ask tab UX (both shells, one shared module)

- Composer: query box, mode segmented control (Speed / Balanced / Deep), sources chips
  (Web / Discussions / Academic), attach file, image/video toggle.
- Stream: phase line ("searching… extracting… writing…"), collapsible research steps
  (queries issued, URLs scraped), then the answer with numbered citations.
- Answer actions: copy, cite list, "Continue in chat", "Open in Uttaram", export PDF (link).
- Media strip: image grid + video cards, lightbox reuse.
- Right rail (desktop) / drawer (mobile): History — recent ask threads, searchable; Projects as
  optional grouping. Same data, two shells, shared components per HARD LESSON 22.
- Empty state: suggestions + "recent searches" catalog.

Deliberately **not** rebuilt in phase 1: knowledge graph, analytics clusters, memory health-check
UI, Discover/trending, widgets. Those stay in the portal.

---

## 5. Settings & model reuse

Sarathy Config tab gains an "Ask / Research" section. New config block:

```
modalities.embedding   {provider, model}          # new modality
ask:
  enabled: true
  uttaram_url: http://127.0.0.1:7777
  searxng_url: http://127.0.0.1:8888
  default_mode: balanced        # speed | balanced | quality
  default_sources: [web]
  enable_memories: true
  memory_sync: both             # off | ask_to_kb | kb_to_ask | both
  auto_media_search: true
  context_length: 8192
  embedding_context_length: 2048
  throttle_enabled: true
  max_parallel_llm_calls: 2
  max_scrape_concurrency: 3
```

Provider mapping (Sarathy → Uttaram), applied idempotently at startup and on every config write:

- `custom` (OpenAI-compatible, e.g. OpenRouter) → Uttaram provider type `openai` with baseURL+key.
- `lmstudio` → `lmstudio`; `ollama` → `ollama`.
- `modalities.main` → chat model; `modalities.image` → vision model; `modalities.embedding` → embedding.

Embedding model options: LM Studio local embedding (preferred, no extra RAM in the VM) or
Uttaram's bundled `transformers` provider (CPU, ~100–300 MB, slower). Decide in phase 1.

No API keys get duplicated in two config files — Uttaram's provider row is a projection of
Sarathy's config, rewritten whenever it changes.

---

## 6. Memory unification

Canonical store = Sarathy KB (`kb.db`, FTS5). Uttaram's `memories` table becomes a mirror used
for its own relevance query.

- **Ask → KB:** after a turn, Uttaram extracts memories. Bridge polls
  `GET /api/memories` (or the fork adds a webhook), dedups by `source='ask:<chatId>:<messageId>'`,
  then `memory_cli.py add` with `kind=fact`, `category=ask-memory`, `tags=uttaram,ask`.
- **KB → Ask:** on each new ask thread, top-K KB entries (FTS5 match on the query, fallback to
  recent) are POSTed to `/api/memories` so `queryMemories()` injects them naturally. Also pass a
  compact "known facts" block in `systemInstructions` for the first turn.
- Health-check/dedup stays where it is for Uttaram's mirror; KB dedup follows the existing
  search-then-update rule. No hand consolidation.
- Result: what Viswa tells Sarathy in chat personalises Ask, and what Ask learns shows up in chat.

---

## 7. History & insights

- Ask history is Uttaram's `chats` table — the "catalog of prior searches". Ask tab reads it via
  the gateway. Sarathy's Sessions tab stays 1:1 chat only; no mixing of namespaces.
- Cross-links only (quote → ask, answer → chat), never merged transcripts.
- Insights (graph, clusters, semantic chat search) = portal-only, phase 3, one link away. Building
  it in the dashboard means duplicating embeddings + cluster-label caching for little daily value.

---

## 8. Infra: where it runs

Current box: 8 vCPU, 7.7 GiB RAM, 3.8 GiB swap (**2.2 GiB already swapped**), 60 GB disk with
19 GB free, aarch64, Docker installed but `kspviswa` is not in the `docker` group.

### Option 1 — Docker Compose (recommended for Uttaram)

`~/portals/uttaram/` holding `docker-compose.yml`, `data/`, `searxng/`.
Ports bound to `127.0.0.1` only: 7777, 8888. Wrap in a systemd unit so it behaves like every
other portal (`systemctl status uttaram`).

- Pros: Playwright + chromium system deps are exactly the fragile part of a native install;
  the image is already built and pinned; rollback = previous tag; upstream updates = pull.
  SearXNG's supported deployment is its image (+ valkey).
- Cons: second runtime; ~250–400 MB daemon overhead; 3–5 GB image storage; needs docker group
  (sudo); docker publishes ports through its own iptables chain (mitigated by binding to loopback).

Sizing: uttaram limit 6 GB / reserve 1 GB, `shm_size: 512m` (scraper already passes
`--disable-dev-shm-usage`), searxng 512 MB, valkey 256 MB. Chromium is lazy and self-killing,
so idle footprint ≈ 300–500 MB; heavy deep-mode crawls are the spike.

### Option 2 — native systemd

SearXNG in a venv (host Python 3.10 is enough) on 8888; Uttaram as Next standalone under
Node 22 (host has 22.22; the Dockerfile pins 24 — would need nvm or a 24 binary). Chromium +
libnss/libgbm deps installed by hand.

- Pros: no daemon overhead, same ops pattern as manana/shravana, direct logs/journal.
- Cons: manual chromium dependency chain on aarch64, manual rebuilds on every upstream change,
  Node version drift, no clean rollback. This is the option most likely to break at 2 a.m.

### Option 3 — hybrid (native SearXNG + docker Uttaram)

SearXNG is light and boring; native costs ~150 MB and no daemon. Reasonable fallback if Docker
proves annoying, but it doubles the install stories. Not worth it initially.

**Recommendation: Option 1** — both containers, one compose project, one systemd wrapper.
It matches "run like any other portal" from the outside while keeping the bundled browser stack
intact inside.

### Implications / prerequisites

1. RAM: 8 → 16 GiB (as planned). With 2.2 GiB already in swap, 8 GiB cannot host a 6 GB cap.
2. Disk: 19 GB free is workable but tight (build cache + images). Either extend the LVM volume
   (`lvextend` on ubuntu-vg, needs sudo) or prune images and keep the build context off the box
   (build on the Mac, push to a registry, pull on the VM). Prefer the latter for ARM parity.
3. Docker access: `sudo usermod -aG docker kspviswa` (sudo approval required, one-time).
4. Docker root must stay on local disk — never on `/mnt/utm_shared_drive` (network share).
5. Firewall: bind to 127.0.0.1; never publish 0.0.0.0.
6. TLS/edge: if exposed as a portal, `/uttaram/` via nginx with the tailnet-only snippet; Uttaram
   has no auth of its own, so do not expose it publicly.
7. Backups: nightly copy of `data/db.sqlite` (+ `-wal`) and `data/config.json`; these are the only
   stateful bits. 224 KB today.
8. Observability: add both health endpoints to the Status tab; alert if 7777 or 8888 is down —
   the Ask tab and Sarathy's own MCP search both depend on them.
9. Migration: stop the Mac containers, copy `~/ws/Uttaram/data` → VM, verify provider keys, then
   flip `tools.mcpServers.uttaram.url` to `http://127.0.0.1:7777/api/mcp`.

---

## 9. Phased plan

**Phase 0 — infra (half a day, needs sudo + reboot)**
RAM expansion, docker group, `~/portals/uttaram` compose, loopback binds, systemd wrapper,
health checks, backup hook, migrate data, repoint MCP. Acceptance: `curl /api/mcp` and
`/search?format=json` from the VM; Sarathy's `search` tool still works.

**Phase 1 — bridge + Ask tab core (3–4 days)**
Config block + provider sync, gateway `/api/ask/*`, Ask section in both shells (shared module),
streaming with phases/citations, mode + sources, stop, reload from history, media strip,
Status entries. Acceptance: a deep-mode question with citations works on desktop and mobile;
reload restores the thread; stop aborts.

**Phase 2 — memory + history (2 days)**
KB↔Uttaram bridge both directions, memory panel, history rail with search, quote→ask and
answer→chat cross-links. Acceptance: a fact stated in chat changes an Ask answer; a fact learned
in Ask appears in KB search.

**Phase 3 — portal + insights (optional, 2–3 days)**
`/uttaram/` behind tailnet, "Open in Uttaram" deep links, insights/graph access, PDF export link,
projects surfaced in the Ask rail.

**Phase 4 — hardening (ongoing)**
Scrape/LLM concurrency caps, cost guard on quality mode (25 iterations), per-thread token usage
in the answer footer, weekly KB memory-health run.

---

## 10. Risks

- **Streaming bridge** — NDJSON frames must survive nginx (disable buffering, no gzip) and abort
  cleanly. Mitigation: fetch+ReadableStream on the SPA, explicit abort endpoint, 300 s idle timeout.
- **Provider drift** — Sarathy config changes leaving Uttaram stale. Mitigation: sync on boot and
  on every config write; show a "models out of sync" badge in Config.
- **Memory duplication** — same fact in KB twice. Mitigation: source-key uniqueness + KB search
  before add.
- **RAM spikes** — quality mode = up to 25 iterations × parallel scrapes. Mitigation: 16 GB,
  LLM semaphore, scrape concurrency cap, container memory limit.
- **Two UIs diverging** — portal and Ask tab showing different behaviour. Mitigation: Ask tab is
  the only daily driver; portal is explicitly "power features only", linked, not advertised.
- **Maintenance fork** — Uttaram is Viswa's fork; upstream Vane changes will need merges either way.

---

## 11. Decisions needed

1. RAM target (16 GiB?) and disk (extend LVM vs build-on-Mac/pull).
2. Docker vs native — recommendation: Docker.
3. Embedding model: LM Studio local vs Uttaram's bundled transformers.
4. Ask as a tab (recommendation) vs toggle.
5. Portal exposure in phase 3: yes/no.

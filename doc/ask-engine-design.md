# Sarathy Ask Engine + Dashboard Design

Status: design proposal, 2026-10-20. Supersedes `uttaram-ask-integration-plan.md`
(the proxy-based plan) after Viswa's direction: port the engine into Sarathy, phase out
the standalone Uttaram UI, keep it as an MCP appliance.

---

## 0. Correction to the earlier plan

`~/ws/Uttaram/node_modules` was **not** usable as-is. Evidence:

- `.next/` contains only `dev/` — no production build ever completed on this host.
- `package-lock.json` resolves 14 `darwin` platform packages; npm picked linux-arm64 for
  some (`@img/sharp-linux-arm64`, `@napi-rs/canvas-linux-arm64-gnu`, `@next/swc-linux-arm64-gnu`)
  because those are the only ones present in `node_modules`, but the tree is a mix and the
  lockfile was authored on macOS.
- Playwright browsers in `~/.cache/ms-playwright` are Linux arm64 and **do** run
  (`chromium OK 151.0.7922.34`, zero missing libs).

Action: `rm -rf node_modules .next && npm ci && npm run build` on the VM. `npm ci` is the
authority — it resolves the lockfile for the current platform and fails loudly if it can't.

---

## 1. Code review — what comes into Sarathy

Uttaram is 9,333 lines of `src/lib` TS + ~4,000 lines of app routes/UI. The engine is a
small core; the rest is product surface.

### Port to Python (`sarathy/ask/`)

| Subsystem | TS source | LOC | Port est. | Notes |
|---|---|---|---|---|
| SearXNG client | `lib/searxng.ts` | 68 | 60 | httpx, JSON API, retry |
| Scraper | `lib/scraper.ts` | 169 | 150 | Playwright python + trafilatura; idle-kill 30 s |
| Search orchestrator | `agents/search/index.ts` | 332 | 250 | phases, block emit, DB sync |
| Researcher loop | `agents/search/researcher/index.ts` | 235 | 220 | tool-calling loop, iteration budget |
| Actions | `researcher/actions/**` | ~1,100 | 700 | web/social/academic search, scrape, plan, done |
| Prompts | `prompts/search/*` | 450 | 450 | verbatim strings |
| Types / session / blocks | `types.ts`, `session.ts` | 257 | 200 | block union + JSON-patch emitter |
| Memory extractor | `memory/extractor.ts` | 197 | 150 | LLM call → KB entries |
| Media agents | `agents/media/*` | ~150 | 120 | query rewrite → SearXNG image/video |
| Utils | `withRetry`, `splitText`, `computeSimilarity` | 290 | 150 | retry/status, token split, cosine |
| **Total** | | **~3,250** | **~2,450** | |

### Not ported — already exists in Sarathy

| Uttaram | Sarathy equivalent |
|---|---|
| `models/providers/**` (~1,900 LOC) | `sarathy/providers/` — already has tool calls + streaming |
| `config/**` (465) | `sarathy/config/schema.py` — add `modalities.embedding` + `ask:` block |
| `memory/store.ts` (242) + `embedding/service.ts` (417) | `kb.db` FTS5 — no embeddings needed in v1 |
| `uploads/manager.ts` (224) | dashboard `/api/media` |
| widgets (weather/stock/calc, ~645) | Sarathy tools |
| `db/migrate.ts` (288) | new `ask.db` schema, created on boot |

### Not ported — deliberately dropped

Analytics clusters, knowledge graph, Discover/trending, projects, PDF export, LaTeX,
suggestions, memory health-check UI, setup wizard. These stay in the standalone portal
until it is retired.

### Kept standalone (frozen)

`api/mcp` + `lib/mcp/tools.ts` (271) and the full Next UI. Purpose: MCP service for
external clients. No further feature work.

---

## 2. Target architecture

```
                 ┌──────────────────────────────────────────┐
   dashboard ────►  sarathy gateway (aiohttp :18790)        │
   (desktop+mobile)│  ├─ 1:1 chat  (agent loop, unchanged)  │
                 │  ├─ Ask engine  sarathy/ask/  (in-proc)  │
                 │  └─ /api/ask/*  (history, media, stop)   │
                 └───────┬──────────────────────┬───────────┘
                         │                      │
                 ┌───────▼───────┐      ┌───────▼────────┐
                 │ searxng :8888 │      │ ask.db (SQLite)│
                 │ systemd       │      └────────────────┘
                 └───────▲───────┘
                         │  (also used by)
                 ┌───────┴───────────────┐
                 │ uttaram :7777 (frozen)│──► /api/mcp  (external MCP clients)
                 │ systemd, own data/    │
                 └───────────────────────┘
```

Three processes, three responsibilities:

1. **searxng.service** — stateless search backend, loopback 8888. Shared by Sarathy's Ask
   engine, Sarathy's `web_search` tool, and the frozen Uttaram.
2. **uttaram.service** — frozen Next app, loopback 7777, own `data/`. Serves `/api/mcp`
   and its own UI. No longer developed.
3. **sarathy gateway** — hosts the Ask engine in-process. No new service, no new port.

Why in-process rather than a 4th service: the engine needs Sarathy's providers, config and
KB. A separate process would need an IPC contract for all three. In-process means Ask is
just another consumer of `ProviderManager` and `kb.db`.

---

## 3. `sarathy/ask/` module

```
sarathy/ask/
  __init__.py
  engine.py        # orchestration: phases, blocks, writer, persistence
  researcher.py    # tool-calling loop, iteration budget
  actions/         # web_search, social_search, academic_search, scrape, plan, done
  searxng.py       # client
  scraper.py       # playwright + trafilatura, idle browser pool
  media.py         # image/video search
  memory.py        # KB extraction + retrieval bridge
  prompts/         # researcher.txt, writer.txt (verbatim from Uttaram)
  store.py         # ask.db access
  blocks.py        # block union + patch emitter
  types.py
```

Modes → iteration budget: speed 2, balanced 6, quality 25 (unchanged).
Sources: `web`, `discussions`, `academic` (unchanged).

Model wiring: `modalities.main` for both researcher and writer; `modalities.image` for
vision on attachments. No provider abstraction is ported — the engine calls
`provider.chat(messages, tools=..., stream=True)`.

---

## 4. `ask.db` schema

`~/.sarathy/ask/ask.db` — the catalog of prior searches.

```sql
chats(id TEXT PK, title TEXT, mode TEXT, sources TEXT, created_at, updated_at)
messages(id TEXT PK, chat_id → chats, role TEXT, query TEXT, blocks_json TEXT,
         phase TEXT, status TEXT, usage_json TEXT, created_at)
sources(message_id → messages, idx INTEGER, title TEXT, url TEXT, domain TEXT)
searches(message_id → messages, queries_json TEXT, engines TEXT,
         result_count INTEGER, scraped_count INTEGER, iterations INTEGER,
         latency_ms INTEGER)
media(message_id → messages, kind TEXT, url TEXT, thumb TEXT, title TEXT)
messages_fts  -- FTS5 over query + rendered answer text
```

`messages_fts` gives history search without embeddings.

---

## 5. Streaming protocol — extend the existing WS, no second transport

The dashboard already owns a socket with reconnect, turn state, stop and a shared
transcript reducer (`dashboard/src/lib/transcript.ts`). Ask reuses it. New metadata keys,
same envelope:

| Key | Payload | Rendered as |
|---|---|---|
| `_ask_phase` | `classifying` / `researching` / `writing` | phase line under the bubble |
| `_ask_step` | `{kind: "searching", queries:[…]}` | collapsible research row |
| `_ask_step` | `{kind: "reading", url, title}` | collapsible research row |
| `_ask_source` | `{idx, title, url}` | citation chip + source list |
| `_ask_media` | `{kind:"image"/"video", url, thumb, title}` | media strip |
| `_ask_usage` | tokens, iterations, latency | answer footer |
| `_ask_end` | `{chat_id, message_id}` | seal + persist |

Stop = existing `/api/chat/stop` path, extended to abort the researcher loop. One reducer
branch, shared by both SPAs — parity by construction (HARD LESSON 20/22).

---

## 6. Dashboard design

### Desktop — left rail

`Chat · Ask · Sessions · Files · Jobs · Analytics · Config`

### Mobile — bottom bar

`Chat · Ask · Sessions · Config`

- **Config absorbs Status.** One page, sections: Providers · Ask · Devices · Files · Jobs ·
  System (old Status: version, presence, logout, restart).
- **Files and Jobs fold into Config** on mobile — they are occasional, not daily.
- **Analytics is desktop-only.** On mobile the KPI cards surface at the top of Config.
- The tab bar scrolls horizontally when it overflows (safe at 320 px with 4 tabs; the
  Config section strip is where overflow actually happens).

If you want strictly three on mobile, Sessions folds into a history sheet in the Chat
header — but then a past thread is two taps away instead of one. Recommendation: keep four.

### Ask tab

```
┌───────────────────────────────────────────────┬──────────────────┐
│  [ query ………………………………………… ]  [Ask]          │  History         │
│  Mode:  Speed │ Balanced │ Deep               │  ─────────────   │
│  Sources: Web · Discussions · Academic         │  ▸ today         │
│                                                │    · query …     │
│  ● searching 3 queries                         │    · query …     │
│  ▾ research steps (12)                         │  ▸ yesterday     │
│    · "…" → 8 results                           │                  │
│    · reading example.com                       │  [search history]│
│                                                │                  │
│  ## Answer                                     │                  │
│  Prose with inline citations [1][2] …          │                  │
│                                                │                  │
│  Sources: 1. … 2. … 3. …                       │                  │
│  ▸ Images (8)   ▸ Videos (3)                   │                  │
│  ── 4.2 s · 6 iterations · 12 sources · 2.1k   │                  │
│  [Copy] [Continue in chat] [Open in Uttaram]   │                  │
└───────────────────────────────────────────────┴──────────────────┘
```

- Media strip collapsible, collapsed by default (answers first, media on demand).
- "Continue in chat" seeds the chat composer with the answer as context.
- "Open in Uttaram" deep-links `/c/<id>` — kept until the portal is retired.

### Analytics tab (desktop)

| Section | Content |
|---|---|
| Usage | tokens in/out, **cached tokens + cache hit %** (moved from Status), per-model table, 30-day series |
| Cost | per-model spend, daily trend |
| Ask | searches/day, mode mix, avg iterations, avg latency, sources per answer, scrape success rate |
| Memory | KB entries by category, growth curve, last extraction, top tags |
| Cache | prompt-cache hit rate by model (the stats currently in Status › UsageCard) |

---

## 7. Memory unification

KB is canonical; no second memory store.

- **Ask → KB:** after a turn, `memory.extractor` asks the main model for durable facts, then
  writes via the KB API with `source='ask:<chat_id>:<message_id>'`. Dedup = search-then-update
  (existing rule). Category `ask-memory`, tags `ask,uttaram`.
- **KB → Ask:** before writing, FTS5-match the query, take top 5, inject as a
  `<user_memories>` block in the writer prompt. Falls back to recent entries when the query
  has no match.
- Chat gets the same benefit for free — KB entries created by Ask are visible to the 1:1 agent.
- No embeddings in v1. Add `modalities.embedding` later only if FTS5 recall proves weak.

---

## 8. Infra / systemd

| Unit | Port | State | RAM (idle) |
|---|---|---|---|
| `searxng.service` | 127.0.0.1:8888 | `settings.yml`, cache dir | ~150 MB |
| `uttaram.service` | 127.0.0.1:7777 | `~/portals/uttaram/data/` | ~350–500 MB (chromium spikes) |
| gateway | 127.0.0.1:18790 | `~/.sarathy/` | +100 MB for Ask |

- SearXNG from a venv, `limiter: false` (loopback only), no valkey needed.
- Uttaram: `npm ci && npm run build`, `next start -p 7777`, Node 22 (host) — Next 16 needs
  ≥20.9, package.json has no `engines` pin. Revisit only if a future bump breaks.
- nginx: `uttaram.skandpriya.com` with the existing `tailnet-only.conf` snippet. Subdomain,
  not `/uttaram/` — the app has no `basePath` and absolute `/_next/*` URLs would break.
- Sarathy's `web_search` tool repoints from the Mac MCP to local SearXNG; MCP stays as
  fallback. Faster, and no longer depends on `192.168.0.18`.
- RAM: 8 → 16 GiB. This box is already 2.2 GiB into swap with nothing new running.

---

## 9. Phases

**P0 — services up (½ day)**
Rebuild `node_modules`/`.next`, searxng + uttaram systemd units, loopback binds, tailnet
subdomain, migrate `data/`, repoint Sarathy's search tool to local SearXNG, keep MCP alive.

**P1 — engine port (4–5 days)**
`sarathy/ask/`: searxng, scraper, actions, researcher, writer, blocks, store. Golden-answer
comparison against standalone Uttaram on a fixed 20-question set (same provider/model).

**P2 — Ask tab (3–4 days)**
Gateway endpoints, WS frames, shared reducer branch, Ask view for both shells, history rail,
media strip, stop, reload.

**P3 — dashboard restructure (2 days)**
Config absorbs Status; Analytics tab; mobile bar 4 tabs + horizontal overflow; cache stats
move.

**P4 — memory bridge (1–2 days)**
Extractor → KB, KB → prompt, memory section in Analytics.

**P5 — phase-out (½ day)**
Stop advertising the portal; keep the unit for MCP. Optional later: replace the frozen
Uttaram with a thin MCP-only shim.

Total ≈ 2.5 weeks of focused work.

---

## 10. Risks

- **Prompt/loop fidelity.** The ported researcher must behave like the original. Mitigation:
  verbatim prompts, same iteration budgets, and the 20-question golden set before cutover.
- **Two engines diverge.** Mitigation: the standalone is frozen at its current commit; all
  changes land in Python only.
- **Duplicate memory writes.** Mitigation: `source` key uniqueness + search-then-update.
- **Scrape flakiness.** Same code path as today, but now local. Mitigation: idle browser
  pool + retry/status blocks, and a scrape-success metric in Analytics.
- **Quality-mode cost.** 25 iterations on a paid model. Mitigation: per-answer token footer,
  a soft warning above a configurable ceiling, semaphore cap on parallel calls.

---

## 11. Decisions needed

1. Mobile: 4 tabs (Chat · Ask · Sessions · Config) — recommendation — or strictly 3?
2. Analytics on mobile: omit (recommended) or a compact section inside Config?
3. Uttaram portal: keep the full UI behind the tailnet subdomain, or MCP-only from day one?
4. RAM: 16 GiB confirmed?
5. Golden-set cutover: do we require the 20-question comparison before switching, or ship
   Ask as opt-in alongside the portal first?

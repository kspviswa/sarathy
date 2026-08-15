# Sarathy Long-Term Memory

Sarathy keeps durable knowledge in `MEMORY.md` inside the workspace
(`<workspace>/memory/MEMORY.md`). The system prompt instructs the model to read
it at the start of sessions and write important facts there.

## Layout

MEMORY.md is a markdown file of dated sections:

```markdown
## 2026-08-01 09:30
- Prefers code examples over prose explanations
- Works in `/Users/kspviswa/ws/sarathy`
```

## Rules

- **Generalize**: store facts that hold across sessions; skip one-off task
  details.
- **Keep it short**: section facts stay under ~120 characters.
- **Deduplicate**: repeated facts are not written twice.
- **HARD LESSONS are protected**: sections containing `HARD LESSONS` are never
  pruned, even when the file exceeds `max_size` (default 3000 chars).
- **Newest wins**: when trimming, newest sections are kept and oversized ones
  are truncated, never dropped entirely.

## The archivist

The `MemoryArchivist` runs periodically (default every 30 minutes) and uses the
model itself to summarize recent session excerpts, calling the LLM with the
consolidation prompt, then merging the returned facts via `add_facts`. It only
runs on sessions with at least `min_messages` (default 8) messages.

## API

- `Memory.read()` / `Memory.write(content)`
- `Memory.add_facts(facts: list[str]) -> int` — appends (deduped) new facts,
  returns how many were added.
- `Memory.context_block()` — markdown block for the system prompt.
- `MemoryArchivist.consolidate(excerpt) -> int` — one extraction pass.
- `MemoryArchivist.start()` / `stop()`.

Use the engine's memory APIs from the web (`GET/PUT /api/memory`) and the CLI
(`sarathy memory`).
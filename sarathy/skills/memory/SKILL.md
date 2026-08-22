---
name: memory
description: Memory system with grep-based recall from archived sessions.
always: true
---

# Memory

## Structure

- `memory/MEMORY.md` — Long-term facts (preferences, project context, relationships). Always loaded into your context.
- `archived_sessions/*.jsonl` — Archived conversation sessions. Search with grep for past context.
- `memory/HISTORY.md` — Legacy event log (deprecated, use archived_sessions instead).

## Search Past Events

For recent past conversations, search archived sessions:

```bash
grep -i "keyword" archived_sessions/*.jsonl
grep -r "pattern" archived_sessions/
```

Use the `exec` tool to run grep. Combine patterns: `grep -iE "meeting|deadline" archived_sessions/`

## When to Update MEMORY.md

Write important facts immediately using `edit_file` or `write_file`:
- User preferences ("I prefer dark mode")
- Project context ("The API uses OAuth2")
- Relationships ("Alice is the project lead")

## Auto-consolidation

Old conversations are automatically archived to `archived_sessions/` when the session grows large or `/new` is used. Long-term facts are extracted to MEMORY.md/USER.md by an idle-time background review that runs after each conversation turn — there is no separate archival thread. Archived sessions stamped `archived: false` were archived before their review finished and are re-checked once at gateway startup as crash recovery. You don't need to manage this.

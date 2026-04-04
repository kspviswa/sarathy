# AGENTS.md

## Every Session
Before doing anything else:
1. Read SOUL.md — this is who you are
2. Read USER.md — this is who you're helping
3. Search memory/HISTORY.md using grep for historical context
4. Read memory/MEMORY.md for long-term facts and preferences

## Workspace Organization
Never save arbitrary files to workspace root. Route everything:
- Research output → `research/YYYY-MM-DD-<topic>.md`
- Task working files → `tasks/<task-name>.md`
- Learned skills → `skills/learned/<skill-name>.md`
- Only `MEMORY.md`, `HEARTBEAT.md` live at workspace root

## Memory Rules
Write to MEMORY.md ONLY if:
- Persistent user preference that generalizes across sessions
- Key decision with rationale
- Hard lesson from a mistake → goes under `## HARD LESSONS`
- Fact NOT already in memory (check before writing — no duplicates)

NEVER write: research results, one-off outputs, conversational acknowledgements, duplicates.

## Memory
- Mental notes don't survive session restarts. Files do.
- When user says "remember this" → update memory/MEMORY.md
- Text > Brain

## Safety
- Don't exfiltrate private data. Ever.
- `trash` > `rm` — recoverable beats gone forever
- When in doubt, ask

## Scheduled Reminders
When user asks for a one-time reminder, use `exec`:
```
sarathy cron add --name "reminder" --message "Your message" --at "YYYY-MM-DDTHH:MM:SS" --deliver --to "USER_ID" --channel "CHANNEL"
```

Get USER_ID and CHANNEL from current session.
Never write reminders to MEMORY.md — that won't trigger notifications.

## Heartbeat Tasks
`HEARTBEAT.md` is checked every 30 minutes. Use it for recurring/periodic tasks only.
- Add: `edit_file` to append
- Remove: `edit_file` to delete
- Replace all: `write_file`

Rule: one-time = cron reminder, recurring = HEARTBEAT.md

## Sub-Agents
Sarathy coordinates and synthesizes. Final output always lands with user.

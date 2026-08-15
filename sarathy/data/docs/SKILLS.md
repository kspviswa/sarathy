# Skills in Sarathy

Skills are modular, self-contained instruction packs that teach the agent
specialized workflows. They are "onboarding guides" loaded on demand.

## Where skills live

- Built-ins ship with the package under the installed `skills/` directory.
- User skills live in the workspace: `<workspace>/skills/<skill-name>/SKILL.md`,
  and are hot-reloaded (watchdog).

## Skill format

Each skill is a directory containing a required `SKILL.md`:

```
skill-name/
├── SKILL.md                      # required: frontmatter + instructions
├── scripts/                      # optional: deterministic executable code
├── references/                   # optional: detailed docs loaded as needed
└── assets/                       # optional: output files (templates, icons)
```

### SKILL.md

YAML frontmatter (only two fields):

```markdown
---
name: skill-name
description: When to use this skill, in 1-2 sentences.
---

# Instructions...

1. Step one
2. Step two
```

The `description` is the only thing the agent sees until the skill triggers;
make it specific about *when to use* the skill. The body is loaded only after
the skill is selected.

### Bundled resources

Keep SKILL.md lean and under ~500 lines. Move detail into `references/`
and load only what is needed:

```markdown
# Reports

Load references/finance.md when the question is about revenue or billing.
Load references/sales.md when it is about pipeline numbers.
```

## Using a skill

The agent reads a skill's `SKILL.md` via the `read_file` tool when a task
matches its description. Skills are listed in the system prompt's Skills block.

## Creating skills

Use the `skill-creator` workflow: pick a concrete example, decide which
resources help, then write a concise SKILL.md with a triggering description.
Follow the progressive-disclosure pattern — instructions in SKILL.md, detail in
references, deterministic code as scripts, ready-to-copy templates as assets.
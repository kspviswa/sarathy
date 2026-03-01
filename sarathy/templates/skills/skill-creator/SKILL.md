---
name: skill-creator
description: Guide for creating custom skills for Sarathy
commands:
  - name: skill-create
    description: Create a new skill
    help: |
      Usage: /skill-create <skill-name>
      
      This command helps you create a new skill structure.
      
      Steps:
      1. Creates skill directory
      2. Creates SKILL.md with template
      3. Opens editor for customization
---

# Skill Creator

This skill helps you create new skills for Sarathy.

## What is a Skill?

A skill is a folder containing a `SKILL.md` file that teaches Sarathy how to do something specific. Skills can:
- Provide specialized workflows
- Add domain-specific knowledge
- Define slash commands for easy access

## Creating a Skill

To create a new skill:

1. Create a folder: `~/.sarathy/workspace/skills/<skill-name>/`
2. Add a `SKILL.md` file with:
   - YAML frontmatter (name, description, commands)
   - Markdown instructions

## SKILL.md Format

```yaml
---
name: my-skill
description: What this skill does
commands:
  - name: my-command
    description: Command description
    help: |
      Usage: /my-command [options]
---

# My Skill

Instructions for the agent...
```

## Commands

Use `/skill-create <name>` to create a new skill interactively.

---
name: remember
description: Save important information to memory
commands:
  - name: remember
    description: Save important information to memory
    help: |
      Usage: /remember <text>
      
      Saves the text to your personal memory. Use this to store
      important information like preferences, API keys, or facts.
      
      Examples:
        /remember My API key is xyz123
        /remember I prefer responses in bullet points
---

# Remember Skill

This skill allows you to save important information to your personal memory.

## How to Use

Simply type `/remember` followed by what you want to remember.

## Examples

- `/remember My name is John` — saves your name
- `/remember I work at Acme Corp` — saves your workplace
- `/remember Use Python for scripting` — saves a preference

## What This Does

When you use `/remember`:
1. The information is saved to your personal memory
2. You'll receive confirmation that it was saved
3. The agent will recall this information in future conversations

## Tips

- Be specific with what you remember
- Include context that helps the agent understand
- You can update memories by using `/remember` again with new information

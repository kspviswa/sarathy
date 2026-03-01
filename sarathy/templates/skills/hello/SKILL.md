---
name: hello
description: A simple hello world skill to demonstrate skill structure
commands:
  - name: hello
    description: Say hello to the user
    help: |
      Usage: /hello [name]
      
      Examples:
        /hello
        /hello World
---

# Hello Skill

This is a simple skill that demonstrates how skills work in Sarathy.

## How to Use

Simply say hello and I'll respond! You can also specify a name.

## What This Skill Does

When you invoke the `/hello` command:
1. If you provide a name, I'll greet you by name
2. If you don't provide a name, I'll give a friendly generic greeting

## Example

User: `/hello`
Assistant: "Hello there! 👋"

User: `/hello Viswa`
Assistant: "Hello Viswa! 👋 How can I help you today?"

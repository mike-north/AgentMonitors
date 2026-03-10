---
title: Getting Started
description: Set up your first Agent Monitor in minutes
---

# Getting Started

## Installation

Install the Agent Monitors CLI globally:

```bash
npm install -g @agentmonitors/cli
```

Or use it via npx:

```bash
npx @agentmonitors/cli --help
```

## Your First Monitor

Create a monitor directory structure:

```
.claude/monitors/
  my-first-monitor/
    MONITOR.md
```

Write a `MONITOR.md` file with YAML frontmatter and handling instructions:

```yaml
---
name: Config file watcher
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs:
    - '*.config.js'
    - '*.config.ts'
    - 'tsconfig.json'
---
When config files change, review the changes and update any dependent
configuration or documentation that may be affected.
```

## Validate Your Monitor

```bash
agentmonitors validate .claude/monitors
```

## Test the Observation Source

```bash
agentmonitors monitor test .claude/monitors/my-first-monitor/MONITOR.md
```

## View Your Inbox

```bash
agentmonitors inbox list
```

## Next Steps

- Read about [core concepts](/docs/concepts) to understand the architecture
- Learn how to [author monitors](/docs/authoring-monitors) for different use cases

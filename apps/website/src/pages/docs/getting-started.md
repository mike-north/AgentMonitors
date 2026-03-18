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

Scaffold a new monitor using the `init` command:

```bash
agentmonitors init my-first-monitor
```

This creates `.claude/monitors/my-first-monitor/MONITOR.md` with a starter template. Edit it to configure your monitor:

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

Or create the directory structure manually:

```
.claude/monitors/
  my-first-monitor/
    MONITOR.md
```

## Validate Your Monitor

```bash
agentmonitors validate .claude/monitors
```

## Test the Observation Source

```bash
agentmonitors monitor test .claude/monitors/my-first-monitor/MONITOR.md
```

> **Note:** The `file-fingerprint` and `api-poll` sources use a baseline-then-detect pattern. The first run establishes a baseline of current state. The `monitor test` command runs a second observation automatically to verify the source can read your files. In production, the agent process keeps running between observations, so changes are detected across polls.

## Scan Your Monitors

Get an overview of all monitors in a directory:

```bash
agentmonitors scan .claude/monitors
```

## View Your Inbox

```bash
agentmonitors inbox list
```

## Manage Inbox Items

Walk items through the lifecycle using inbox subcommands:

```bash
# Acknowledge an item (you've seen it)
agentmonitors inbox ack <id>

# Mark as in-progress (you're working on it)
agentmonitors inbox start <id>

# Mark as completed or failed
agentmonitors inbox complete <id>
agentmonitors inbox fail <id> --error "reason for failure"

# Archive when done
agentmonitors inbox archive <id>
```

The state machine enforces valid transitions: `queued → acked → in-progress → completed|failed → archived`. Invalid transitions produce a clear error message.

## Filter Inbox Items

Use `inbox list` with filters and date ranges:

```bash
# Filter by state, urgency, tags, or date range
agentmonitors inbox list --state in-progress --urgency high
agentmonitors inbox list --since 2024-01-01 --until 2024-02-01
agentmonitors inbox list --tags github,review --format json
```

## View Installed Sources

```bash
agentmonitors source list
```

This shows all available observation sources with their required and optional scope fields.

## Generate JSON Schema

Generate a JSON Schema for editor autocompletion and validation:

```bash
agentmonitors schema generate
agentmonitors schema generate -o monitor-schema.json
```

## Next Steps

- Read about [core concepts](/docs/concepts) to understand the architecture
- Learn how to [author monitors](/docs/authoring-monitors) for different use cases

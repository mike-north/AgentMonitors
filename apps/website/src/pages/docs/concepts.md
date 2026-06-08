---
title: Core Concepts
description: Understanding the Agent Monitors architecture
---

# Core Concepts

## Monitors

A monitor is a declarative configuration that watches for external changes and produces durable inbox items for AI agents. Each monitor is a markdown file — either a flat `<id>.md` file or an `<id>/MONITOR.md` file inside its own folder:

```
.claude/monitors/
  github-pr-review.md      # flat form — id is the filename
  config-drift/
    MONITOR.md             # folder form — id is the folder name
```

The filename (flat form) or folder name (folder form) is the monitor's machine identifier. The file contains YAML frontmatter (policy) and a markdown body (handling instructions).

## Observation Sources

Observation sources are plugins that know how to detect changes. Three core sources ship with Agent Monitors:

| Source             | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `file-fingerprint` | Hash local files and detect changes via SHA-256  |
| `api-poll`         | Poll HTTP endpoints and detect response changes  |
| `schedule`         | Cron-based triggers for time-driven observations |

Sources implement the `ObservationSource` interface and are distributed as npm packages with the `agentmonitor:observation-source` keyword.

### Baseline-then-detect pattern

The `file-fingerprint` and `api-poll` sources use a **baseline-then-detect** pattern. The first observation establishes a baseline (current file hashes or API response). Subsequent observations compare against the baseline to detect changes. This means a single observation in isolation cannot detect changes — the system needs to see "before" and "after" states.

The `schedule` source is stateless — it simply checks if the current time matches the cron expression and produces an observation immediately.

## Urgency

Urgency drives delivery behavior:

- **`high`** — Inline context injection via hook (interrupt the agent immediately)
- **`normal`** — Hook tells the agent "you have inbox items, add a todo to check"
- **`low`** — Surfaced at idle, without interrupting in-progress work

## Inbox

The inbox is a SQLite database that provides durable storage for observations. Items follow a state machine:

```
queued → acked → in-progress → completed → archived
                             → failed    → archived
```

The inbox persists across agent restarts, so no observations are lost.

## Notification Strategies

The `notify` block in a monitor controls when observations become inbox items:

| Strategy   | Behavior                                    | Good for                                  |
| ---------- | ------------------------------------------- | ----------------------------------------- |
| (default)  | Every signal fires immediately              | Rare, high-value events                   |
| `debounce` | Wait for signals to stop, then fire         | Rapid-fire mutations (file saves)         |
| `throttle` | Fire on first signal, suppress for cooldown | "Tell me right away, then leave me alone" |

## Scoping

Monitors inherit their activation scope from the hook hierarchy:

- **Enterprise-level** — Always active org-wide (managed config)
- **User-level** (`~/.claude/monitors/`) — Always active on the user's machine
- **Project-level** (`.claude/monitors/`) — Active only in that project

## Hook Bridge

The hook bridge writes inbox state to a JSON file that AI coding tool hooks can read. This enables real-time integration — when the inbox changes, the hook can inject context or create todos for the agent.

---
title: Core Concepts
description: The core concepts behind Agent Monitors — monitors, sources, urgency, and the delivery pipeline.
---

# Core Concepts

## Monitors

A monitor is a declarative configuration that watches for external changes and delivers
durable signals to AI agents. Each monitor is a `MONITOR.md` file — either a flat
`<id>.md` or an `<id>/MONITOR.md` inside its own folder:

```
.claude/monitors/
  github-pr-review.md      # flat form — id is the filename without .md
  config-drift/
    MONITOR.md             # folder form — id is the folder name
```

The **identity is the name** (filename without `.md`, or folder name) — a stable machine
identifier, not a frontmatter field.

## The `watch:` block

Every monitor has a `watch:` block that declares what to observe. The `type` field is an
explicit discriminated union tag:

```yaml
watch:
  type: file-fingerprint   # explicit type tag — never inferred from key shape
  globs:
    - 'src/**/*.ts'
```

Current bundled source types:

| Type | Observes |
|---|---|
| `file-fingerprint` | Local file changes via SHA-256 hashing |
| `api-poll` | HTTP endpoint response changes |
| `schedule` | Cron-based time triggers |
| `incoming-changes` | Files changed by an incoming `git pull` |

## Urgency

`urgency` controls how urgently the runtime surfaces the signal:

| Value | Delivery |
|---|---|
| `high` | Interrupt the agent at the earliest interruptible point (15 s debounce) |
| `normal` | Surface at turn-idle — after the current agent turn completes |
| `low` | Surface at idle or post-compact — lowest priority |

## The delivery pipeline

```
MONITOR.md  ──parse──▶  runtime tick  ──observe()──▶  source plugin
                              │                              │
                       notify dispatch  ◀──observations──────┘
                       (debounce/throttle)
                              │
                       durable monitor_events  ──project──▶  sessions  ──▶  hook
```

1. **Parse** — `MONITOR.md` is read and validated; frontmatter configures the source.
2. **Observe** — the source plugin runs and returns observations (what changed and how).
3. **Notify dispatch** — the runtime applies debounce/throttle policy.
4. **Persist** — observations become durable `monitor_events` rows in SQLite.
5. **Project** — events are projected into matching active agent sessions.
6. **Deliver** — the host adapter surfaces pending events at the right lifecycle point.

## Scoping

Monitors are discovered by the runtime in standard locations:

| Scope | Location | When active |
|---|---|---|
| User | `~/.claude/monitors/` | Always, on this machine |
| Project | `.claude/monitors/` | When working in that project |

## The facts/judgments split

**Frontmatter states facts; the body states judgments.** The monitor observes and delivers
mechanical facts (declared in frontmatter); all semantic judgment is authored in the body
and executed by the agent. The runtime carries the body through verbatim — it never acts on
it. This structural split makes monitors deterministic, testable, and portable.

## Learn more

- [Authoring monitors](/docs/authoring-monitors) — the complete frontmatter reference
- [Use cases](/docs/use-cases) — patterns from simple to advanced
- [The Monitor Standard](/docs/monitor-standard) — the open format specification

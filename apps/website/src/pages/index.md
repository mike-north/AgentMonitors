---
title: Agent Monitors — Peripheral Vision for Your Coding Agent
description: >-
  Agent Monitors turns external changes into durable, actionable signals
  delivered into your AI coding sessions at the right moment.
---

# Agent Monitors

**Peripheral vision for your coding agent.**

A coding agent is blind to everything happening outside its own session while it works.
Agent Monitors is its peripheral vision: it watches the world and hands the agent a
well-timed, actionable signal at the moment it can act — durably, declaratively, and
across hosts.

## What it solves

The valuable signals an agent cannot see from inside a session:

- An upstream API or spec changed while you were heads-down
- A new PR review comment, release, or vulnerability landed in something you depend on
- A long-running job finished, or a teammate's commit made your assumptions stale

Today, wiring any of these into an agent means hand-building the whole chain: write a
polling loop, maintain a "before" snapshot, diff it, assemble a message, time its delivery,
make it actionable. **A monitor deletes that chain.** You declare the intent; the runtime
handles the loop, the before-state, the diff, the message, the timing, and the framing.

## How it works

You author a **monitor** as a folder-scoped `MONITOR.md` file. Frontmatter declares the
policy (what to watch, urgency, delivery timing); the Markdown body is the handling
instruction the agent receives. A local daemon polls each monitor's source, detects change,
and materialises durable **events** that are projected into your agent sessions and surfaced
through host hooks at appropriate lifecycle points.

```
MONITOR.md  ──parse──▶  runtime tick  ──observe()──▶  source plugin
                              │                              │
                       notify dispatch  ◀──observations──────┘
                       (debounce/throttle)
                              │
                       durable monitor_events  ──project──▶  sessions  ──▶  host hook
```

The minimal complete monitor — five lines:

```yaml
---
watch:
  type: incoming-changes
  paths: 'docs/specs/**'
---
The specs changed. Summarize what changed and whether it affects what I am working on.
```

No polling loop. No snapshot logic. No message assembly. Just intent.

## Three observation sources ship in the box

| Source | Watches |
|---|---|
| `file-fingerprint` | Local file changes (SHA-256 hashing over globs) |
| `api-poll` | HTTP endpoint responses (text-diff / json-diff / status-code) |
| `schedule` | Cron-based triggers |
| `incoming-changes` | Files changed by an incoming `git pull` — with commit provenance |

## Get started

- [Getting started guide](/docs/getting-started) — install, author a first monitor, run it, see a signal
- [Authoring monitors](/docs/authoring-monitors) — the full `watch:` model, all sources, urgency, notify
- [Use cases & journeys](/docs/use-cases) — real patterns, from trivial to fleet supervision
- [The Monitor Standard](/docs/monitor-standard) — the open, host-agnostic format spec

---

Claude Code is the first supported host. The runtime core is **host-agnostic by design** —
the same `MONITOR.md` file works on any conformant runtime.

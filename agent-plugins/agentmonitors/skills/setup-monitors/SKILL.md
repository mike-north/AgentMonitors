---
name: setup-monitors
description: Enable AgentMon monitoring for this project — create the gitignored activation file, scaffold a MONITOR.md, and verify the daemon picks it up. Use when the user asks to "set up agent monitors", "enable monitoring in this repo", "watch files/an API/a schedule and tell me when it changes", or "turn on agentmonitors here".
---

# Set up AgentMon monitoring for a project

This plugin installs the lifecycle hooks and the channel MCP once. After that, monitoring
for a given project is turned on by **two pieces of project-local state**:

1. A gitignored activation file (`.claude/agentmonitors.local.md`) with `enabled: true`.
2. One or more monitor definitions under `.claude/monitors/`.

Without step 1, the `SessionStart` hook's `agentmonitors session start` quick-exits and **nothing
runs** — no daemon boots, no monitors tick. Walk the user through both.

## Prerequisites

The `agentmonitors` CLI must be on `PATH`. If `agentmonitors --help` fails, install it globally:

```bash
npm i -g @agentmonitors/cli
```

## Step 1 — Enable monitoring (the activation file)

Create `.claude/agentmonitors.local.md` with `enabled: true` in its frontmatter:

```markdown
---
enabled: true
---

> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).
```

This file is per-developer, local, and **must be gitignored** — `agentmonitors session start`
rewrites it at runtime to record the resolved daemon socket/db paths. The repo's `.gitignore`
should already ignore it via `.claude/*.local.*`; if not, add that line (see Step 3).

The change takes effect on the next session: the `SessionStart` hook lazy-boots a per-workspace
daemon and registers the session; `SessionEnd` deregisters it so the idle daemon reaps itself.

## Step 2 — Add a monitor

Scaffold a monitor with the CLI (creates `.claude/monitors/<name>/MONITOR.md`):

```bash
agentmonitors init my-monitor --type file-fingerprint
```

`--type` accepts `file-fingerprint` (default), `api-poll`, `schedule`, or `incoming-changes`.
A file-fingerprint monitor looks like this — note the `watch: { type }` frontmatter shape:

```markdown
---
name: My monitor
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
urgency: normal
---

When changes are detected, review and take appropriate action.
```

You can also drop a flat `.claude/monitors/<id>.md` instead of a `<id>/MONITOR.md` directory;
the monitor ID is the directory (or file) name. Edit the frontmatter for your case, then validate:

```bash
agentmonitors validate .claude/monitors
```

`urgency` is one of `low` / `normal` / `high`. `high` settles on a short debounce (~15s) before
delivering — it is not instant.

## Step 3 — Gitignore the right things

Add these to `.gitignore` (the activation entry is required; the monitors entry is optional):

```gitignore
# AgentMon local coordination state (per-developer; never commit)
.claude/*.local.*

# Optional: keep monitor definitions out of version control
.claude/monitors/*
```

Commit monitor files only if you want them shared across the team. The `.local.*` activation file
is always per-developer and must stay ignored.

## Verify

Open a new session (or run a tick by hand) and confirm the daemon is up:

```bash
agentmonitors session list      # should show this session once enabled
agentmonitors daemon once .claude/monitors --workspace "$PWD"   # single in-process tick
```

If `session list` is empty, re-check that `.claude/agentmonitors.local.md` exists and has
`enabled: true` — that is the most common reason monitoring appears to do nothing.

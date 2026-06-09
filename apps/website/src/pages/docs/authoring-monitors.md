---
title: Authoring Monitors
description: The complete guide to writing MONITOR.md files — the watch model, all bundled sources, urgency, and notify strategies.
---

# Authoring Monitors

## The monitor file

A monitor lives in one of two forms:

```
.claude/monitors/<monitor-id>.md          # flat form — id = filename without .md
.claude/monitors/<monitor-id>/MONITOR.md  # folder form — id = folder name
```

Both forms are equivalent. The folder form (what `agentmonitors init` scaffolds) lets you
keep related assets alongside the monitor. Either way, the **identity is the name** —
a stable machine identifier, not a frontmatter field.

## Frontmatter structure

```yaml
---
name: Human-readable display name  # optional; identity comes from the directory/filename
watch:                              # required — what to observe
  type: <source-type>              # discriminated union tag — always explicit
  # ... source-specific config ...
urgency: normal                     # optional: high | normal | low (default: normal)
notify:                             # optional — delivery timing
  strategy: debounce
  settle-for: 5m
---
```

The minimal valid monitor is a `watch:` block plus a body — every other field is optional
with a sensible default.

## The body: handling instructions

The Markdown body after the frontmatter is delivered verbatim to the agent when the monitor
fires. Write it as a prompt fragment that tells the agent what to do with the signal:

```markdown
---
watch:
  type: file-fingerprint
  globs: ['tsconfig.json', 'package.json']
---

Config files changed. Check whether the change affects build output or
dependencies. Run `pnpm check` to verify type checking still passes. If
package.json dependencies changed, run `pnpm install`.
```

The runtime carries the body through unchanged — it never acts on it. All judgment is
yours, executed by the agent.

## Bundled observation sources

### `file-fingerprint`

Watches local files for content changes using SHA-256 hashing over globs.

```yaml
watch:
  type: file-fingerprint
  globs:
    - 'src/**/*.ts'
    - '*.config.js'
  cwd: /path/to/project   # optional — defaults to the monitors root
```

Uses a **baseline-then-detect** pattern: the first observation establishes the baseline;
subsequent observations diff against it. A single isolated run cannot detect change.

### `api-poll`

Polls an HTTP endpoint and detects response changes.

```yaml
watch:
  type: api-poll
  url: 'https://api.example.com/status'
  method: GET                  # optional — defaults to GET
  interval: 5m                 # optional — polling interval (e.g. 5m, 30s, 1h)
  change-detection:            # optional
    strategy: json-diff        # text-diff (default) | json-diff | status-code
  auth:                        # optional
    type: bearer
    token-env: API_TOKEN       # reads from environment variable
  headers:                     # optional
    Accept: application/json
```

**Change detection strategies:**

| Strategy | Behaviour |
|---|---|
| `text-diff` | Compares raw response body text (default) |
| `json-diff` | Parses JSON and compares semantically (ignores key order and whitespace) |
| `status-code` | Only detects changes in HTTP status code |

**Auth types:**

- **Bearer token:** `type: bearer` with `token` (inline) or `token-env` (env var name)
- **Basic auth:** `type: basic` with `username` and `password` fields

### `schedule`

Fires on a cron schedule — no change-detection, purely time-driven.

```yaml
watch:
  type: schedule
  cron: '0 9 * * 1-5'          # weekdays at 9 AM
  timezone: America/New_York    # optional — defaults to UTC
  label: Daily standup reminder # optional — custom display title
```

### `incoming-changes`

Fires when a `git pull` or merge advances the commit graph and touches the specified paths.
Unlike `file-fingerprint`, this keys off **commit provenance** — you know the change came
from someone else's push, not your own edit.

```yaml
watch:
  type: incoming-changes
  paths:
    - 'docs/specs/**'
  branch: main                  # optional — defaults to current branch
```

## Urgency

`urgency` controls how the runtime surfaces the signal to the agent:

| Value | Delivery behaviour |
|---|---|
| `high` | Interrupt the agent at the earliest interruptible point (15 s debounce settle) |
| `normal` | Surface at turn-idle — the agent sees it after its current turn completes |
| `low` | Surface at idle or post-compact — lowest priority |

```yaml
urgency: high   # or normal, or low
```

## Notify strategies

The `notify:` block controls delivery timing. Omit it for immediate delivery.

### Debounce

Wait for a quiet period before notifying. Good for rapid-fire events like file saves:

```yaml
notify:
  strategy: debounce
  settle-for: 5m    # wait 5 minutes of quiet before notifying
```

### Throttle

Notify immediately on first event, then suppress for a cooldown:

```yaml
notify:
  strategy: throttle
  suppress-for: 30m   # notify once, then ignore for 30 minutes
```

## Progressive disclosure

The design rule: simple stays simple, power reveals on friction. Start with just `watch:`
and a body. Add `when:` (fire less often), `deliver:` (say more), or `until:` (reliable
reaction) only when a specific friction motivates them — never up front.

See the [use cases](/docs/use-cases) page for real patterns across this spectrum.

## Validate

```bash
agentmonitors validate .claude/monitors
```

## Generate a JSON Schema for editor autocompletion

```bash
agentmonitors schema generate -o monitor-schema.json
```

Point your editor at the generated file to get inline validation and autocomplete while
authoring monitors.

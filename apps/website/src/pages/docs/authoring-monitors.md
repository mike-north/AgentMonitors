---
title: Authoring Monitors
description: How to write effective monitor definitions
---

# Authoring Monitors

## File Structure

Each monitor lives in its own folder with a `MONITOR.md` file:

```
.claude/monitors/<monitor-id>/MONITOR.md
```

The folder name becomes the monitor's machine identifier. Choose a descriptive kebab-case name.

## Frontmatter Reference

```yaml
---
name: GitHub PR review monitor # required, human-readable display name
source: api-poll # required, observation source plugin
urgency: normal # required: high | normal
event-kind: notification # required: mutation | notification | alert
scope: # required, source-specific configuration
  url: 'https://api.github.com/...'
  auth:
    type: bearer
    token-env: GITHUB_TOKEN
notify: # optional, defaults to immediate
  strategy: debounce
  settle-for: 5m
tags: [github, review] # optional, for filtering
---
```

## The Body: Handling Instructions

The markdown body after the frontmatter is injected into the agent's context when the monitor fires. Write it as a prompt fragment that tells the agent what to do:

```markdown
---
name: Config drift detector
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs: ['tsconfig.json', 'package.json']
---

When configuration files change:

1. Check if the change affects build output or dependencies
2. Run `pnpm check` to verify type checking still passes
3. If package.json dependencies changed, run `pnpm install`
4. Update any documentation that references the changed configuration
```

## Source-Specific Configuration

### file-fingerprint

Watches local files for content changes using SHA-256 hashing.

```yaml
scope:
  globs:
    - 'src/**/*.ts'
    - '*.config.js'
  cwd: /path/to/project # optional, defaults to current directory
```

### api-poll

Polls an HTTP endpoint and detects response changes.

```yaml
scope:
  url: 'https://api.example.com/status'
  method: GET # optional, defaults to GET
  auth: # optional
    type: bearer
    token-env: API_TOKEN # reads from environment variable
  headers: # optional
    Accept: application/json
```

### schedule

Fires on a cron schedule.

```yaml
scope:
  cron: '0 9 * * 1-5' # weekdays at 9am
  timezone: America/New_York # optional, defaults to UTC
  label: Daily standup reminder # optional, custom title
```

## Notification Strategies

### Debounce

Wait for a quiet period before notifying. Good for rapid-fire events like file saves:

```yaml
notify:
  strategy: debounce
  settle-for: 5m # wait 5 minutes of quiet before notifying
```

### Throttle

Notify immediately on first event, then suppress for a cooldown period:

```yaml
notify:
  strategy: throttle
  suppress-for: 30m # notify once, then ignore for 30 minutes
```

## CLI Commands

Validate your monitors:

```bash
agentmonitors validate .claude/monitors
```

Dry-run a monitor's observation source:

```bash
agentmonitors monitor test .claude/monitors/my-monitor/MONITOR.md
```

Generate a JSON Schema for editor support:

```bash
agentmonitors schema generate -o monitor-schema.json
```

---
title: Getting Started
description: Install Agent Monitors, author your first monitor, and see a signal in minutes.
---

# Getting Started

## Install

Install the CLI globally from npm:

```bash
npm install -g @agentmonitors/cli
```

Or use it without a global install:

```bash
npx @agentmonitors/cli --help
```

### From source (development)

```bash
git clone https://github.com/mike-north/AgentMonitors.git
cd AgentMonitors
pnpm install
pnpm build
alias agentmonitors="node \"$(pwd)/apps/cli/dist/index.cjs\""
```

## Scaffold your first monitor

The `init` command creates a ready-to-edit `MONITOR.md` in your project's monitors folder:

```bash
agentmonitors init my-first-monitor
```

This creates `.claude/monitors/my-first-monitor/MONITOR.md`. By default it scaffolds a
`file-fingerprint` monitor:

```yaml
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

You can scaffold other source types with `--type`:

```bash
agentmonitors init api-watcher --type api-poll
agentmonitors init daily-standup --type schedule
agentmonitors init spec-watcher --type incoming-changes
```

## Edit the monitor body

The markdown body after the frontmatter is the handling instruction the agent receives when
the monitor fires. Write it as a prompt fragment:

```yaml
---
name: Config file watcher
watch:
  type: file-fingerprint
  globs:
    - '*.config.ts'
    - 'tsconfig.json'
urgency: normal
---
Config files changed. Review the diff, check whether the change affects
build output or dependencies, and update any documentation that references
the changed configuration.
```

## Validate

Check that your monitor parses correctly and its source configuration is valid:

```bash
agentmonitors validate .claude/monitors
```

## Test the observation source

Dry-run the source against your filesystem to confirm it can observe:

```bash
agentmonitors monitor test .claude/monitors/my-first-monitor/MONITOR.md
```

> **Note:** `file-fingerprint` and `api-poll` use a baseline-then-detect pattern. The first
> run establishes the baseline; `monitor test` runs a second observation automatically so
> you can see the change-detection in action.

## Scan all monitors

Get an overview of every monitor under a root — useful to verify discovery:

```bash
agentmonitors scan .claude/monitors
```

## Start the daemon

The daemon ticks on an interval, observes each source, and materialises durable events:

```bash
agentmonitors daemon run
```

For a single tick (useful in CI or scripts):

```bash
agentmonitors daemon once
```

## See events

After the daemon has run at least one tick:

```bash
agentmonitors events list
```

## Next steps

- [Authoring monitors](/docs/authoring-monitors) — all sources, urgency levels, notify strategies
- [Use cases](/docs/use-cases) — patterns from simple file-watching to fleet supervision

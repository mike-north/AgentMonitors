# Agent Monitors

**Local-first monitoring for agentic coding tools.** Agent Monitors turns external changes — file
edits, API responses, scheduled triggers — into durable, queryable work signals and delivers them
into your AI coding sessions at the right moments, so important observations aren't lost to a single
prompt or a forgotten hook.

Claude Code is the first supported host, but the runtime core is host-agnostic by design.

## How it works

You author a **monitor** as a folder-scoped `MONITOR.md` file: frontmatter declares the policy
(which **source** to watch, urgency, delivery timing), and the Markdown body is the handling
instruction the receiving agent sees. A long-running local daemon polls each monitor's source,
detects change, and materializes durable **events**. Events are projected into tracked agent
sessions and surfaced through host hooks at appropriate lifecycle points (interruptible, idle, or
after compaction) — with urgency-aware debounce/throttle so you get signal, not noise.

```text
MONITOR.md  ──parse──▶  runtime tick  ──observe()──▶  source plugin
                              │                              │
                       notify dispatch  ◀──observations──────┘
                       (debounce/throttle)
                              │
                       durable monitor_events  ──project──▶  agent sessions  ──▶  host hook
```

Three observation sources ship in the box:

- **`file-fingerprint`** — SHA-256 change detection over file globs
- **`api-poll`** — HTTP polling with `text-diff` / `json-diff` / `status-code` change detection
- **`schedule`** — cron-based triggers

## Quick start

The `agentmonitors` CLI ships from this monorepo (`@mike-north/cli`). It is not yet published to a
package registry, so build it from source:

```bash
pnpm install
pnpm build
```

The CLI binary is then `apps/cli/dist/index.cjs`; alias it for convenience:

```bash
alias agentmonitors="node \"$(pwd)/apps/cli/dist/index.cjs\""
```

Scaffold and run your first monitor:

```bash
# Create .claude/monitors/my-first-monitor/MONITOR.md from a template
agentmonitors init my-first-monitor

# Check it parses and its source/scope are valid
agentmonitors validate .claude/monitors

# See all monitors discovered under a root (plus any parse failures)
agentmonitors scan .claude/monitors

# Dry-run the observation source against your files
agentmonitors monitor test .claude/monitors/my-first-monitor/MONITOR.md
```

A monitor looks like this:

```yaml
---
name: Config file watcher
source: file-fingerprint
urgency: normal
scope:
  globs:
    - '*.config.ts'
    - 'tsconfig.json'
---
When config files change, review the changes and update any dependent
configuration or documentation that may be affected.
```

The monitor's **ID is its parent directory name** (`my-first-monitor`), not a frontmatter field.
Run `agentmonitors --help` for the full command surface, or see the
[CLI reference](docs/specs/005-cli-reference.md).

## Documentation

The **canonical specification** lives in [`docs/specs/`](docs/specs/) — start with the
[spec README](docs/specs/README.md). It is the source of truth for intended behavior and is explicit
about which behaviors are _current_ vs _target_:

| Doc                                                                         | Covers                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------- |
| [000 — Principles & Properties](docs/specs/000-principles.md)               | The invariants everything else builds on           |
| [001 — Monitor Definition](docs/specs/001-monitor-definition.md)            | `MONITOR.md` layout & frontmatter schema           |
| [002 — Runtime, Delivery & Persistence](docs/specs/002-runtime-delivery.md) | Tick loop, delivery, daemon/IPC, adapters, storage |
| [003 — Source Plugins](docs/specs/003-source-plugins.md)                    | The source contract & bundled sources              |
| [004 — Validation & Testing](docs/specs/004-validation-testing.md)          | Validation surfaces & required test scenarios      |
| [005 — CLI Reference](docs/specs/005-cli-reference.md)                      | Every `agentmonitors` command                      |
| [glossary](docs/specs/glossary.md) · [roadmap](docs/specs/roadmap.md)       | Terminology · current→target gaps                  |

## Repository layout

A pnpm + Nx monorepo:

| Package                           | Name                                  | Purpose                                                                               |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `libs/core`                       | `@mike-north/core`                    | Host-agnostic engine: parser, schema, source registry, runtime, persistence, adapters |
| `apps/cli`                        | `@mike-north/cli` (`agentmonitors`)   | Command surface + the daemon and its Unix-socket IPC                                  |
| `plugins/source-file-fingerprint` | `@mike-north/source-file-fingerprint` | File change-detection source                                                          |
| `plugins/source-api-poll`         | `@mike-north/source-api-poll`         | HTTP polling source                                                                   |
| `plugins/source-schedule`         | `@mike-north/source-schedule`         | Cron schedule source                                                                  |
| `apps/website`                    | —                                     | Public docs site                                                                      |

## Development

Requires Node and `pnpm` (10.30.3 — see `packageManager`).

```bash
pnpm install
pnpm build      # build all publishable packages (Nx, with caching + dependency ordering)
pnpm test       # run all package suites (vitest)
pnpm check      # type-check every package + eslint + prettier
```

Work on a single package or test:

```bash
pnpm nx test @mike-north/core
pnpm --filter @mike-north/core exec vitest run src/runtime/service.test.ts
```

Changes that affect a published package's behavior or public types should include a
[Changeset](https://github.com/changesets/changesets) (`pnpm changeset`). Contributor guidance for
working in this repo lives in [CLAUDE.md](CLAUDE.md).

## License

UNLICENSED. © Mike North.

# AGENTS.md

Guidance for AI coding agents (Codex and any agent that reads `AGENTS.md`) working in this
repository. Claude Code users: see [CLAUDE.md](CLAUDE.md), which covers the same ground in more
depth.

## Project

Agent Monitors is a **local-first monitoring system for agentic coding tools**: a local daemon turns
external changes (file edits, API responses, schedules) into durable, queryable work signals and
delivers them into tracked agent sessions. A pnpm + Nx monorepo: `libs/core` (`@agentmonitors/core`,
the host-agnostic engine), `apps/cli` (`@agentmonitors/cli`, bin `agentmonitors`, + the daemon/IPC
layer), and `plugins/source-*` (the three bundled observation sources).

## Specifications — consult, don't eagerly read

This project has a **canonical, code-verified specification set in [`docs/specs/`](docs/specs/)**
(index: [`docs/specs/README.md`](docs/specs/README.md)). It is the source of truth for _intended_
behavior and marks each rule as _current_ vs _target_.

**Read the one doc that matches your task — you do not need to read the set for unrelated changes.**
Use this map to decide relevance:

- [`001-monitor-definition.md`](docs/specs/001-monitor-definition.md) — `MONITOR.md` files,
  frontmatter schema, monitor identity
- [`002-runtime-delivery.md`](docs/specs/002-runtime-delivery.md) — runtime tick & scheduling, notify
  dispatch, event persistence, session projection, hook delivery, daemon/IPC, host adapters
- [`003-source-plugins.md`](docs/specs/003-source-plugins.md) — the source-plugin contract and the
  bundled sources
- [`004-validation-testing.md`](docs/specs/004-validation-testing.md) — validation surfaces and
  required test scenarios
- [`005-cli-reference.md`](docs/specs/005-cli-reference.md) — the `agentmonitors` command surface
- [`006-agent-integration.md`](docs/specs/006-agent-integration.md) — how deliveries reach an agent:
  the adapter/transport seam, hook-state transport, the Claude Code channel transport (target)
- [`000-principles.md`](docs/specs/000-principles.md) — the invariants (PP/SP/AP/BP/NP) the rest cite
- [`roadmap.md`](docs/specs/roadmap.md) — known current→target gaps ·
  [`glossary.md`](docs/specs/glossary.md) — terminology

When you change behavior, update the matching numbered doc and add a
[`spec-changelog.md`](docs/specs/spec-changelog.md) entry (process in
[`004`](docs/specs/004-validation-testing.md) §5–6).

## Commands

```bash
pnpm build      # build publishable packages (Nx; build deps first)
pnpm test       # run all suites (vitest)
pnpm check      # type-check every package + eslint + prettier
pnpm nx test @agentmonitors/core                                            # one package
pnpm --filter @agentmonitors/core exec vitest run src/runtime/service.test.ts   # one test file
```

Note: changing `@agentmonitors/core`'s **public** API requires regenerating its api-extractor report
(`pnpm --filter @agentmonitors/core run check:api-report` with `--local`) or CI fails.

## Invariants to respect

- Keep the **core host-agnostic**: Claude-specific hook names/behavior live in adapters
  (`libs/core/src/adapter/`), never in the runtime core.
- **Source vs runtime split**: sources own _how_ to observe and their change-detection state; the
  runtime owns _when_ to run, notify timing, persistence, projection, and delivery.
- **Session isolation + durability**: per-session state must survive daemon restarts; events project
  into _lead_ sessions only. _Unread_, _claimed_, and _acknowledged_ are distinct states.
- `low` / `normal` / `high` urgency are all first-class. Prefer Zod at IPC/process boundaries.
- Changes to published behavior or public types should include a Changeset.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agent Monitors is a **local-first monitoring system for agentic coding tools**: a long-running
local daemon turns external changes into durable, queryable work signals and delivers them into
tracked agent sessions at appropriate lifecycle points. Claude Code is the first host adapter, but
the core is host-agnostic.

**The canonical contract lives in [`docs/specs/`](docs/specs/)** (index:
[`docs/specs/README.md`](docs/specs/README.md)) — the source of truth for _intended_ behavior, with
each rule marked _current_ vs _target_. **Consult the doc that matches your task; you don't need to
read the set for unrelated changes.** Relevance map:
[`001`](docs/specs/001-monitor-definition.md) `MONITOR.md` files & frontmatter schema ·
[`002`](docs/specs/002-runtime-delivery.md) runtime tick, scheduling, notify, delivery, persistence,
daemon/IPC, adapters · [`003`](docs/specs/003-source-plugins.md) source-plugin contract & bundled
sources · [`004`](docs/specs/004-validation-testing.md) validation & required test scenarios ·
[`005`](docs/specs/005-cli-reference.md) `agentmonitors` CLI ·
[`006`](docs/specs/006-agent-integration.md) delivery transports (hooks, channels) & agent
integration · [`000`](docs/specs/000-principles.md)
the invariants the rest cite · [`roadmap`](docs/specs/roadmap.md) current→target gaps ·
[`glossary`](docs/specs/glossary.md) terminology. When you change behavior, update the matching doc
and add a [`spec-changelog.md`](docs/specs/spec-changelog.md) entry
(process: [`004`](docs/specs/004-validation-testing.md) §5–6).

## Commands

pnpm + Nx monorepo (version pinned via package.json#packageManager). All targets run through Nx with caching and dependency ordering.

```bash
pnpm build          # build all publishable packages (excludes workspace root + website)
pnpm test           # run all package test suites (vitest), build deps first
pnpm check          # check:packages (tsc --noEmit per package) + check:workspace (eslint + prettier)
pnpm check:api-report   # validate api-extractor rollups are current (run --local to update in dev)
pnpm fix:lint-ts    # eslint --fix
pnpm fix:format     # prettier --write
pnpm clean          # remove all dist/ dirs
```

Per-package / single-test:

```bash
pnpm nx test @agentmonitors/core          # one project's full suite
pnpm --filter @agentmonitors/core exec vitest run src/runtime/service.test.ts   # one file
pnpm --filter @agentmonitors/core exec vitest run -t "high urgency"             # one test by name
pnpm nx build @agentmonitors/core         # build a single project (and its deps)
```

The CLI binary is `agentmonitors` (from `@agentmonitors/cli`). Build, then run `node apps/cli/dist/index.cjs <cmd>`.

### Important build ordering

`@agentmonitors/core`'s build is **three sequential steps**: `tsup` (bundle) → `tsc -p tsconfig.build.json`
(emit `.d.ts`) → `api-extractor run` (roll up `dist/public.d.ts`, the file `package.json#types` points
at). If you change `@agentmonitors/core`'s **public** API surface, the api-extractor report must be
regenerated (`pnpm --filter @agentmonitors/core run check:api-report` with `--local`) or CI `check:api-report`
fails. Downstream packages (`apps/cli`, `plugins/*`) depend on `^build`, so build core first.

## Architecture

### Packages

- `libs/core` (`@agentmonitors/core`) — host-agnostic engine. Owns parsing, schema, the source
  registry, the runtime tick loop, persistence, notify policy, session projection, hook-state, and
  adapters. This is where nearly all behavior lives; it is the only published library with a curated
  public API (api-extractor rollup).
- `apps/cli` (`@agentmonitors/cli`, bin `agentmonitors`) — command surface + the daemon and its
  Unix-socket IPC layer. Thin wrapper over core (per AP6: CLI must not invent behavior the core
  doesn't define). See [`docs/specs/005-cli-reference.md`](docs/specs/005-cli-reference.md).
- `plugins/source-*` — the three bundled observation sources (`file-fingerprint`, `api-poll`,
  `schedule`), each a separately published package implementing the source contract.
- `apps/website` — public docs site (excluded from `build`/`check`; lags the specs).

### The core pipeline (read `libs/core/src/runtime/service.ts`)

`MONITOR.md` (folder-scoped, ID = parent dir name) → `parseMonitor` → runtime tick scans + resolves
the `source` against the `SourceRegistry` → `source.observe()` returns observations → **notify
dispatch** (debounce/throttle/immediate, runtime-owned timing) → materialized into durable
`monitor_events` rows → **projected** into matching _lead_ sessions via `session_event_state` →
hook-state refreshed → **adapter** surfaces pending work at a delivery lifecycle
(`turn-interruptible` / `turn-idle` / `post-compact`).

Key invariants this enforces (from `docs/specs/`, and the copilot rules):

- **Source vs runtime split**: sources own _how_ to observe and their own change-detection state
  (`nextState`); the runtime owns _when_ to run, notify timing, persistence, diffing, projection,
  and delivery. Don't move delivery logic into a source.
- **Host-agnostic core**: Claude-specific hook names / transcript behavior belong in
  `libs/core/src/adapter/claude.ts`, never in the runtime core. New hosts = new adapters.
- **Session isolation + durability**: per-session baselines, cursors, and unread state must survive
  daemon restarts and reboots; never share state across sessions unless explicitly modeling a
  projection. Events project into **lead** sessions only (subagent sessions are tracked, not
  auto-projected).
- **Three distinct delivery states**: _unread_, _claimed_, _acknowledged_ are not the same. Claiming
  a delivery never acknowledges it.
- **Urgency is first-class for all three** of `low` / `normal` / `high`, and is separate from recap
  and delivery format. `high` defaults to a 15s debounce settle, so it is _not_ instant.

### Two durable work models (do not conflate)

The repo persists **two** separate models in SQLite (better-sqlite3 + drizzle-orm):

1. **Runtime/session pipeline** — `monitor_events` + `session_event_state` (the authoritative
   monitor-delivery path).
2. **Legacy inbox** — `inbox_items` state machine (`queued → acked → in-progress →
completed|failed → archived`), exposed via `agentmonitors inbox …`. Still implemented and public,
   but **not** the authoritative path. See [`docs/specs/002-runtime-delivery.md`](docs/specs/002-runtime-delivery.md) §12.

### Daemon vs in-process (a common gotcha)

`daemon run` is the long-running process that ticks on an interval and serves a Unix socket;
`session` / `events` / `hook` commands round-trip through that socket. But `daemon once` (single
tick) and a couple of fallbacks run **in-process without the socket** — see
[`docs/specs/002-runtime-delivery.md`](docs/specs/002-runtime-delivery.md) §10.

## Conventions

- **TypeScript**: explicit named unions/interfaces for public contracts; Zod at IPC/process
  boundaries; avoid unsafe casts (document any that are unavoidable); prefer optional fields over
  `null` unless persistence/protocol requires `null`. Keep exported surfaces declaration-rollup
  friendly (api-extractor).
- **Tests**: vitest. Prefer integration coverage for daemon, CLI, and adapter behavior; some CLI
  tests are Docker-backed (`*.docker.test.ts`) and must stay deterministic. Prioritize tests for
  persistence/restart-safety, session isolation, diffing, and delivery timing.
- **Releases**: Changesets. Changes affecting published package behavior or public types should
  include a changeset. `scripts/check-no-major-changesets.mjs` blocks accidental major bumps; a
  standalone-consumer check (`pnpm test:standalone-consumer`, run in CI on every PR and pre-publish)
  validates the published packages work for external consumers. Its `plugins/source-*` coverage is
  validated against `PACKAGE_DIRS` in `scripts/publish-release-packages.mjs` (`pnpm test:scripts`
  proves the check fails loudly on drift), so a new bundled source can't ship silently untested.
  CI's `publish-dry-run` job (path-filtered to publishable package dirs, `scripts/`, and the release
  workflow) runs `pnpm publish:packages:dry-run` after a build to catch release-collateral defects —
  missing `CHANGELOG.md`, missing `publishConfig`, or a built entry point `npm pack` wouldn't include
  — on the PR that introduces them, not at release time.
- **Review priority** (per `.github/copilot-instructions.md`): durable-state bugs, session-isolation
  errors, and event loss during debounce/compaction/batching/restart come before style.

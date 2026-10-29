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

This project's **canonical specification is OpenSpec, in [`openspec/`](openspec/)**. It is the
source of truth for _intended_ behavior, written as requirements with testable scenarios:

- [`openspec/specs/<capability>/spec.md`](openspec/specs/) — **current** (implemented) behavior.
- [`openspec/changes/<change>/`](openspec/changes/) — **target** (not-yet-implemented) behavior:
  `proposal.md`, delta `specs/`, `tasks.md`, optional `design.md`. `openspec list` is the roadmap.

**Read the one capability that matches your task — you do not need to read the set for unrelated
changes** (`openspec list --specs`, `openspec show <capability> --type spec`). Relevance map:

- `principles` — the invariants (PP/SP/AP/BP/NP) the rest cite
- `monitor/definition`, `monitor/validation` — `MONITOR.md` files, frontmatter schema, identity,
  validation surfaces
- `pipeline/post-processing`, `runtime/*` — the post-processing pipeline, tick & scheduling,
  monitor state, notify dispatch, event materialization, local data permissions
- `delivery/*` — session projection, delivery lifecycles, host adapters, the transport seam, the
  hook and channel transports, transport health
- `daemon/ipc`, `persistence/schema`, `inbox/legacy-inbox`
- `sources/*` — the source-plugin contract and the bundled sources
- `cli/*` — the `agentmonitors` command surface
- `agent/ephemeral-monitors` — agent-declared, session-scoped monitors
- `reliability/process-hygiene` — containment, process lifecycle, cleanup
- `engineering/test-integrity` — test-suite obligations
- [`docs/specs/glossary.md`](docs/specs/glossary.md) — terminology

When you change behavior, do it through an OpenSpec change (the `openspec-propose`,
`openspec-apply-change`, and `openspec-archive-change` skills in `.agents/skills/`); archiving
promotes the delta specs into `openspec/specs/`. Per-artifact rules are in
[`openspec/config.yaml`](openspec/config.yaml), and `openspec validate --all --strict` must pass.
`docs/specs/` is non-normative: the `000`–`008` files are crosswalk stubs mapping the legacy `NNN §X.Y`
citations (changelogs, commits, issues, older code comments) to the capability or change that now owns each section.

## Commands

```bash
pnpm build      # build publishable packages (Nx; build deps first)
pnpm test       # run all suites (vitest)
pnpm check      # type-check every package + eslint + prettier
pnpm nx test @agentmonitors/core                                            # one package
pnpm --filter @agentmonitors/core exec vitest run src/runtime/service.test.ts   # one test file
```

Note: every published TypeScript package (`@agentmonitors/core`, `plugins/source-*`) has a checked-in
API report (`<package>/api-report/*.api.md`). Changing a package's **public** API requires
regenerating its report (`pnpm --filter <package> run fix:api-report`) and committing the diff, or CI's
`pnpm check:api-report` (no `--local`) fails.

## Invariants to respect

- Keep the **core host-agnostic**: Claude-specific hook names/behavior live in adapters
  (`libs/core/src/adapter/`), never in the runtime core.
- **Source vs runtime split**: sources own _how_ to observe and their change-detection state; the
  runtime owns _when_ to run, notify timing, persistence, projection, and delivery.
- **Session isolation + durability**: per-session state must survive daemon restarts; events project
  into _lead_ sessions only. _Unread_, _claimed_, and _acknowledged_ are distinct states.
- `low` / `normal` / `high` urgency are all first-class. Prefer Zod at IPC/process boundaries.
- Changes to published behavior or public types should include a Changeset.

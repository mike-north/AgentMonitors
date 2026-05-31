# AgentMonitors Copilot Instructions

## Project Purpose

AgentMonitors is a local-first monitoring system for agentic coding tools.

The product direction is:

- a long-running local daemon
- durable per-agent-session baselines, cursors, and unread state
- a shared monitor event log with session-scoped projections
- adapter-based host integration, with Claude Code first but not Claude-only

Review behavior and architecture before style.

## Specifications

This repository has a canonical, code-verified specification set in `docs/specs/` (index:
`docs/specs/README.md`). It is the source of truth for _intended_ behavior and marks each rule as
_current_ vs _target_.

Consult the single doc that matches the change under review — you do not need to read the set for
unrelated work. Relevance map:

- `docs/specs/001-monitor-definition.md` — `MONITOR.md` files, frontmatter schema, monitor identity
- `docs/specs/002-runtime-delivery.md` — runtime tick & scheduling, notify dispatch, persistence,
  session projection, hook delivery, daemon/IPC, host adapters
- `docs/specs/003-source-plugins.md` — the source-plugin contract and the bundled sources
- `docs/specs/004-validation-testing.md` — validation surfaces and required test scenarios
- `docs/specs/005-cli-reference.md` — the `agentmonitors` CLI
- `docs/specs/006-agent-integration.md` — delivery transports: adapter seam, hook-state transport,
  the Claude Code channel transport (target)
- `docs/specs/000-principles.md` — the invariants the rest cite; `docs/specs/roadmap.md` —
  current→target gaps

When a change alters behavior, expect the matching numbered doc to be updated and a
`docs/specs/spec-changelog.md` entry added.

## Architectural Rules

- Keep the runtime core host-agnostic. Host-specific hook names, task tools,
  and transcript behavior belong in adapters.
- Session identity is per agent session. Do not share baselines or unread state
  across sessions unless code is explicitly modeling a projection.
- Baselines, source checkpoints, and delivery state must survive daemon
  restarts and machine reboots.
- Source plugins provide observations, metadata, and textual snapshots. Core
  owns persistence, diffing, batching, debounce/throttle, session projections,
  and delivery policy.
- Preserve payload agnosticism. Favor raw payload retention plus lightweight
  summaries and textual snapshots over source-specific assumptions.
- Keep hook hot paths cheap. Avoid adding startup, transport, or database work
  to paths that can be answered from materialized state.

## Review Priorities

Look first for:

1. durable state bugs
2. session isolation errors
3. event loss during debounce, compaction, batching, or restart flows
4. incorrect urgency handling for `high`, `normal`, and `low`
5. leakage of Claude-specific behavior into host-agnostic core code

Flag changes that:

- reset baselines unexpectedly
- conflate urgency with recap or delivery format
- make lossless delivery harder to reason about
- weaken adapter boundaries

## TypeScript And API Expectations

- Prefer explicit named union types and interfaces for public contracts.
- Use Zod at IPC and process boundaries.
- Avoid unsafe casts. If one is unavoidable, document exactly why.
- Keep exported surfaces declaration-rollup friendly.
- Prefer optional fields over `null` unless persistence or protocol semantics
  require `null`.

## Testing And Release Expectations

- Add or update tests for persistence, restart safety, session isolation,
  diffing, and delivery timing.
- Prefer integration coverage for daemon, CLI, and adapter behavior.
- Keep Docker-backed tests deterministic and scoped to realistic user flows.
- Changes that affect published package behavior or public types should usually
  include a Changeset.

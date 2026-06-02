# Roadmap & Known Gaps

> **Status:** Supporting (non-normative)
> **Covers:** the current→target gaps between the spec set and the implementation, as
> prioritizable work items

This is a planning surface, not a contract. Each item states what is **current**, what is
**target**, the governing spec/property, the affected files, and a **proof** (the test or
check that demonstrates the item is done). Every gap below was confirmed against the code
while authoring the numbered specs; the governing doc carries the normative statement.

Priority is a suggestion (P1 = highest). Re-rank freely — that is the point of this doc.

## Behavioral gaps

> G1 (reject duplicate monitor IDs) shipped — now current behavior, see
> [001 §4](./001-monitor-definition.md) and [spec-changelog.md](./spec-changelog.md).

> G2 (full per-source JSON Schema validation in `validate`) shipped — now current
> behavior via the exported core `validateScope` helper (backed by `@cfworker/json-schema`).
> See [004 §2.2](./004-validation-testing.md) and [spec-changelog.md](./spec-changelog.md).
> This also closed test gap T3 (`validate` failure paths).

> G3 (`file-fingerprint` create/delete events) shipped — and was generalized into a first-class,
> source-agnostic `changeKind` (`created`/`modified`/`deleted`/`descoped`) on the core `Observation`
> contract, persisted into the event `queryScope` by the runtime. See
> [003 §2.3 / §3.3](./003-source-plugins.md), [002 §5.1](./002-runtime-delivery.md), and
> [spec-changelog.md](./spec-changelog.md).

### G4 — Third-party source discovery & installation (P3)

- **Current:** `source search|install|update|remove` are placeholders that print a
  "not yet implemented" message; third-party plugins are a supported _architectural_ concept
  only.
- **Target:** a real plugin manager (discovery + install/update/remove) wired to the
  registry, or an explicit decision to keep manual installation and remove the placeholders.
- **Governs:** NP3 ([000](./000-principles.md)), [003 §7](./003-source-plugins.md),
  [005](./005-cli-reference.md).
- **Files:** `apps/cli/src/commands/source.ts`.
- **Proof:** integration tests for the chosen workflow; until then NP3 stays normative.

### G5 — Watch-mode source execution (P3)

- **Current:** `ObservationSource.watch()` is defined but no bundled source implements it and
  the runtime never calls it; execution is `observe()`-only.
- **Target:** either a runtime execution path that drives `watch()` for sources that opt in,
  or removal of the unused interface member.
- **Governs:** NP4 ([000](./000-principles.md)), [003 §2](./003-source-plugins.md).
- **Files:** `libs/core/src/observation/types.ts`, `libs/core/src/runtime/service.ts`.
- **Proof:** a runtime test exercising a `watch()`-based source end-to-end (or a PR that
  deletes the member and updates NP4).

### G6 — `observation_history` has no write path (P3)

- **Current:** the `observation_history` table exists in the Drizzle schema and DDL, but
  `RuntimeStore` never writes to it.
- **Target:** either populate it during the tick (triggered / suppressed / no-change audit
  trail) or remove the dead table.
- **Governs:** [002 §"Persistence Schema" appendix](./002-runtime-delivery.md).
- **Files:** `libs/core/src/inbox/schema.ts`, `libs/core/src/runtime/store.ts`.
- **Proof:** a runtime test asserting rows are recorded per tick outcome (or a migration
  removing the table).

### G7 — Claude Code channel delivery transport (P2)

- **Current:** delivery has a single surface — per-session `hook-state.json` consumed by hooks
  ([002 §8/§11](./002-runtime-delivery.md)). There is no transport abstraction.
- **Target:** an AgentMon **channel** MCP server that pushes settled `DeliveryClaim`s into a session
  as `<channel>` events, and (two-way) an `agentmon_ack` tool. Binds by **session** via the inherited
  `CLAUDE_CODE_SESSION_ID`; additive and never required (NP-CH). The transport is realized
  out-of-process over the daemon IPC — no in-process core refactor (see
  [006 §2](./006-agent-integration.md)).
- **Governs:** [006-agent-integration.md](./006-agent-integration.md), PP4/BP2/AP6
  ([000](./000-principles.md)).
- **Files:** `apps/cli/src/commands/channel.ts`, `apps/cli/src/channel-render.ts`; reuses the daemon
  IPC client (`apps/cli/src/runtime-client.ts`).
- **Proof (staged):**
  1. ✅ **Binding resolved.** The `experiments/channel-probe` run (Claude Code 2.1.157) confirmed a
     spawned MCP server gets `CLAUDE_PROJECT_DIR` (= workspace) and cwd = workspace, **inherits
     `CLAUDE_CODE_SESSION_ID`**, and can call `roots/list` ([006 §4.4](./006-agent-integration.md)).
  2. ✅ **One-way push shipped.** `agentmonitors channel serve` resolves its session and pushes
     settled `claimDelivery('turn-interruptible')` results as `<channel>` events; the claim→event
     renderer is unit-tested and the command is wired ([005 §13](./005-cli-reference.md),
     [006 §4.1](./006-agent-integration.md)). Reusing `claimDelivery` gives cross-transport dedup
     ([006 §4.5](./006-agent-integration.md)) and the durable hook-path fallback
     ([006 §5](./006-agent-integration.md)) for free.
  3. Remaining: the two-way `agentmon_ack` tool (`events.ack`), plugin packaging
     (`.claude-plugin` + `.mcp.json`), and an end-to-end manual UAT (channels are research-preview,
     so not CI-able).
- **Decision captured:** binds by **session** via the inherited `CLAUDE_CODE_SESSION_ID` (no
  `CLAUDE_SESSION_ID`); the channel server lives as `agentmonitors channel serve` and polls
  `claimDelivery('turn-interruptible')`.

## Test gaps

All test gaps tracked from [004 §3](./004-validation-testing.md) are now closed:

- **T1** — `low` urgency acceptance: added to the schema test loop
  (`libs/core/src/schema/monitor-schema.test.ts`).
- **T2** — snapshot persistence & isolation: `RuntimeStore` save/retrieve/isolation tests plus a
  runtime diff-on-change test (SP5, [002 §5.2](./002-runtime-delivery.md)).
- **T3** — `validate` failure paths: closed alongside G2 (unknown-source + schema-violation
  integration tests).
- **T4** — `schema generate` / `session list|close` CLI wiring: standalone CLI integration tests.

## How to retire an item

When an item ships: move the normative statement in its governing doc from _current_ to
_target-achieved_ (drop the "not yet" framing), add the proving test, record the change in
[spec-changelog.md](./spec-changelog.md), then delete the item here.

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

> G7 (Claude Code channel delivery transport) **shipped** — built out-of-process over the daemon IPC
> (no in-process core refactor), binding by the inherited `CLAUDE_CODE_SESSION_ID`:
>
> - One-way push **and** the two-way `agentmon_ack` tool via `agentmonitors channel serve`
>   ([005 §13](./005-cli-reference.md), [006 §4](./006-agent-integration.md)); reusing `claimDelivery`
>   gives cross-transport dedup and the durable hook-path fallback for free.
> - An installable channel plugin in `channel-plugin/` (`.claude-plugin/plugin.json` + `.mcp.json`).
> - Binding confirmed empirically by `experiments/channel-probe` (006 §4.4).
>
> Non-blocking follow-ups: an end-to-end **manual UAT** (channels are research-preview, not CI-able),
> and optional `event_kind`/`object_key` meta (needs `DeliveryEventSummary` enrichment,
> [006 §4.2](./006-agent-integration.md)).

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

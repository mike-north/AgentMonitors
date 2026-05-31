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

### G1 — Reject duplicate monitor IDs (P1)

- **Current:** `scanMonitors()` discovers every `**/MONITOR.md` and parses them with no
  uniqueness check; duplicate directory basenames silently alias persisted monitor state.
- **Target:** A scanned tree with two monitors resolving to the same ID is a hard error
  surfaced by `scan`/`validate` and refused by the runtime tick.
- **Governs:** SP2 ([000](./000-principles.md)), [001 §4](./001-monitor-definition.md).
- **Files:** `libs/core/src/parser/scan-monitors.ts`; surfaced via
  `apps/cli/src/commands/scan.ts`, `validate.ts`; enforced in `libs/core/src/runtime/service.ts`.
- **Proof:** a scan/validate test with two `MONITOR.md` files whose parent dirs share a
  basename fails clearly; a runtime test asserts the tick refuses the tree.
- **Why P1:** silent state aliasing is a correctness hazard, not cosmetic.

### G2 — Full per-source JSON Schema validation in `validate` (P1)

- **Current:** `validateScope()` only checks that each `required` scope field is _present_
  (`field in scope`); types, enums, formats, and patterns are not validated. `scope: { globs: 42 }`
  passes.
- **Target:** `validate` evaluates each monitor's `scope` against the source's full
  `scopeSchema` fragment (the same schema `schema generate` emits).
- **Governs:** [004 §2.2](./004-validation-testing.md), AP4 ([000](./000-principles.md)),
  BP3 ([000](./000-principles.md)).
- **Files:** `apps/cli/src/commands/validate.ts`, `libs/core/src/observation/schema-generator.ts`.
- **Proof:** `validate` rejects a monitor whose required field has the wrong type/enum; an
  integration test covers both the unknown-source and wrong-type paths (both currently
  untested per [004 §3](./004-validation-testing.md)).

### G3 — `file-fingerprint` create/delete events (P2)

- **Current:** the source emits only _change_ observations (`previousHash !== hash`). Newly
  appearing files, deleted files, and files that stop matching the globs produce nothing.
- **Target:** baseline-relative create and delete observations (with appropriate
  `event-kind`/payload), without regressing change detection.
- **Governs:** [003 §3.3](./003-source-plugins.md), PP7 ([000](./000-principles.md)).
- **Files:** `plugins/source-file-fingerprint/src/index.ts`.
- **Proof:** source tests asserting a create event on first-appearance-after-baseline and a
  delete event on disappearance; existing change/no-change tests still pass.

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
- **Target:** a `DeliveryTransport` seam plus an AgentMon **channel** MCP server that pushes settled
  `DeliveryClaim`s into a session as `<channel>` events, and (two-way) an `agentmon_ack` tool. Binds
  at workspace granularity via `CLAUDE_PROJECT_DIR`/`roots/list` (no session id is available);
  additive and never required (NP-CH).
- **Governs:** [006-agent-integration.md](./006-agent-integration.md), PP4/BP2/AP6
  ([000](./000-principles.md)).
- **Files:** new channel-server package/command; `libs/core/src/adapter/` (transport seam);
  `libs/core/src/runtime/` (claim rendering); reuses the daemon IPC (`apps/cli/src/daemon-ipc.ts`).
- **Proof (staged):**
  1. **One-way prototype** that empirically confirms `CLAUDE_PROJECT_DIR` is populated and records
     the spawned server's cwd (resolves [006 §4.4 open question](./006-agent-integration.md)), then
     pushes a high-urgency claim as a `<channel>` event.
  2. Cross-transport dedup test: a channel push marks rows claimed so the hook path suppresses the
     duplicate reminder ([006 §4.5](./006-agent-integration.md)).
  3. Fallback test: with the channel disabled/blocked, delivery still completes via the hook path
     with no error ([006 §5](./006-agent-integration.md)).
- **Decision captured:** workspace-scoped binding (not session) because Claude Code exposes no
  session id to spawned MCP servers; single-active-lead-session assumption, degrade on multi-lead.

## Test gaps

These are required scenarios from [004 §3](./004-validation-testing.md) with no current
coverage. They are cheap to close and reduce regression risk on the items above.

### T1 — `low` urgency acceptance (P2)

- The schema test loop in `libs/core/src/schema/monitor-schema.test.ts` only iterates
  `['high', 'normal']`. `low` is first-class (PP5, [001 §3.2](./001-monitor-definition.md))
  but unasserted. Add `low` to the loop.

### T2 — Snapshot persistence & isolation (P2)

- No test exercises `RuntimeStore.saveSnapshot()` / `latestSnapshot()`: storing a
  `snapshotText`, producing `diffText` on a later change, and isolation by
  `(workspacePath, monitorId, objectKey)`. Governed by SP5,
  [002 §5.2 / §14](./002-runtime-delivery.md).

### T3 — `validate` failure paths (P2)

- The unknown-source and missing-required-field branches of
  `apps/cli/src/commands/validate.ts` have no integration test. Pairs naturally with G2.

### T4 — `schema generate` / `session list|close` CLI wiring (P3)

- `generateMonitorSchema` is unit-tested but the `schema generate` command wiring is not;
  `session list` and `session close` are only exercised inside a larger flow, never
  asserted standalone. [004 §3.5](./004-validation-testing.md).

## How to retire an item

When an item ships: move the normative statement in its governing doc from _current_ to
_target-achieved_ (drop the "not yet" framing), add the proving test, record the change in
[spec-changelog.md](./spec-changelog.md), then delete the item here.

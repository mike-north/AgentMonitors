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

> G5 (watch-mode source execution) **shipped** — the runtime now drives continuous `watch()` for
> opt-in sources via `AgentMonitorRuntime.watchMonitors()` (started by `daemon run`), funnelling each
> yielded observation through the same notify/materialize/project pipeline as `observe()`; a watched
> monitor is skipped by the tick loop so it is never driven twice, and `stop()` aborts watchers via
> `context.signal`. No bundled source opts in yet, but the path is exercised end-to-end. See
> [NP4](./000-principles.md), [002 §2.3](./002-runtime-delivery.md), [003 §2](./003-source-plugins.md),
> and [spec-changelog.md](./spec-changelog.md).

> G6 (`observation_history`) **shipped** — the runtime now writes a per-tick audit row for each due
> monitor (`triggered` / `suppressed` / `no-change`) via `RuntimeStore.recordObservationHistory`, read
> back through `agentmonitors monitor history` ([002 §"Persistence Schema"](./002-runtime-delivery.md),
> [005 §6](./005-cli-reference.md)).

> G7 (Claude Code channel delivery transport) **shipped** — built out-of-process over the daemon IPC
> (no in-process core refactor), binding by the inherited `CLAUDE_CODE_SESSION_ID`:
>
> - One-way push **and** the two-way `agentmon_ack` tool via `agentmonitors channel serve`
>   ([005 §13](./005-cli-reference.md), [006 §4](./006-agent-integration.md)); reusing `claimDelivery`
>   gives cross-transport dedup and the durable hook-path fallback for free.
> - An installable plugin: the channel MCP now ships inside the `agentmonitors` activation plugin at
>   `agent-plugins/agentmonitors/.mcp.json` (a colocated aipm marketplace; see [006 §5.6](./006-agent-integration.md)).
> - Binding confirmed empirically by `experiments/channel-probe` (006 §4.4).
> - End-to-end **push** verified by `experiments/channel-uat` — an MCP-client harness that drives a
>   real `channel serve` against a live daemon and asserts the `<channel>` push for both the
>   coalesced-reminder (normal) and concrete-event (high) paths, without needing a live Claude
>   session or a channels-enabled org.
>
> Non-blocking follow-ups: optional `object_key` meta (needs `DeliveryEventSummary`
> enrichment, [006 §4.2](./006-agent-integration.md)).

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

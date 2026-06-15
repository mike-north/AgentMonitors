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

> G8 (`command-poll` source) **shipped** — the bundled package
> `@agentmonitors/source-command-poll` implements [003 §11](./003-source-plugins.md) verbatim:
> argv-only execution (never a shell), `text-diff`/`json-diff`/`exit-code` strategies, a 1 MiB stdout
> cap with stable truncated diffs, SIGTERM→SIGKILL timeout handling with no orphan processes,
> transition-edge `ok ↔ failing` health signals (nonzero exit with output is a result, not a
> failure), and `env` never persisted. Registered via `registerCoreSources`
> (`apps/cli/src/sources.ts`) with an `init --type command-poll` template
> (`apps/cli/src/commands/init.ts`). Proven by `plugins/source-command-poll/src/index.test.ts` (the
> §11.7 validation list, incl. the no-shell metacharacter test, the nonzero-exit-is-a-result test,
> the transition-edge failure tests, and the no-orphan-on-timeout guard) and CLI integration tests
> (`apps/cli/src/commands/cli.integration.test.ts`). See [003 §11](./003-source-plugins.md) and
> [spec-changelog.md](./spec-changelog.md). The cursor (§13) target remains unbuilt.

> G9 (keyed-collection change detection) **shipped** — the `change-detection.collection` mode of
> [003 §12](./003-source-plugins.md) is now current. The per-object diff (`created`/`modified`/
> `descoped` with stable `<monitor-objectKey>#<key>` ids) is implemented once as the shared core
> helper `diffKeyedCollection` (`libs/core/src/observation/keyed-collection.ts`, exported from
> `libs/core/src/index.ts`) and consumed by **both** `api-poll` and `command-poll`. `path` is a
> minimal `$.`-dotted path selecting exactly one array; `ignore-paths` strips churn fields before
> comparison; reordering/whitespace are inherently ignored; the baseline run emits nothing. The
> `collection` block requires `strategy: json-diff` and is rejected by `validate` under
> `text-diff`/`exit-code` (BP3). Proven by `libs/core/src/observation/keyed-collection.test.ts`
> (re-sorted → zero observations; one element changing → one `modified`; addition → `created`;
> removal → `descoped`, not `deleted`; `ignore-paths` suppression), per-source integration tests in
> each plugin's `index.test.ts`, and the `validate` rejection tests in
> `apps/cli/src/commands/cli.integration.test.ts`. See [003 §12](./003-source-plugins.md) and
> [spec-changelog.md](./spec-changelog.md).

### G10 — Post-processing pipeline stages + per-recipient seam (P2)

- **Current:** the runtime implements a subset of the locked pipeline as
  `Observe → Notify(≈Pace) → Materialize/Diff → Project → Deliver`, with the diff computed **once
  per object** against the latest stored snapshot ([002 §5.2](./002-runtime-delivery.md)) and then
  projected into each matching session ([002 §6](./002-runtime-delivery.md)) — a single **shared**
  baseline.
- **Target:** the full stage model and seam of
  [002 §1.1](./002-runtime-delivery.md) — `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff → Interpret → Deliver → [React]` — with **Shape** (render before Pace and before Diff), **Pace**
  modes, and a **per-recipient Diff** computed against each recipient's own baseline/cursor right of
  the shared/per-recipient seam (so divergent-baseline recipients each hear the right span; fan-out
  multiplies only genuinely per-baseline work, capability C15). The per-stage detail lands with the
  follow-on Shape / Interpret / baseline-Diff / Pace work.
- **Governs:** PP3, AP3 ([000](./000-principles.md)), [002 §1.1](./002-runtime-delivery.md),
  the capability study ([§S1, §S4, §S5](../product/monitoring-capability-exercises.md); rows
  C6/C15/C43).
- **Files:** `libs/core/src/runtime/service.ts`, `libs/core/src/runtime/store.ts`,
  `libs/core/src/runtime/diff.ts` (and the per-recipient baseline persistence).
- **Proof:** per-stage tests landing with the follow-on work (a divergent-baseline fan-out test
  proving two recipients with different last-seen points receive different spans from one shared
  observation); until then [002 §1.1](./002-runtime-delivery.md) stays _target_.

### G11 — Source contract: snapshots-not-diffs (explicit) + composite observation (P3)

- **Current:** the runtime is already the sole producer of the delivery diff (PP3, AP3,
  [002 §5.2](./002-runtime-delivery.md)); the source contract did not state this **explicitly**, and
  composite (many-call) observations were unmodeled.
- **Target:** [003 §2.5](./003-source-plugins.md) (sources return current-state snapshots +
  `nextState`; the runtime owns the consumer-baseline diff) is reaffirmed in the source contract and,
  for §2.5, becomes _current_ with `verified:` references once a test asserts a bundled source returns
  snapshots (not pre-diffed consumer packets); [003 §2.6](./003-source-plugins.md) (composite
  observation, capability C40) ships when a source assembles one observation from many calls under one
  `objectKey`.
- **Governs:** PP3, AP3 ([000](./000-principles.md)), [003 §2.5–§2.6](./003-source-plugins.md),
  the capability study ([§S1, §S4](../product/monitoring-capability-exercises.md); rows C2/C6/C40/C43).
- **Files:** `libs/core/src/observation/types.ts`, the bundled sources under `plugins/source-*`.
- **Proof:** §2.5 — a source unit test asserting `observe()` returns current-state snapshots + the
  runtime computes the diff; §2.6 — an integration test of a source that reduces N calls into one
  stable composite snapshot. Until then [003 §2.5–§2.6](./003-source-plugins.md) stays _target_.

> The cursor protocol ([003 §13](./003-source-plugins.md)) is deliberately **not** a roadmap item:
> per #81 it is designed only as far as a sketch, to be fully specified if measured poll cost ever
> justifies it.

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

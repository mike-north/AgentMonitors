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

> **PR-A landed.** The per-recipient baseline **seam + per-recipient Diff** substrate is built and
> proven: a shared `monitor_events` artifact is materialized once, then diffed **per recipient
> against each recipient's own baseline cursor** (`session_object_cursor` →
> `session_event_state.diff_text`), so two sessions at divergent stored baselines each hear the right
> span from one shared observation. Cursor semantics: a late joiner seeds caught-up (hears only
> changes after it registered), the cursor advances at claim, and cursors persist across dormancy and
> restart (BP1). See [002 §1.1.2](./002-runtime-delivery.md#112-the-shared--per-recipient-seam) (now
> _current_ for the substrate), [002 §5.2 / §6](./002-runtime-delivery.md), and
> [spec-changelog.md](./spec-changelog.md). Proven by
> `libs/core/src/runtime/per-recipient-diff.test.ts`.
>
> **PR-B remains (keep this item open).** Rewire G13 (`net` collapse,
> [§1.1.7](./002-runtime-delivery.md)) and G14 (Interpret dedup,
> [§1.1.8](./002-runtime-delivery.md)) to span **per recipient** rather than over the shared
> baseline. They currently keep working unchanged on top of the PR-A substrate (co-registered
> recipients seed identical cursors). The remaining gap below is scoped to that rewire.

- **Current:** the per-recipient Diff seam is built (PR-A, above): one shared artifact, per-recipient
  delta against each recipient's cursor. The `net` collapse ([002 §1.1.7](./002-runtime-delivery.md))
  and Interpret ([002 §1.1.8](./002-runtime-delivery.md)) still operate over the **shared** snapshot
  baseline rather than each recipient's cursor (they remain behaviorally unchanged on the new
  substrate).
- **Target (PR-B):** rewire the `net` collapse and Interpret to span **per recipient** off the
  baseline cursor, completing the right-of-seam stages of
  [002 §1.1](./002-runtime-delivery.md) — `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff → Interpret → Deliver → [React]` — so per-recipient `net`/Interpret multiply only genuinely
  per-baseline work (capability C15).
- **Governs:** PP3, AP3 ([000](./000-principles.md)), [002 §1.1](./002-runtime-delivery.md),
  the capability study ([§S1, §S4, §S5](../product/monitoring-capability-exercises.md); rows
  C6/C15/C43).
- **Files:** `libs/core/src/runtime/service.ts`, `libs/core/src/runtime/store.ts`,
  `libs/core/src/runtime/diff.ts` (and the per-recipient baseline persistence,
  `libs/core/src/inbox/schema.ts` — landed in PR-A).
- **Proof:** the PR-A divergent-baseline fan-out test
  (`libs/core/src/runtime/per-recipient-diff.test.ts`) proves the seam; PR-B adds per-recipient
  `net`/Interpret tests. Until PR-B, [002 §1.1.7](./002-runtime-delivery.md) / §1.1.8 stay scoped to
  the shared baseline.

> G11 (source contract: snapshots-not-diffs + composite observation) **shipped** — both
> [003 §2.5](./003-source-plugins.md) and [003 §2.6](./003-source-plugins.md) are now **current**.
> §2.5 (sources return current-state snapshots + `nextState`; the runtime is the sole producer of the
> consumer-baseline diff, PP3/AP3) is reaffirmed on the `Observation`/`ObservationResult` types
> (`libs/core/src/observation/types.ts`) and proven against the bundled `file-fingerprint` source
> driven through the real runtime (`plugins/source-file-fingerprint/src/index.test.ts`,
> "snapshots-not-diffs (003 §2.5)"). §2.6 (composite observation, C40) ships as the `api-poll`
> `change-detection.composite` mode — N sub-resource calls reduced into one deterministic snapshot
> under one `objectKey` (`plugins/source-api-poll/src/composite.ts`,
> `plugins/source-api-poll/src/index.test.ts`). See [spec-changelog.md](./spec-changelog.md). Did not
> touch `runtime/service.ts` or `monitor-schema.ts` (the runtime already owned the diff).

> G12 (Scheduled-rollup Pace mode) **shipped** — `notify.strategy: rollup` is now current. The
> schema accepts a `rollup` monitor with a required five-field cron `window` (optional `timezone`,
> default UTC) and rejects `strategy: rollup` missing `window` (`rollupNotifySchema`,
> `libs/core/src/schema/monitor-schema.ts`). The runtime's `dispatchRollup()`
> (`libs/core/src/runtime/service.ts`) accumulates every observation into a durable
> `notifyState.pendingRollup` batch (`PendingRollupState`, `libs/core/src/runtime/types.ts`,
> persisted in `monitor_state.notify_state`), evaluates the `window` cron each tick via
> `cronMatchesDate`, and on a non-empty window flushes the whole batch (one `monitor_events` row
> per accumulated observation) and clears accumulation; an empty window produces no delivery. The
> batch survives a daemon restart and reuses the issue-#109 `effectiveUrgency` hydration backfill
> (BP1). All five proof criteria are covered: schema accept/reject
> (`libs/core/src/schema/monitor-schema.test.ts`) and `validate` accept/reject through the real CLI
> (`apps/cli/src/commands/cli.integration.test.ts`); durable accumulation, window flush+clear,
> empty-window no-delivery, and restart-safety (`libs/core/src/runtime/service.test.ts`, "rollup
> Pace mode"). See [001 §3.6](./001-monitor-definition.md),
> [002 §4.4–§4.5](./002-runtime-delivery.md), and [spec-changelog.md](./spec-changelog.md).

> G13 (author-declared baseline strategy) **shipped** — the `baseline-strategy` frontmatter field is
> now accepted by `agentmonitors validate` and enforced by the runtime Diff stage. `incremental`
> (default) materializes every observation in a catch-up span as its own ordered delta (backward
> compatible, the degenerate "one event per observation" behavior); `net` collapses the span per
> `objectKey` to a **single** net delta (the last observation of each object's run, diffed against the
> prior snapshot baseline), discarding intermediate churn. Omitting the field is `incremental`.
> Implemented as `baselineStrategySchema` (`libs/core/src/schema/monitor-schema.ts`,
> `z.enum(['incremental','net']).default('incremental')`) and `collapseToNetSpan()` in
> `ingest()` (`libs/core/src/runtime/service.ts`). Proven by the schema tests (accept
> `incremental`/`net`, default to `incremental`, reject unknown), the runtime tests ("baseline
> strategy (G13, 002 §1.1.7)" — `net` → one net delta, `incremental` → N ordered deltas, omitting ≡
> `incremental`), and the `validate` CLI integration tests. See
> [001 §3.7](./001-monitor-definition.md#37-baseline-strategy-current),
> [002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current),
> and [spec-changelog.md](./spec-changelog.md). The **full per-recipient-baseline seam** (two
> recipients at divergent stored baselines each receiving an independently-spanned Diff) remains
> tracked under **G10**; `baseline-strategy` is the author-declared mode that seam will apply per
> recipient.

> G14 (Interpret stage — cheap agentic digest + significance gate via the user's own AI tool)
> **shipped** — the optional Interpret stage of
> [002 §1.1.8](./002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool)
> and [006 §2.1](./006-agent-integration.md#21-the-interpret-adapter-is-upstream-of-transports-not-a-transport)
> are now _current_. Invoked **only** for `payload.form: prose`, it runs **after** the per-recipient
> Diff on the per-recipient delta, producing a cheap digest (C10) and an optional agentic significance
> gate (C11/C38). The host-specific AI-tool invocation lives behind the new `InterpretAdapter` boundary
> (`libs/core/src/adapter/interpret.ts`, concrete `createClaudeInterpretAdapter` shelling out to the
> user's own `claude -p`, argv-only) — **never** in the runtime core (002 §11.1, AP3); Agent Monitors
> ships no model and holds no credentials (C45), and the stage is disabled unless an adapter is
> injected. It is best-effort — a tool failure falls back to the §1.1.5 `rendered` artifact and is
> recorded — and every per-recipient verdict (`deliver` / `suppress` / `failed`) is recorded on
> `session_event_state` and surfaced by `monitor explain` ([§10.7](./002-runtime-delivery.md#107-monitor-pipeline-diagnosis)),
> so "why nothing fired" is inspectable (C12). Wired in `processObservation`/`runInterpret`
> (`libs/core/src/runtime/service.ts`), with the per-recipient verdict persisted via
> `recordInterpretDecision` and excluded-when-suppressed from delivery (`libs/core/src/runtime/store.ts`),
> on new `session_event_state.interpret_*` columns (`libs/core/src/inbox/schema.ts` / `db.ts`). Proven
> by `libs/core/src/runtime/interpret-stage.test.ts` (proof criteria a–e with a deterministic fake
> adapter) and `libs/core/src/adapter/interpret.test.ts`. This completes the G11–G15
> post-processing-pipeline wave. See [spec-changelog.md](./spec-changelog.md).

> G15 (Deterministic Shape stage) **shipped** — the deterministic Shape stage is now current:
> (a) **derived facts** computed as a pure function of `(shaped snapshot, injected now)` via
> `computeDerivedFacts` (`libs/core/src/runtime/shape.ts`), on the shared side of the seam, before
> Pace/Diff (C41); (b) **render-then-diff** — when a monitor declares `shape`, the runtime renders the
> shaped state to a byte-stable markdown-ish artifact (`renderArtifact`/`renderShapeArtifact`) and
> diffs **that artifact**, not the raw source (C42/C43); (c) an **author-declared payload form**
> (`prose | structured | artifact | rendered`, the stable exported `PayloadForm` type) with a turnkey
> transform for `structured` — `jq` reshapes, `cel` gates (`false` suppresses delivery) via
> `applyPayloadTransform` (`libs/core/src/runtime/transform.ts`), C46. New `shape`/`payload`
> frontmatter (`libs/core/src/schema/monitor-schema.ts`), wired in `processObservation`
> (`libs/core/src/runtime/service.ts` → `shape-stage.ts`). Sources surface raw facts and do not
> pre-compute them ([003 §2.7](./003-source-plugins.md)). The transform evaluators (`cel-js`,
> `jq-in-the-browser`) are CSP/Workers-safe (no `Function`/`eval`). Proven by
> `libs/core/src/runtime/shape.test.ts` (fixed-`now` derived-facts purity; byte-stable render with
> exactly one added `revealed` line), `libs/core/src/runtime/transform.test.ts` (jq projection, cel
> gate, malformed-transform rejection), `libs/core/src/runtime/shape-stage.test.ts` (the same
> end-to-end through a runtime tick), and `libs/core/src/schema/monitor-schema.test.ts`. See
> [001 §5.1–§5.2](./001-monitor-definition.md#51-shape-declaration-target),
> [002 §1.1.4–§1.1.6](./002-runtime-delivery.md#114-shape-deterministic-derived-facts),
> [003 §2.7](./003-source-plugins.md), and [spec-changelog.md](./spec-changelog.md). The optional
> Interpret stage that `payload: prose` invokes shipped as G14 (above).

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

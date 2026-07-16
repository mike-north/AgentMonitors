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

> G10 (Post-processing pipeline stages + per-recipient seam) **shipped** — both PRs landed.
>
> **PR-A** built the per-recipient baseline **seam + per-recipient Diff** substrate: a shared
> `monitor_events` artifact is materialized once, then diffed **per recipient against each recipient's
> own baseline cursor** (`session_object_cursor` → `session_event_state.diff_text`), so two sessions
> at divergent stored baselines each hear the right span from one shared observation. Cursor
> semantics: a late joiner seeds caught-up, the cursor advances at claim, and cursors persist across
> dormancy and restart (BP1). Proven by `libs/core/src/runtime/per-recipient-diff.test.ts`.
>
> **PR-B (Refs #182)** rewired the right-of-seam stages onto that substrate, completing
> [002 §1.1](./002-runtime-delivery.md) — `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff →
Interpret → Deliver → [React]`:
>
> - **`net` collapse is now per-recipient at claim time** ([002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current)).
>   The shared chain records **every** observation in order (the incremental substrate, Decision Q3);
>   `RuntimeStore.collapseNetForClaim` (driven by `claimDelivery`) delivers only the newest event per
>   `objectKey` for a `net` monitor — delta recomputed against that recipient's cursor → endpoint —
>   and records the older intermediates **claimed-but-suppressed** (`session_event_state.net_suppressed_at`,
>   explainable via `monitor explain`, never delivered). The cursor still advances to the newest
>   claimed artifact when intermediates are suppressed. `baseline_strategy` is persisted on each
>   `monitor_events` row so claim needs no monitor re-scan.
> - **Interpret runs once per distinct per-recipient delta** ([002 §1.1.8](./002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool)).
>   `runInterpret` groups projected sessions by distinct `diff_text` and invokes the adapter once per
>   distinct delta (Decision Q4: at materialize on the single-event delta; a claim-time `net` re-diff
>   does not re-invoke the adapter unless the collapsed delta differs).
>
> Proven by `libs/core/src/runtime/net-per-recipient.test.ts` (away-across-N → one net delta + 2
> suppressed; `incremental` 3-ordered-deltas contrast; missed-nothing degenerate; backward-compat;
> divergent-baseline Interpret → 2 calls, identical → 1 fanned; shared-chain keeps all N) and the
> updated `net`/rollup tests in `libs/core/src/runtime/service.test.ts`. Files touched:
> `libs/core/src/runtime/service.ts`, `store.ts`, `types.ts`, `libs/core/src/inbox/schema.ts` / `db.ts`.
> See [002 §1.1.2 / §1.1.7 / §1.1.8](./002-runtime-delivery.md) (now _current_, G10 complete) and
> [spec-changelog.md](./spec-changelog.md).

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
> now accepted by `agentmonitors validate` and enforced by the runtime Diff stage. `net`
> (default since 2026-06-19, Refs #110) collapses the catch-up span per `objectKey` to a **single**
> before/after delta (the newest event per object, diffed against the recipient's own cursor →
> endpoint), discarding intermediate churn; the envelope may carry multiple events when multiple
> objects changed (per object, not per monitor). `incremental` (explicit opt-out) delivers every
> observation in the span as its own ordered delta. Omitting the field is `net`. Implemented as
> `baselineStrategySchema` (`libs/core/src/schema/monitor-schema.ts`,
> `z.enum(['incremental','net']).default('net')`) and `RuntimeStore.collapseNetForClaim`
> (`libs/core/src/runtime/store.ts`), applied per-recipient at claim time (G10 PR-B). Proven by the
> schema tests (accept `incremental`/`net`, default to `net`, reject unknown), the runtime tests
> ("baseline strategy (G13, 002 §1.1.7)" — omitting ≡ `net`, explicit `net` → 1 delta, explicit
> `incremental` → N ordered deltas), `libs/core/src/runtime/object-consolidation.test.ts`
> (15-saves canonical case end-to-end), and the `validate` CLI integration tests. See
> [001 §3.7](./001-monitor-definition.md#37-baseline-strategy-current),
> [002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current),
> and [spec-changelog.md](./spec-changelog.md). The **full per-recipient-baseline seam** is
> **current** (G10 complete; `baseline-strategy` is the author-declared mode applied per recipient
> at claim time).

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

### G16 — Agent-facing act-on-signal CLI verbs (P2)

- **Current:** an agent that receives a pushed signal has no read-only way to fetch the current
  stored snapshot, diff two points in time, or get a lightweight summary; it would have to re-fetch
  the watched resource itself.
- **Target:** the read-only `snapshot` / `diff` / `summary` verbs of
  [007 §3](./007-agent-facing-interaction.md) / [005 §14.1–§14.3](./005-cli-reference.md),
  async-biased, side-effect-free (no claim/ack/cursor move, no re-observe).
- **Governs:** PP9, PP10, AP6, SP5 ([000](./000-principles.md)),
  [007 §2–§3](./007-agent-facing-interaction.md).
- **Files (anticipated):** `apps/cli/src/commands/*`, `apps/cli/src/daemon-ipc.ts`,
  `libs/core/src/runtime/store.ts` (snapshot/diff reads).
- **Proof:** integration tests that a read returns the durable answer and leaves
  `session_event_state` / `session_object_cursor` unchanged and invokes no source `observe()`
  ([007 §6](./007-agent-facing-interaction.md)).

> G17 (ephemeral, session-scoped, agent-declared monitors) **shipped** (Refs #312) — agents declare
> session-scoped monitors via `agentmonitors watch` (declare/list/cancel, [005 §14.4](./005-cli-reference.md)),
> validated by the same `validateScope` path as `validate`; they run on the same
> tick/notify/materialize/project pipeline as persistent monitors (AP7), their events project into the
> **declaring session only** ([007 §4.6](./007-agent-facing-interaction.md)), and they are reaped on
> session close, on `watch cancel`, and on **per-session dormancy** — a new inactivity trigger added to
> [002 §6.2](./002-runtime-delivery.md). Ephemeral ids are the reserved-prefix `ephemeral:<sessionId>/<ulid>`
> (collision-proof by the mandatory `/`), the definitions are durable and survive a daemon restart while
> the session lives (no resurrection after it ends), and reaped events are retained. See
> [007 §4](./007-agent-facing-interaction.md), [002 §6.2](./002-runtime-delivery.md),
> [005 §14.4](./005-cli-reference.md), and [spec-changelog.md](./spec-changelog.md). Still **composes with**
> #124 (dependent chains build on this primitive) and #258 (shared per-binding durable-state primitive),
> per [007 §4.7](./007-agent-facing-interaction.md).

### G18 — Observability surface: received / pending / armed-but-not-yet-fired (P2)

- **Current:** `events list [--unread]` shows received/pending; there is no single surface for
  "a condition is met but is being held before delivery."
- **Target:** the `agentmonitors inspect` verb of [007 §5](./007-agent-facing-interaction.md) /
  [005 §14.5](./005-cli-reference.md), deriving the **armed** bucket from the already-durable hold
  substrate (settle/debounce/throttle/rollup windows, `net`/Interpret suppression) with a hold
  reason and earliest-fire time — a pure read, no new watching.
- **Governs:** PP4, PP7, SP4, BP2 ([000](./000-principles.md)),
  [007 §5](./007-agent-facing-interaction.md).
- **Files (anticipated):** `libs/core/src/runtime/store.ts` (armed-set read over `monitor_state` /
  `session_event_state`), `apps/cli/src/commands/inspect.ts`; reuses the `monitor explain` substrate
  ([002 §10.7](./002-runtime-delivery.md)).
- **Proof:** integration test that a change transitions armed → pending → received across three
  distinct, separately-asserted states ([007 §6](./007-agent-facing-interaction.md)).

### G19 — Codex host adapter (CLI + desktop) (P3)

- **Current:** `claudeCodeAdapter` is the only `AgentRuntimeAdapter`.
- **Target:** a Codex adapter satisfying the multi-host contract of
  [006 §11](./006-agent-integration.md) — lifecycle mapping, session identity, workspace binding,
  delivery-surface state, portable baseline + any additive transport — with delivery semantics
  invariant vs Claude (§11.5).
- **Governs:** AP3, AP6, PP4, NP5 ([000](./000-principles.md)),
  [006 §11](./006-agent-integration.md).
- **Files (anticipated):** `libs/core/src/adapter/codex.ts`, activation packaging, a
  binding-probe artifact under `experiments/`.
- **Proof:** an integration test driving Codex's real lifecycle-hook command/stdin contract end to
  end plus a probe artifact pinning the identity/workspace signals ([006 §11.6](./006-agent-integration.md)).

### G20 — Cursor host adapter (CLI + IDE) (P3)

- **Current:** `claudeCodeAdapter` is the only `AgentRuntimeAdapter`.
- **Target:** a Cursor adapter satisfying [006 §11](./006-agent-integration.md), with an internal
  CLI-vs-IDE surface branch only if the two surfaces' mechanisms diverge (§11.4).
- **Governs:** AP3, AP6, PP4, NP5 ([000](./000-principles.md)),
  [006 §11](./006-agent-integration.md).
- **Files (anticipated):** `libs/core/src/adapter/cursor.ts`, activation packaging, a
  binding-probe artifact under `experiments/`.
- **Proof:** an integration test driving Cursor's real lifecycle-hook contract end to end plus a
  probe artifact pinning the identity/workspace signals ([006 §11.6](./006-agent-integration.md)).

> The cursor protocol ([003 §13](./003-source-plugins.md)) is deliberately **not** a roadmap item:
> per #81 it is designed only as far as a sketch, to be fully specified if measured poll cost ever
> justifies it. (Unrelated to the **Cursor host adapter** in G20 — this "cursor protocol" is the
> source-side poll-cursor sketch, G20 is the Cursor editor host; see the **Poll cursor / source
> cursor protocol** disambiguation in [glossary.md](./glossary.md).)

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

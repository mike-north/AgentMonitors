# 004 — Validation & Testing

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [001-monitor-definition.md](./001-monitor-definition.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [003-source-plugins.md](./003-source-plugins.md)
> **Covers:** validation surfaces, CLI verification behavior, required test scenarios, ambiguity handling

## 1. Overview

This document specifies how the Agent Monitors spec should be validated and how the repository should handle ambiguity, drift, and contradictory evidence. The implementation already contains useful tests across parser, runtime, CLI, and bundled sources. This document turns those scattered checks into a coherent, traceable test obligation tied back to the numbered specs.

### Principles Satisfied

| Section                 | Principles             |
| ----------------------- | ---------------------- |
| Validation surfaces     | PP7, PP8, AP4, AP6     |
| Required test scenarios | PP1, PP5, PP6, AP1–AP4 |
| Ambiguity handling      | PP7, PP8               |

## 2. Validation Surfaces

The repository currently exposes several different validation surfaces. They do not all prove the same thing.

### 2.1 Parse-time validation

`parseMonitor()` proves: the file can be read; YAML frontmatter parses; top-level monitor schema is valid; the body is extracted as instructions. It does **not** prove that source-specific watch config is fully valid.

**Verified in:** `apps/cli/src/commands/validate.ts` calls `scanMonitors()` which calls `parseMonitor()` internally. The parser rejects invalid top-level fields (wrong `urgency` value, missing `watch`, malformed `notify`) but accepts any object inside `watch` without source-specific validation.

### 2.2 `agentmonitors validate`

The `validate` command proves: the monitor directory exists; monitor files parse; monitor IDs are unique within the tree (see [001 §4](./001-monitor-definition.md)); the selected source name is known; and each monitor's watch config (the `watch` block minus `type`) is **fully valid** against its source's `scopeSchema`.

**Verified implementation detail (current):** source config validation runs full JSON Schema (draft-07) checks — types, enums, `required`, `items`, and other keywords — via the exported core helper `validateWatchScope(scope, scopeSchema)` (`libs/core/src/schema/validate-scope.ts`), which wraps `validateScope` with actionable collection-strategy and timezone diagnostics. Both `validate` and `monitor test` call it after extracting `watch` minus `type`. A monitor with `watch: { type: file-fingerprint, globs: 42 }` is now **rejected** (validate exits non-zero) because `globs` must be an array of strings.

When parse-time validation sees the old top-level `source:` + `scope:` shape, `validate` keeps the parse error but appends a targeted hint to move those fields into `watch: { type, ... }`.

The validator is `@cfworker/json-schema`, which walks the schema at runtime rather than compiling with the `Function` constructor, so validation is safe under restrictive CSP / Workers-style environments.

The shared helper validates a private schema copy and does not annotate plugin-owned
schema objects. A frozen valid schema must still validate normally. Setup/evaluation
exceptions are nonempty `Source schema validation failed: <cause>` diagnostics,
not successful validation and not a reason to abort the whole monitor set. Existing
scope mismatch and collection/timezone messages remain unchanged. Tests must cover
malformed patterns, deep-frozen valid schemas, ordinary valid/invalid scopes, and
schema immutability, using real registered-source/SQLite tick and watcher-startup
boundaries. Assert healthy sibling effects, per-monitor diagnostics, retained
baseline/cursor/overdue notify work, and repair/restart recovery. Tick failures must
not strand suppression cleanup or hook refresh. Covered by
`schema/validate-scope.test.ts` and `runtime/validation-exceptions.test.ts` in core.

> **Target extension (not yet implemented).** Validation of `shape` predicate determinism and
> `payload.form` / `payload.transform` / `payload.encoding` is a **_target_** obligation for the
> `validate` surface. When implemented, `validate` will additionally reject: a `shape.derive.when`
> CEL predicate that references symbols outside `(snapshot, now)`; a `payload.transform` under any
> `form` other than `structured`; a malformed `jq` or `cel` expression; and an unknown `form`,
> `language`, or `encoding` value. The cross-references from
> [001 §5.1](./001-monitor-definition.md#51-shape-target) and
> [001 §5.2](./001-monitor-definition.md#52-payload-form-target) point at this _target_ guarantee,
> not the current `watch`/`scopeSchema` validation already in place.

### 2.3 `agentmonitors schema generate`

The schema-generation path proves that the source registry can produce a combined editor-facing schema for monitor authoring. It is a contract surface for: allowed top-level monitor fields; allowed urgency values; source-discriminated watch config shapes.

**Verified in:** `libs/core/src/observation/schema-generator.ts` — `generateMonitorSchema()` produces a JSON Schema draft-07 document with `if/then` conditionals per source, a `source` enum drawn from registered source names, `urgency` constrained to `['low', 'normal', 'high']`, and a `notify` `oneOf` covering `debounce` and `throttle` strategies.

### 2.4 `agentmonitors monitor test`

Before any source observation, `monitor test` applies the same `validateWatchScope` check as `validate`. Invalid scopes exit 1 with identical rejection details inside each command's existing output envelope: `monitor test` uses stderr in text mode and stdout `{ "error": "..." }` in JSON mode; `validate` reports invalid monitors on stdout in both formats.

**Verified in:** `apps/cli/src/commands/monitor-scope-parity.integration.test.ts` — `monitor test / validate scope parity` runs identical monitor files through both commands in text and JSON modes for invalid enums, unknown properties, wrong types, missing required fields, nested collection items/required fields, collection-strategy constraints, and nested composite parts. Real HTTP and command/file sentinels must remain untouched for rejected scopes; valid controls prove both sentinels detect source execution.

`monitor test` is a source exerciser, not a proof of long-running runtime correctness. For stateful sources, it proves: the source can establish a baseline; a follow-up observe call can run without losing state inside the command. It does **not** prove that a real change occurred during that command invocation.

**Verified in:** `apps/cli/src/commands/monitor-test.ts` — when the first observe call returns zero observations, `source.stateful` is true and `nextState` is non-nullish, the command calls `createFollowupObservationContext()` (which reuses `previousState` from the baseline result) and runs a second observe call. Both calls happen within the same process. No file-system or external change can realistically occur in the 100 ms `setTimeout` between calls, so "no changes detected" is the expected and documented outcome.

A missing/null initial baseline MUST fail before the baseline message or second call, preserving
`no-files-matched` diagnostic precedence and accepting non-nullish primitive source states.
Unavailable `incoming-changes` observation MUST fail through the existing error envelope, not
claim a baseline or configuration success. A failed follow-up also fails the overall dry-run,
although an already-established first baseline remains a truthful text statement.

Required regression scenarios for Refs #305 / decision #555:

- Real Git non-repo/missing cwd, missing Git, unknown/option-looking/non-commit refs reject with
  the exact 003 §6.5 diagnostic; child stderr is quiet. Commit and annotated commit-tag controls
  baseline successfully; absent old SHA rebaselines and failed show omits only the snapshot.
- In both SHA-1 and SHA-256 repositories, source and built-source tests MUST reject
  `HEAD:payload` even when `payload^{commit}` is also a tracked blob. They MUST preserve
  `:/Initial` commit-search semantics with a matching commit distinct from HEAD. Built CLI
  text/JSON must report the existing failure envelope and exit 1 for the blob expression,
  successfully baseline the valid search expression, and create no database in either case.
  Keep HEAD/full-ID/tag/extended-commit positive controls and raw blob/tree/range/option-looking
  negative controls. A narrow reversion to suffixing authored expressions must fail these
  regressions while the controls continue to pass.
- Last-good SHA survives an outage and SQLite reopen; recovery emits the exact net change from
  that SHA. A failing source does not prevent a sibling from observing.
- Pin the current error-path consequences: due errors retry without advancing the timestamp,
  and held debounce/rollup work survives reopen. Held work then flushes at its own deadline or
  window while the source still fails (002 §2.6, §3.3 below); #559 tracks retry cost.
- Real bundled CLI text/JSON rejects unavailable inputs without writing the DB. History and
  explain expose the error over a real daemon socket and the offline DB fallback, in all supported
  formats. Legacy error display strips controls and bounds Unicode text without rewriting audit
  bytes or leaking another workspace's history.

Verified by `plugins/source-incoming-changes/src/unavailable.test.ts`,
`plugins/source-incoming-changes/src/revision-expressions.test.ts`,
`libs/core/src/runtime/source-error-state.test.ts`,
`apps/cli/src/commands/monitor-test.test.ts`, and
`apps/cli/src/commands/incoming-changes-diagnostics.test.ts`.

### 2.5 Runtime tests

Runtime tests are the primary proof surface for: state persistence across runtime restarts; due scheduling; delivery lifecycle semantics; session projection; hook state correctness; and atomic rollback of deterministic materialization writes.

Definition-change semantics ([002 §5.3](./002-runtime-delivery.md#53-pending-events-keep-the-semantics-they-were-observed-under))
need real-runtime scenarios: an event materialized at `normal` is not delivered as a high-urgency
interrupt after an edit to `high`; an event observed under command A renders A's body and payload
after an edit to command B; a batch held across the edit and a daemon restart after it keep the
observed semantics; `explain` counts pre-edit pending events and ignores rows with no fingerprint.

**Verified in:** `libs/core/src/runtime/service.test.ts`,
`libs/core/src/runtime/transactional-materialization.test.ts` and
`libs/core/src/runtime/definition-change.test.ts`.

For the current retry-diagnostic contract in [002](./002-runtime-delivery.md), a regression **MUST**
hold the real asynchronous monitor scan at a deterministic test-only barrier, commit valid retry
work through the public store API while it waits, then release the real parser result. The report
must retain the committed count and retry IDs; a valid-definition report with a committed event
prefix must diagnose its retained suffix as pending. Include a no-interleaving control and missing,
parse-invalid, duplicate and invalid-schedule routes. Assert that native retry/envelope/error bytes,
opaque source state, event and history rows remain unchanged by diagnosis, and that diagnosis does
not invoke a source. This is a same-runtime ordering check, not a cross-process snapshot guarantee.
The permanent scenarios are in `libs/core/src/runtime/retry-diagnostics.test.ts`.

Runtime source-config preflight is **current** behavior (002 §2.0). Tests **MUST**
prove rejection before source side effects using a real registered source, exact
`validateWatchScope` diagnostic parity with tick/explain/doctor, healthy sibling
progress, and invalid-to-fixed recovery across runtime restart with baseline and
held notify work retained. Cover directory ticks, persisted ephemeral ticks after
schema changes, and continuous watcher startup. Invalid config intentionally stops
observation, including configs that previously ran; daemon text/JSON and continuous
logging must make that pause visible. The built CLI must also prove the authoring
and diagnostic surfaces agree. Include a real bundled `file-fingerprint` source
with valid globs and a malformed interval: doctor must report the validation error
without scheduling it or inventing a due time, retain healthy sibling results, and
leave source/notify state, events, and observation history unchanged. A stale verify
owner reaped while its monitor's globs are rejected must give its registered artifact cleanup
authority without deriving any lifetime from the rejected config: retain the source baseline and held
legitimate work, report the config skip and progress a healthy sibling. A real-source/SQLite case
must then close and reopen the store, repair the config after an arbitrary pause, and exclude the
retained scratch deletion from an actual later-session claim while delivering legitimate held work
and preserving a foreign workspace with the same key. Covered by
`libs/core/src/runtime/verify-artifact-rejected-config.test.ts`,
`libs/core/src/runtime/object-event-suppressions.test.ts`,
`libs/core/src/runtime/source-validation.test.ts` and
`apps/cli/src/commands/runtime-source-validation.test.ts`.

#### Verify-artifact ownership (002 §2.8, 005 §16 step 9)

`libs/core/src/runtime/verify-artifact-ownership.test.ts` **MUST** drive the real file-fingerprint
source against real files, close and reopen the SQLite database across an arbitrary pause (hours,
far beyond any former suppression lifetime), and assert both the durable event table and an
**actual later-lead claim**. Required scenarios:

- **Delayed recovery:** a deletion retained in the source baseline while the monitor is invalid; an
  already-held deletion; a held-only create left by a killed run (no event ever projected) that is
  discovered only through stale-owner reaping; a held envelope drained by a notify-policy edit; a
  create held in a rollup window that fires after the owner is reaped.
- **Held flush with nothing else held:** when the only held item is an artifact with cleanup
  authority, the not-due rollup window check and the debounce and rollup flushes while
  `observe()` fails (002 §2.6) clear the hold, keep the source baseline and `lastObservationAt`,
  materialize nothing and write no audit row of their own; on the failing path the source's
  `errored` row is the only new row.
- **Incoming boundary:** a filtered observation does not consume a throttle window that a later
  legitimate change needs; a watcher batch admitted after restart, before any tick has recorded
  the owner's inactivity, is already filtered.
- **Retained retries:** in `libs/core/src/runtime/verify-artifact-ownership-retry-drain.test.ts`, a
  retry for a registered artifact, queued before cleanup authority took effect, is dropped by the
  tick drain and by the watcher drain before its next pull (002 §2.7): no event, the row is gone,
  nothing is reported, and the monitor's later legitimate input materializes. A `terminal` retry
  for such an artifact no longer pauses its monitor. After a drop the drain continues with the
  next row: a legitimate retry retained behind the artifact completes before newer input. Cleanup
  that a second runtime on the same database records after the drain read the row, before its
  completion commits, still drops it: no lead session receives it. A removal that cannot commit is
  reported as a failed drain step with an `errored` row, keeps the row, leaves another monitor in
  the same tick running, and succeeds on the next drain once the fault clears. Controls: a retry
  for an unregistered scratch-looking key, for a key retired only in a foreign workspace, for a
  real path beside a retired artifact, and for an artifact still in its proof phase each still
  materializes.
- **Refusal placement:** in `libs/core/src/runtime/verify-artifact-ownership-refusal-position.test.ts`,
  a debounce hold refusal made behind a held artifact whose cleanup authority then took effect is
  placed among the envelopes that survive the filter (002 §2, §2.8): when an escalation flushes the
  batch, a newer same-key sibling supersedes the refusal, alone or after an older kept sibling held
  beside the artifact. Controls: that older kept sibling alone does not supersede it, and with
  nothing filtered the refusal still sits between the held artifact and the newer sibling.
- **No expiry:** cleanup authority survives arbitrary wall-clock time and repeated successful polls.
- **Exactness controls:** a foreign workspace with the same monitor id and key keeps delivering; an
  unregistered scratch-looking path (even under a reaped verify-named session) is ordinary work; a
  real watched path cannot be registered; a key owned by another run, a key without the run's
  token, and an inactive or missing owner are refused. Legitimate items in the same held batches
  must materialize.
- **Crashes:** a retried registration before and after restart keeps one record; a run killed after
  registration but before creating the file is reaped to cleanup once, idempotently across
  restarts; a retried cleanup request keeps the first request time; a killed run's projected proof
  event is retracted at reaping and its later deletion filtered; an owner that ended before its
  cleanup was recorded already supplies authority, and the next tick records it.

`libs/core/src/inbox/db.released-shapes.test.ts` proves every released database shape migrates to
the `verify_artifacts` table and both indexes, and reopens. `apps/cli/src/daemon-ipc.test.ts`
round-trips registration and cleanup over the socket, refusing real paths and unregistered runs.
`apps/cli/src/commands/verify.integration.test.ts` proves the built CLI against a real workspace
daemon: the run leaves exactly one ownership record with `owner-request`; an interrupted run's
record has cleanup recorded; and against a daemon that answers registration as unsupported, verify
takes the legacy fallback, passes, and leaves no scratch event for the later session.

#### Notify-policy-edit durability (002 §4.6)

`runtime/notify-policy-edit.test.ts` MUST prove all six exits from holding strategies, effective
same-strategy/default changes, unchanged-policy clocks, captured old/new semantics and immutable
materialized rows. Edits reconcile before source-due/active-watcher skips without new source input.
Invalid/missing definitions retain holds and report the reason. A blocked watcher retains its
unadmitted batch and is not pulled again until reconciliation succeeds (002 §2.4).
`runtime/notify-boundaries.test.ts` MUST exercise actual watcher microtask interleavings: yield a
batch while admission is open, then fail the real SQLite edit drain before its mutation. Original holds and cursor remain unchanged, without an event prefix; recovery drains
captured old work before the retained operation, while cancellation writes nothing. Cover a newer
successful policy without reloading handling, and prove an accepted span's deterministic writes
complete before Interpret can close its gate. Immediate/throttle escalation grants participate in
policy identity; equivalent policies and prior private-key encodings retain unchanged clocks. Restart/startup drains with idle or completed
sources MUST update actual lead hook files without tick/new observations, preserving workspace and
session isolation and publishing no unread state before transaction commit.

`runtime/notify-admission-lifetime.test.ts` MUST use concurrent public ticks and actual controlled
source effects to fail an edit while `observe()` awaits. The completed observation must neither
advance durable state while blocked nor prevent the tick returning for recovery; retry/startup
admits it in order using current pacing and captured handling. Cover restart from the unchanged
cursor, healthy sibling/workspace isolation and startup overlapping a valid poll. At the actual
factory boundary, exercise a gate closing, cancellation and replacement with a newer initial
definition. Repeated declare/tick/cancel, close and dormancy cycles must release cached definitions
without deleting accepted history; live blocked watcher/poll waiters and teardown remain functional.

`runtime/notify-checkpoint-teardown.test.ts` MUST block an actual yielded baseline batch with a
failed SQLite edit drain, then let recovery admit it before the iterator completes or fails. The
watcher keeps its scoped exclusion/cache ownership while that batch waits, and permits recovery
rescans without a deadlocked tick. Assert that polling/replacement reads the admitted baseline
before its own baseline advancement, not a silently discarded batch. Independent reopen must
preserve the later baseline. Include abort/stop of a waiting batch, a superseded watcher's batch,
healthy foreign workspace/monitor scopes and completion with no pending batch; no retired cache
owner may delete a successor's slot.

`runtime/notify-failed-poll-successor.test.ts` MUST schedule overlapping public ticks so a real
SQLite ingestion failure resumes its error handler after a successor observation has started.
The older handler must preserve that successor's admission: a third poll stays excluded and
watcher factory and its baseline batch wait until the successor's writes finish. Assert correctly ordered
baselines/events through full SQLite close/reopen, the original ingestion error, ordinary observe
failure/success controls, valid later wakeups and healthy sibling/foreign-workspace progress.
Failures before ingestion starts must still clean up their own admission and permit a later poll.
Scheduling may complete a registered source at registry lookup; runtime/ingestion/admission methods
must remain actual implementations.

`runtime/notify-discovery-freshness.test.ts` MUST suspend an earlier monitor in public tick and
startup discovery while a newer tick/startup adopts rollup and holds work in a second actual file.
The older scan cannot drain that work or restore its obsolete policy even when the source is not
due. Cover a newer failed gate, invalid/deleted definitions, legitimate return to an earlier policy,
and independent SQLite reopen. No runtime/store/admission methods may be replaced.

`runtime/notify-deferred-handoff.test.ts` MUST retain a real completed poll behind a failed SQLite
edit drain, then recover with throwing observation/next-state/outcome getters and an actual ingestion
failure. Every exit releases exactly the deferred-result lease, preserving a live watcher owner.
Assert the original error and committed drain truthfully, normal success/recovery, cursor persistence,
private-cache cleanup after deletion and full SQLite close/reopen. Existing cancellation/retirement,
scope isolation, writer-lock, killed-process and successor-admission controls remain required.

`runtime/notify-live-definition.test.ts` MUST create the first actual watcher hold **after** an
older tick/startup captured held membership, then edit its source to an unknown name. The
watcher's next batch must stay unadmitted without cursor/baseline advancement, the error remains scoped and a
healthy sibling progresses. No-held unknown-source errors remain fatal but close existing admission.
Exercise flat→folder and folder→flat same-ID moves with old/new tick and startup discovery; actual
baseline batches must use the newer admitted path without a third scan, while established handling stays
pinned. Captured-route missing diagnostics share that protection. Reread invalid/deleted/current
unknown-source or invalid-scope replacements, retain fatal duplicates and isolate foreign workspace
identities. Assert actual watcher effects, recovery and full SQLite close/reopen; do not replace
runtime/store/admission methods. Independent hold-classification/path-resolution reversions must
reproduce their own failures while the earlier freshness/handoff controls remain green.
It MUST also deny fallback when an admitted parent is mode 000 and read fails EACCES even though
an existence probe returns false. Use actual POSIX permissions when supported, restoring them in
finally before fixture cleanup. Faithful targeted filesystem read/metadata faults cover permission,
I/O and unclassified query errors elsewhere; never replace runtime/store/admission methods. Actual
batch, original holds/baseline and healthy sibling progress must remain intact until
permission restoration and valid reconciliation. Genuine ENOENT/ENOTDIR moveback must still succeed
without another scan, and a narrow absence-classification reversion must fail the denial cases.
After the first denial, one and multiple **unchanged** tick/startup/captured-route discoveries MUST
still revalidate the same denied location: the actual batch remains unadmitted, original holds
and baseline stay unchanged, no source factory/poll bypasses it, and healthy scopes progress.
Require actual POSIX first/repeated tick/startup pairs and faithful synchronous/asynchronous read
fault controls. Cover a never-admitted location first blocked by unresolved source, later invalid
edits at that location, genuine absence after a closed gate, and last-owner stop/abort cleanup.
Current path and cache ownership must retire together; a new owner must use fresh authored handling.
A narrow loss-of-location-on-gate-close reversion must fail these regressions while all prior
freshness, absence, scope, duplicate, lease and batch/successor controls remain meaningful.

`runtime/notify-legacy-policy-identity.test.ts` MUST seed the exact older private-key-missing
shape in an owned SQLite fixture, fully close/reopen and learn identity on an unchanged not-due
scan while preserving guards, holds, clocks, opaque/raw baselines and event/cursor artifacts.
Cover throttle guard-only and rollup-minute state, equivalent policies, a later known edit across
restart, actual B delivery, identical legacy holds, failed identity writes/validation and owned
writer refusal. Fresh scopes must retain absent previousState; keyed unchanged rows need no rewrite.
Do not infer policy history before the first successful identity-learning scan.

`runtime/notify-observe-only-startup.test.ts` MUST reconcile existing watcher/poll ownership
before skipping a factory-less current source. The actual batch and cursor stay blocked on
invalid scope or real SQLite drain failure; startup recovery commits captured old handling before
new work under current pacing. Cover evaluating/deferred polls, no replacement factory or polling,
healthy scoped progress, unowned ordinary state untouched and same-ID foreign ownership isolation.
Full SQLite reopen and independent identity-learning/factory-skip reversions remain required.

`runtime/notify-only-baseline.test.ts` MUST seed controlled raw legacy JSON `null` and other
opaque source representations with a fingerprint, learn identity, then apply a not-due effective
edit. Guard-only resets and held drains through tick/startup must preserve raw `source_state`,
`last_fingerprint` and `last_observation_at` through full SQLite reopen. Make the next poll due
with a clock-only SQL update, never the broad state setter, and assert the actual source receives
the original `previousState`. Include equivalent-policy controls, real notify-update failure with
complete materialization rollback/retry, and a narrow reversion of only the edit's notify-only
persistence. Prior identity, startup, scoped ownership and atomic-drain controls remain required.

Use real file-backed SQLite triggers for event/projection/cursor/snapshot/hold-removal faults,
including a later batch write and failed diagnostics. Assert full rollback of original state,
no partial event prefix, blocked new source/baseline, healthy siblings/other workspaces and restart
recovery. A stale pre-lock read in one independent process must not duplicate or overwrite another
process's committed drain. Interpret must run after commit against each event's projected recipients.

Kill evidence MUST use bounded owned child processes, actual SIGKILL before and after commit,
awaited exit and SQLite reopen. Before commit: original holds and no partial events. After commit:
events and no old holds. Reconciliation after reopen adds exactly the remaining events, with no
duplicate prefix. Runtime reconstruction alone is not killed-process evidence. Test children may
load TypeScript source using Node 24 transformation and a narrow local resolver; tests MUST NOT
start a package build or rely on a previously built dist tree.

This acceptance concerns the effective-edit transaction, not retry draining of ordinary
ingest/flush work (002 §2.7) or unchanged-policy flushing after source errors.
`runtime/edit-drain-admission-outcomes.test.ts` MUST prove the edit/admission-outcome boundary:
an edit with nothing to drain leaves an outstanding drop and records nothing, and only a drained
event of its key supersedes it; a drain that fails while the outbox is full records no drop and no
retry, keeps the hold and blocks the poll until recovery; and a rejected scope with held work and
an outstanding drop leaves hold, drop and baseline untouched, while a watcher batch waiting at that
closed gate records no drop until valid recovery admits it. No downstream exactly-once side effects are claimed.

A source-config rejection (002 §2.0) found by a tick or a watcher-startup rescan MUST block a
running watcher's next batch while the scope has held work, leaving the held work and
cursor unchanged until valid recovery commits old and new work. Without held work, the same
rejection MUST NOT close admission by itself: a watcher whose admission is open MUST keep admitting
batches under its startup config. A watcher already blocked (an unresolved source,
a failed drain) stays blocked until a valid definition is reconciled, losing nothing it yielded.
`runtime/notify-observe-only-startup.test.ts` covers both paths for tick and rescan.

### 2.6 CLI integration tests

CLI integration tests are the primary proof surface for: command wiring; output shape and argument validation; round-trip behavior through the daemon/runtime interface.

**Verified in:** `apps/cli/src/commands/cli.integration.test.ts`

### 2.7 Fresh-environment E2E (hooks path)

Every other surface above runs inside the repo's own workspace, with workspace-linked
`node_modules` and (mostly) in-process calls into the runtime. None of them prove the product
works the way a brand-new user actually experiences it: a global `npm install`, project setup with
no prior knowledge of the repo, a monitor firing, and the signal reaching the agent through the
real, documented delivery transport. This surface closes that gap for the **hooks path**
([006 §5](./006-agent-integration.md)) — a global install of the packed `agentmonitors` launcher
into an isolated npm prefix with no workspace `node_modules` access, project bootstrap via
`agentmonitors init`, a `file-fingerprint` monitor firing, and `agentmonitors hook deliver` fed a
real Claude Code `UserPromptSubmit` stdin payload. Because `@agentmonitors/cli` and the
`agentmonitors` launcher package both declare a `agentmonitors` bin, installing them together makes
npm link that bin name to whichever package sorts first (`@agentmonitors/cli` always wins) — so
every CLI invocation in this surface runs the launcher package's own installed entry point directly
rather than that bin symlink, which is what actually exercises the launcher's `require.resolve`
indirection under a real global install.

**Verified in:** `scripts/test-e2e-fresh-install-hooks.mjs` (`pnpm test:e2e-fresh-install-hooks`,
wired into CI per-PR). The MCP/channel transport ([006 §4](./006-agent-integration.md)) has no
equivalent fresh-environment proof yet — tracked as a follow-up, not this surface's scope.

The packed Windows install check invokes package-manager JavaScript entrypoints through Node without a shell. Packing MUST use pnpm, including when the parent script was launched by npm: pnpm owns rewriting `workspace:` dependencies into installable versions. pnpm discovery MUST recognize `.cjs`, `.js`, and `.mjs` launchers in both official Node and adjacent PATH package installations, including under an npm launcher. npm installation MUST support JavaScript entrypoints discovered from PATH installations separate from Node as well as the official Node layout. Named Corepack `dist/pnpm.js` and `dist/npm.js` proxies are supported without substituting another manager. Every physical installation candidate, including official and adjacent layouts, MUST identify the requested manager; a mismatch continues discovery rather than masking a later valid installation. POSIX discovery uses exactly `PATH`; explicit empty components (including an empty `PATH`) mean discovery-time cwd, while an unset `PATH` does not imply cwd. Windows also accepts case variants such as `Path` and retains its existing empty-component behavior. Unusable PATH directories must not prevent discovery through later valid entries. Resolved JavaScript launcher paths MUST be absolute physical identities anchored at discovery time so changing a subprocess working directory preserves the selected file. Filesystem symlink traversal MUST be preserved: resolve existing directories before joining candidates, and use native physical canonicalization rather than lexically collapsing symlink/`..` paths. Physical PATH test controls use owned non-JS POSIX shell executables with explicit output and decoy failures, avoiding host utility alias restrictions. Command shims are never passed to a shell. Its isolated temporary root includes spaces so packing and installation exercise literal path arguments on every platform. `scripts/package-manager-compatibility.test.ts` verifies real workspace packing and a real npm subprocess in a separate installation on POSIX. Version probes substituted for installation MUST retain the installation working directory and environment so Corepack project selection reflects the real install context. Its fixture tools also use PATH-aware discovery and retain the POSIX pnpm executable fallback when no JavaScript launcher is discoverable; `scripts/package-manager-fixture.test.ts` executes that actual suite with Node isolated from npm to prevent fixture assumptions from hiding supported layouts. Windows CI verifies the native Windows path.

### 2.8 Suite-discovery integrity (zero-test guard)

A package-level test suite is only useful evidence if it can fail. Every test-bearing package's
vitest config MUST reject an empty/misconfigured run — vitest's own default,
`passWithNoTests: false` — rather than opting into `passWithNoTests: true`. Deleting, renaming, or
accidentally excluding an entire package's test files MUST fail that package's Nx `test` target,
never report a false green. This applies to the default `vitest.config.ts` of every publishable
package in the authoritative `PACKAGE_DIRS` inventory (`scripts/publish-release-packages.mjs`),
plus every named config wired into a CI test step — `apps/cli/vitest.serial.config.ts` (the serial
daemon-spawn suite) and `scripts/vitest.config.ts` (this guard's own home config) — both of which
already set this correctly and are the reference pattern the rest follow.

Because `apps/cli` splits its tests across two suites (a default parallel run and a serial run for
daemon-spawn tests that need CPU isolation — [§2.6](#26-cli-integration-tests)), those two suites
MUST also partition the package's test files without overlap (a file run by both wastes CI time
and can reintroduce the CPU-starvation flakiness the serial suite exists to avoid) or gaps (a file
run by neither is silently never executed).

**Verified in:** `scripts/vitest-pass-with-no-tests.test.ts` (dynamically imports every guarded
vitest config — the real module `vitest run` loads — and asserts none resolve to
`passWithNoTests: true`; the guarded set is derived from the authoritative `PACKAGE_DIRS` list in
`scripts/publish-release-packages.mjs` so a newly added publishable package is covered
automatically) and `scripts/cli-suite-partition.test.ts` (runs the real `vitest list` resolution
against both `apps/cli` configs and asserts the result partitions the package's git-tracked test
files with no overlap or gaps). Both run under `pnpm test:scripts`, wired into CI per-PR.

### 2.9 Test-run build ownership and first-attempt launcher gate

`apps/cli/dist` is a shared input to concurrently running suites: `nx run-many --target=test` runs
the CLI and launcher suites side by side, and the launcher executes that bundle. Because the CLI
build removes its output before writing it again, **a test MUST NOT start a package build**. A
target whose tests execute the CLI bundle declares its build as an Nx dependency, so the bundle is
complete before any consumer starts and is not rewritten until the next run.

The launcher suite (`apps/agentmonitors`) MUST pass on its first attempt and its config MUST NOT set
a retry budget. Its assertions MUST distinguish the CLI rejecting a subcommand from the CLI failing
to load: both exit 1, so an unknown-subcommand assertion requires the CLI's own error message. Each
subprocess bound MUST stay below the test's timeout, so a slow or hung launcher fails with its
status, signal and output rather than vitest's bare timeout.

Running a CLI test file directly with vitest bypasses the Nx dependency and executes whatever bundle
already exists; build first, or use `pnpm nx test @agentmonitors/cli`.

**Current, normative:** the core test target declares its own `build` alongside dependency
builds. Its runtime regression suite imports the real API source, whose runtime package imports
resolve to core's compiled exports. `pnpm nx test @agentmonitors/core` therefore MUST build core
before running tests, including when core's `dist` is absent and caching is disabled. The
`object-event-suppressions` suite must pass all 14 existing cases on its first attempt. Removing
only the own-build prerequisite under the same cold conditions must expose the package-entry
module-load failure; restoring it must restore the cold pass. Direct Vitest invocation bypasses
this prerequisite and requires a prior core build. Tests MUST NOT start builds themselves; the
source/test module graph remains unchanged.

**Current, normative:** the `source-incoming-changes` test target also declares its own `build`
alongside dependency builds. Its revision-expression tests execute both TypeScript source and
`dist/index.js`, so `pnpm nx test @agentmonitors/source-incoming-changes` MUST build core, then
the plugin, before running the suite. This ordering must hold with the plugin's `dist` absent
and Nx caching disabled; all 58 existing cases must pass on their first attempt. Removing only
the own-build prerequisite under the same cold conditions must expose the six compiled-surface
failures while the 52 source/control cases pass. A direct vitest invocation still requires a
prior build; tests MUST NOT start builds themselves.

**Verified in:** `scripts/cli-build-ownership.test.ts` (the CLI's `test` and `test:serial` targets
depend on `build`; no tracked test source starts a build), `scripts/vitest-launcher-retry.test.ts`
(the launcher config's resolved retry count is zero; run under `pnpm test:scripts`, wired into CI
per-PR), and `apps/agentmonitors/test/launcher.test.ts` (forced crash and hang cases prove the
evidence renders and the subprocess bound stays inside the test budget). The evidence that first
exposed the race is in
[`docs/work-records/2026-11-03-launcher-first-attempt-acceptance.md`](../work-records/2026-11-03-launcher-first-attempt-acceptance.md).
The incoming-changes cold-target check executes `src/index.test.ts`, `src/unavailable.test.ts`
and `src/revision-expressions.test.ts` in `plugins/source-incoming-changes`; the last suite's
compiled cases enforce that the Nx prerequisite produces a usable current artifact.

### 2.10 Repository pre-push gate

**Current, normative:** after installing the frozen lockfile with Node 24 and the pinned
pnpm, contributors on macOS/Linux (POSIX shell) MUST use `pnpm verify` for the portable pre-push gate. It runs these
root commands sequentially, stopping on failure: `build`, `check`, `check:api-report`,
`test`, `test:serial`, `test:scripts`, `test:standalone-consumer`,
`test:e2e-fresh-install-hooks`, and `publish:packages:dry-run`.

`verify` names an aggregate spanning build, tool checks, authored tests, and packaging;
`check:*` remains tool validation and `test:*` remains authored tests. `pnpm test` retains
its fast package-suite workload and MUST print its omitted suites and point to `pnpm verify`.
The aggregate preserves CI's test ordering: daemon tests run after the parallel suite,
with no overlapping packaging builds. The publish dry-run runs locally regardless of
CI's release-collateral path filter, and the duplicated CI `test:scripts` step runs once.
The dry-run reads the registry and packs artifacts without publishing; packaging tests
perform fresh installs and require network access.

Nx still schedules dependency builds and caches eligible package targets, including
`test:serial`. Use `NX_SKIP_NX_CACHE=true pnpm verify` for fresh execution evidence.
A green result means these commands succeeded on this host, subject to reported skips;
it is not proof of another OS, a fresh runner, or suites skipped for missing facilities.

The PR-alerting preset reduction tests require the external `jq` executable. Local
contributors without jq MAY omit those reductions, but Vitest MUST report an explicit
skip naming the omitted surface, never a passing no-op. CI without jq MUST fail; when
jq is present the real reduction cases MUST execute. Facility probes and canonical
filter executions use an asynchronous total verdict within the existing 1,000ms
per-command budget, including during test discovery. A hanging or broken executable
MUST fail visibly; only ENOENT permits the optional local omission. A no-input
version probe closes unused stdin without writing a payload. Explicit reduction
input, including an empty string, retains its delivery obligation: stdin transport
errors cannot be ignored or overridden by a successful command exit.

The script facility control executes the actual jq programs extracted from the shipped
preset templates directly against authored raw-GitHub fixtures. It does not start
command-poll observations or prove source/preset integration; those unchanged integration
cases remain in the normal CLI package suite run by `pnpm test` and `pnpm verify`.
Script test files run serially so nested Vitest/package-manager processes cannot
multiply outer worker pools. Package `pnpm test` scheduling and aggregate commands
remain unchanged. Each negative command-deadline phase selects one actual command
invocation; both positive canonical reductions still execute. The private fixture
allows 4 seconds for framework launch/import/report work plus the independently strict
1,000ms jq verdict: a 5-second complete-phase allowance. It requires the complete
end-of-run result for the intended module/test, a visible jq deadline failure, and
its sole owned jq terminal before fixture force-cleanup. Natural reporter/process
close is not the command outcome. Driver close and group-terminal confirmation have
a separate hard 1-second cleanup reservation, with harness margin in a 7-second test.
No partial/first-test error may stand in for the whole intended phase. The framework
allowance does not extend jq execution or child/query helper deadlines.
The facility driver's owned boundary covers its Node/jq process group, not production
observations that deliberately create separate groups. An error-free outermost return
requires bounded terminal-state confirmation for that known group (including Linux
zombie/dead states), rather than merely a SIGKILL request. Cleanup time is reserved
inside the existing total bound; child/parent deadlines are not increased. Late
terminal evidence cannot turn an expired confirmation into success. The same total
deadline owns execution, direct-child exit, pipe closure and confirmation: if a timeout
kill request never produces exit/close, the driver still returns a visible deadline
error, releases its readers and unreferences the child handle. Signal success and
handle release do not prove termination. If confirmation
fails, the driver releases inherited readers and returns the error rather than waiting
for the failed group's pipe closure; reader release is not termination evidence. The
Darwin membership query owns a separate direct child: its failure/deadline path must
release that child's streams and reference even if cancellation does not produce exit.
Late query callbacks remain handled and cannot authorize success or further scans.
On Linux, a listed proc entry disappearing with ENOENT does not establish group
termination: the fresh group probe must also establish absence. A still-present group
with no readable members remains unconfirmed until the existing deadline.

The partial-test notice calls out this facility-dependent coverage. A reported skip means that surface remains unverified.

The mandatory `test` job MUST NOT acquire unreviewed `needs` prerequisites: a skipped
path-filtered prerequisite can skip the job even when it has no explicit condition.
Guard regressions MUST preserve unrelated valid job metadata so each negative case
proves the intended execution or command obligation.

The explicit CI-only responsibilities are:

- Checkout, Node/pnpm provisioning, dependency installation, and GitHub event/path filters.
  Local installation is a prerequisite; local verification always runs release validation.
- `windows-install-check`: Windows build and packed CLI native-module installation require
  Windows. The hosted runner includes build tools, so even CI does not prove toolchain-free
  installation.
- `website-link-check`: website build and internal-link validation remain a separate,
  path-filtered CI gate. Root build/check/format/lint exclusion is unchanged; the existing
  website unit tests are already included by root `pnpm test`.

The independent `.github/workflows/dependency-audit.yml` is a separately guarded
exclusion from `pnpm verify`. Its daily security cadence, path-filtered PR/main triggers,
and advisory guarantee remain unchanged. Run `pnpm check:dependency-audit` separately
for the live production and bundled-code advisory gate. **Current, normative:** the
gate builds each published tsup package sequentially into a new temporary directory
with `--metafile` and derives bundled packages from inputs contributing bytes to
outputs. This covers default-inlined development imports, explicit `noExternal`
imports and injected third-party code (for example tsup's `cjs_shims`). Package
identities must match exact locked versions. `noExternal` remains declared intent;
absent selectors are reported without failing. Build failure, missing output or
metadata, unsupported build/lockfile shapes and audit endpoint failures fail closed.
CI installs first; the gate performs a serialized workspace build with Nx caching
disabled to refresh internal package exports before producing temporary metafiles.
For example, CLI bundling must consume fresh core output, even on a clean checkout.
It never relies on pre-existing `dist` and does not need a separate CI build step. Production
advisories and exact bundled-version findings from a full audit share the scoped,
expiring allowlist; unbundled development advisories remain excluded. Loopback-only
script regressions build real default imports, injected shims and plugin inputs,
reject their synthetic high advisories, preserve explicit-selector/alias coverage,
and prove failed current builds cannot fall back to stale metadata.
`test:scripts` exercises audit fixtures and
version-floor regressions; it does **not** substitute for a live advisory query. The
parity guard pins the excluded workflow's known `pnpm check:dependency-audit` command
and rejects unfamiliar executable steps/contexts rather than silently excluding additions.

Docker smoke is **not** a separate job: `test:serial` discovers it on both hosts, but it
self-skips without a reachable Docker daemon. Report this as unverified Docker coverage
when running locally without Docker; CI's Ubuntu runner normally executes it.

**Human decision pending:** whether website validation should join the root gate.
Recommendation: keep the site build/link checks separate and path-filtered, then add
executable documentation-example checks before claiming semantic documentation correctness.
The existing link checker cannot catch a CLI example missing a required argument.
Website changes need separate build/link and example verification meanwhile.

**Verified in:** `scripts/local-gate.test.ts` reads the real CI workflow and package scripts,
rejects missing local commands (including the old build/check/test gate), unclassified jobs,
new executable steps in excluded jobs, skipped or failure-tolerant portable steps, and
local failure masking or parallel execution. Changes to the command contract or exclusions
MUST update this guard and the documented coverage together.

### 2.11 Docker smoke diagnostic capture (current)

The Docker smoke fixture MUST allow a successful install/build phase emitting more than 20 MiB
while preserving the caller's literal success markers. Phase volume is written to container-local
logs; the outer combined 20 MiB capture limit remains a failure boundary for runaway outer output,
including a zero exit with all markers. Named ordinary failures MUST include recent phase and daemon
evidence with byte-bounded tails, including single-line logs.

During active work, a bounded periodic stream MUST retain recent phase/daemon evidence before forced
removal when diagnostic retrieval fails. This samples history rather than preserving every byte:
output after the last sample can be lost on SIGKILL. Current sampling emits at most 240 one-second
snapshots of two 8 KiB tails, plus final phase/failure tails. Container-local full logs are temporary
and can grow with command output; this is an outer-capture bound, not a disk quota.

The unchanged 300s caller budget includes 210.5s execution, 59.5s logical retrieval/cleanup, and a 30s
reporting reserve. Tests MUST retain pre-creation client termination, late removal retries, and
reason-specific failure reporting. These bounds assume ordinary OS scheduling and client reaping;
they do not establish repeated-CI reliability or protection from arbitrary Docker/server stalls.

**Verified in:** `apps/cli/src/commands/smoke-shell.test.ts` (21 MiB success, ordinary failure,
abrupt active termination), `smoke-container.test.ts` (retrieval failure, retained diagnostics,
270s logical completion, cleanup and zero-exit overflow rejection), and `cli.docker.test.ts`
(the complete container workflow).

### 2.12 Admission boundaries through diagnostics and asynchronous parsing (current)

Admission regressions MUST exercise the actual built CLI formatting path, in text
and JSON modes, rather than stopping at scanner results. An oversized monitor
must not be reopened for migration advice. Optional hint reads must stay bounded
when an ordinary invalid file grows or is replaced after discovery; assertions
cover MAX+1 bytes, descriptor closure, valid siblings, exact boundaries, and the
positive legacy source/scope hint.

Exported collection schemas MUST reject raw non-arrays consistently in sync and
async parsing. A Promise resolving to a valid or oversized array is not another
input format. Tests cover direct Shape and frontmatter fields, thenable controls,
array type versus admission diagnostics, and zero element visits or CEL compilation
for rejected inputs. Synchronous probes must not leave unhandled rejections.

Verified in `apps/cli/src/commands/validate-admission.test.ts` and
`libs/core/src/schema/input-limits.test.ts`. Tests consume prebuilt artifacts under
§2.9; narrow repair reversions must reproduce each admission failure independently.

## 3. Required Test Scenarios

The spec set is incomplete unless each major rule has at least one concrete testable scenario. The table below maps each scenario to the test file that covers it, or flags it as a gap.

### 3.0 Gap markers

A scenario that is not yet fully covered carries a marker with a tracked id, written in bold as `TEST GAP T<n>` (no coverage) or `PARTIAL GAP T<n>` (some coverage, with what remains stated). When the coverage lands, replace the marker with the exact test file and `describe › it` names. `roadmap.md` ("Test gaps") lists a gap as closed with a bullet that starts with the bold id (for example T1) followed by an em dash; an open one adds `(open)` after the id. `scripts/spec-gap-drift.test.ts` (run by `pnpm test:scripts`) fails when a numbered spec still carries a marker for a gap the roadmap lists as closed, when a marker has no id, or when a spec cites a test file path that does not exist. No gap marker is open today.

### 3.1 Monitor authoring and parsing

| Scenario                                         | Coverage                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid full monitor parses successfully           | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "parses valid full monitor")                                                                                                                                               |
| Minimal valid monitor parses successfully        | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "parses minimal valid monitor")                                                                                                                                            |
| Body trimming is preserved                       | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns body content as instructions (trimmed)")                                                                                                                          |
| Invalid top-level schema fields fail clearly     | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns error for invalid frontmatter values"; `libs/core/src/schema/monitor-schema.test.ts` — "rejects invalid urgency", missing-required-field cases)                   |
| Invalid notify config fails clearly              | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns error for invalid notify config"; `libs/core/src/schema/monitor-schema.test.ts` — "rejects debounce without settle-for", "rejects throttle without suppress-for") |
| File path and directory-derived ID are preserved | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "derives id from parent folder name", "preserves filePath in error result")                                                                                                |
| `low` urgency is accepted as valid               | Covered (`libs/core/src/schema/monitor-schema.test.ts` — `monitorFrontmatterSchema` › "accepts all urgency values" iterates `['low', 'normal', 'high']` and asserts each parses)                                                   |

### 3.2 Source-specific behavior

| Scenario                                                                                                                                                                                                                                                                                                                                         | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stateful baseline returns no first-run observations (file-fingerprint)                                                                                                                                                                                                                                                                           | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "returns no observations on first run (baseline)")                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Stateful baseline returns no first-run observations (api-poll)                                                                                                                                                                                                                                                                                   | Covered (`plugins/source-api-poll/src/index.test.ts` — "returns no observations on first poll (baseline)")                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Changed file content emits file-fingerprint observations                                                                                                                                                                                                                                                                                         | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "detects file changes on subsequent runs")                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Unchanged file content does not emit observations                                                                                                                                                                                                                                                                                                | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "returns no observations when files have not changed"; `plugins/source-api-poll/src/index.test.ts` — "returns no observations when response is unchanged")                                                                                                                                                                                                                                                                                                                                       |
| `text-diff` strategy detects response body changes                                                                                                                                                                                                                                                                                               | Covered (`plugins/source-api-poll/src/index.test.ts` — "detects response changes on subsequent polls (text-diff)")                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `json-diff` strategy ignores whitespace differences                                                                                                                                                                                                                                                                                              | Covered (`plugins/source-api-poll/src/index.test.ts` — "json-diff: ignores whitespace differences in JSON")                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Explicit `json-diff` on a non-JSON body emits a warning                                                                                                                                                                                                                                                                                          | Covered (`plugins/source-api-poll/src/index.test.ts` — "warns when json-diff is configured but the body is not JSON"; "redacts credentials, query, and fragment from the non-JSON warning URL")                                                                                                                                                                                                                                                                                                                                                                 |
| `api-poll` body-diffing strategies reject non-2xx responses as errors                                                                                                                                                                                                                                                                            | Covered (`plugins/source-api-poll/src/index.test.ts` — "non-2xx → errored observation (issue #220)"; `apps/cli/src/commands/cli.integration.test.ts` — "api-poll over a real endpoint (#219, #220)")                                                                                                                                                                                                                                                                                                                                                            |
| `status-code` strategy detects status change, ignores body                                                                                                                                                                                                                                                                                       | Covered (`plugins/source-api-poll/src/index.test.ts` — "status-code: detects status change, ignores body change")                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Schedule source emits one observation whenever invoked                                                                                                                                                                                                                                                                                           | Covered (`plugins/source-schedule/src/index.test.ts` — "fires an observation when called")                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Missing required source config field throws clearly                                                                                                                                                                                                                                                                                              | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "throws on missing globs config"; `plugins/source-api-poll/src/index.test.ts` — "throws on missing url"; `plugins/source-schedule/src/index.test.ts` — "throws on missing cron config")                                                                                                                                                                                                                                                                                                          |
| `api-poll`/`command-poll` `timeout` request/body deadline is enforced and validated (issue #304, §4.9/§11.1)                                                                                                                                                                                                                                     | Covered (`plugins/source-api-poll/src/index.test.ts` — "request/body deadline" suite; `libs/core/src/notify/notifier.test.ts` — `parseOperationTimeoutMs` suite; `plugins/source-command-poll/src/schema-parity.test.ts` — timeout cases)                                                                                                                                                                                                                                                                                                                       |
| Response body size cap enforced (declared `Content-Length` and streamed count), exempt for `status-code` (issue #304, §4.9)                                                                                                                                                                                                                      | Covered (`plugins/source-api-poll/src/index.test.ts` — "request/body bounds (issue #304)" suite, "status-code" byte-cap exemption cases)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Composite concurrency is bounded and fails fast, aborting in-flight siblings (issue #304, §4.9)                                                                                                                                                                                                                                                  | Covered (`plugins/source-api-poll/src/index.test.ts` — "composite concurrency (003 §2.6)"; `plugins/source-api-poll/src/map-with-concurrency.test.ts` — "fail-fast + sibling abort (issue #304 review finding 3)")                                                                                                                                                                                                                                                                                                                                              |
| Composite cumulative rendered-artifact byte budget is enforced across all parts (issue #304 review, second + third round, §4.9)                                                                                                                                                                                                                  | Covered (`plugins/source-api-poll/src/index.test.ts` — "composite cumulative byte budget (issue #304 review, second + third round)")                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Composite part count and part-`id` length are capped, in both schema and parser (issue #304 review, third round, §4.9)                                                                                                                                                                                                                           | Covered (`plugins/source-api-poll/src/index.test.ts` — "composite part-count and part-id bounds (issue #304 review, third round)", including the reviewer's two repro shapes: 100,000 empty-body parts and an 11 MiB `id`)                                                                                                                                                                                                                                                                                                                                      |
| `command-poll` timeout escalation bounds a group member forked after the SIGTERM step (a TERM trap that starts a worker and exits): the read at the leader's exit confirms it and the SIGKILL follow-up removes it (issue #479, 008 §3.1/§5.1)                                                                                                   | Covered (`plugins/source-command-poll/src/identity-verified-cleanup.test.ts` — "SIGKILLs a descendant the command forks from its TERM trap after the SIGTERM step"; gate unit case "confirms a process forked after the SIGTERM step through the read taken as the leader is reaped" in `libs/core/src/process/process-identity.test.ts`)                                                                                                                                                                                                                       |
| `command-poll` timeout escalation bounds a process that a TERM-ignoring group member forks during the grace period and then exits, as long as the member is alive at a grace-period reading after the fork: the readings every 250 ms confirm it through its parent and the SIGKILL follow-up removes it (issue #479, 008 §3.1/§5.1)             | Covered (`plugins/source-command-poll/src/identity-verified-cleanup.test.ts` — "SIGKILLs a process a TERM-ignoring member hands off to during the grace period"; gate unit case "confirms a hand-off through a reading taken while parent and child coexist" in `libs/core/src/process/process-identity.test.ts`)                                                                                                                                                                                                                                               |
| Grace-period membership tracking reads one at a time on a fixed interval; stops at the next step (after a reading in flight lands), on an empty reading, on lost continuity, at `untilMs` and on abort; treats an unreadable or failing reading as confirming nothing without stopping; and never keeps the process alive (issue #479, 008 §5.1) | Covered (`libs/core/src/process/process-identity.test.ts` — "sendVerifiedSignal: grace-period membership tracking" suite, against fabricated tables and fake timers)                                                                                                                                                                                                                                                                                                                                                                                            |
| The `command-poll` SIGTERM step still signals the group when the command exits during the step's own process-table read (issue #479, 008 §5.1)                                                                                                                                                                                                   | Covered (`plugins/source-command-poll/src/identity-verified-cleanup.read-window.test.ts` — "signals the group and leaves nothing alive when the command exits at …, mid-read"; gate unit case "the SIGTERM step still signals when the leader exits during its own read")                                                                                                                                                                                                                                                                                       |
| A process group whose continuity is lost (none of its current members was ever confirmed: the id was reused after the group emptied, or a member handed the group to a process no reading saw beside a confirmed member) or whose process table cannot be read is never signalled, and the abstention is reported (issue #479, 008 §5)           | Covered at the gate level only, against a fabricated process table: a real reused group id needs the pid space to wrap, and a real unseen hand-off depends on landing inside one tracking interval (`libs/core/src/process/process-identity.test.ts` — "withholds the signal when the recorded pgid is now held by unrelated processes (recycled id)", "still abstains when continuity is lost (…): no current member was ever confirmed" for both causes, "stops once continuity is lost, and confirms nothing from that reading", the unreadable-table cases) |
| The Linux `/proc` reader drops only processes that exited mid-read (ENOENT/ESRCH); any other read error makes the reading unsupported, and reads are concurrency-bounded (issue #479, 008 §5.1)                                                                                                                                                  | Covered (`libs/core/src/process/process-identity.test.ts` — "readLinuxProcessTable error handling" suite, with an injected filesystem)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `command-poll` TERM → KILL escalation still reaches a TERM-ignoring group member after the leader exits, and an emptied group gets no SIGKILL (issue #479, 008 §3.1/§5)                                                                                                                                                                          | Covered (`plugins/source-command-poll/src/identity-verified-cleanup.test.ts` — "still SIGKILLs a confirmed group after its leader exits", "a timed-out command whose whole group exits on SIGTERM needs no SIGKILL")                                                                                                                                                                                                                                                                                                                                            |

### 3.3 Runtime delivery

| Scenario                                                                                                                               | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source state survives runtime restart                                                                                                  | Covered (`libs/core/src/runtime/service.test.ts` — "persists source state across runtime restarts and emits changes later")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| High urgency waits for settle window before interruptible delivery                                                                     | Covered (`libs/core/src/runtime/service.test.ts` — "claims high-urgency deliveries after the debounce window and updates hook state"; "emits all debounced high-urgency observations after the settle window")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Normal urgency coalesces — second delivery not offered until session is acknowledged                                                   | Covered (`libs/core/src/runtime/service.test.ts` — "coalesces normal-urgency reminders until unread events are acknowledged")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Low urgency delivers only at idle lifecycle points                                                                                     | Covered (`libs/core/src/runtime/service.test.ts` — "defers low-urgency delivery until idle lifecycle points")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Recap emits recent unread events and command hints                                                                                     | Covered (`libs/core/src/runtime/service.test.ts` — "returns recap deliveries after post-compact with recap messaging")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Events project only into matching workspace sessions                                                                                   | Covered (`libs/core/src/runtime/service.test.ts` — "projects events only into matching workspace sessions and supports scope filters"; `apps/cli/src/commands/cli.integration.test.ts` — "projects events only to the lead session when a subagent session exists")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Scope filters query `queryScope` correctly                                                                                             | Covered (`libs/core/src/runtime/service.test.ts` — "projects events only into matching workspace sessions and supports scope filters")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Hook state reflects pending and unread counts correctly                                                                                | Covered (`libs/core/src/runtime/service.test.ts` — "claims high-urgency deliveries after the debounce window and updates hook state"; `libs/core/src/hook-bridge/bridge.test.ts` — `computeHookState` suite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cron timezone matching works correctly                                                                                                 | Covered (`libs/core/src/runtime/service.test.ts` — "matches schedule cron expressions in the configured timezone")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| An invalid schedule timezone is isolated to that monitor, not the whole tick (issue #297)                                              | Covered (`libs/core/src/runtime/service.test.ts` — "isolates an invalid schedule timezone so a sibling monitor still emits (issue #297)"; `apps/cli/src/commands/cli.integration.test.ts` — "isolates an invalid schedule timezone instead of aborting the whole tick, so a sibling monitor still emits")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `monitor.explain` renders an invalid schedule timezone as a diagnostic failure, not a crash (issue #297)                               | Covered (`libs/core/src/runtime/service.test.ts` — "explains an invalid schedule timezone as an observation-stage failure, not a crash (issue #297)"; `apps/cli/src/commands/cli.integration.test.ts` — "explains an invalid schedule timezone as a definition-stage failure instead of crashing")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `doctor` reports an invalid schedule timezone as invalid without crashing (issue #297)                                                 | Covered (`libs/core/src/runtime/doctor-report.test.ts` — "reports an invalid schedule timezone as invalid without crashing, isolated from a healthy sibling (issue #297)")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `validate`/`monitor test` reject an invalid IANA schedule/rollup timezone at authoring time (issue #297)                               | Covered (`libs/core/src/schema/validate-scope.test.ts` — `validateWatchScope` schedule-timezone suite; `libs/core/src/schema/monitor-schema.test.ts` — "rejects a rollup monitor with an invalid IANA timezone"; `apps/cli/src/commands/cli.integration.test.ts` — "rejects a schedule monitor with an invalid IANA timezone, alongside a valid sibling" (`validate`), "rejects a schedule monitor with an invalid IANA timezone" (`monitor test`))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| An unserializable held observation (BigInt or cycle) is refused at hold acceptance without stopping its monitor (002 §4.7, issue #570) | Covered (`libs/core/src/runtime/notify-hold-serializability.test.ts` — debounce and rollup × BigInt and cycle × restart: `errored` outcome in history and `erroredObservations`, batch siblings held in order, baseline advances, later observations materialize; watch-path `onError`; notify-edit drain after a refusal; refusal row and state committed in the span's admission transaction, with a rolled-back span recording and reporting no refusal and a failed refusal-row write rolling the span back; a refusal not counted as held work, so a rejected definition leaves a running watcher's gate open (`edit-drain-admission-outcomes.test.ts`); a span mixing a refusal, an admitted observation and an unretainable drop counted once each in its batch row, with both losses outstanding)                                                                                                                                                                                       |
| Held debounce/rollup work flushes on time while its source fails; the failure stays visible (002 §2.6, issue #558)                     | Covered (`libs/core/src/runtime/held-work-source-errors.test.ts` — debounce deadline and rollup window reached while every `observe()` rejects, with no new observation; captured content, urgency, observation time, baseline and `lastObservationAt` preserved; no event from the error or a source with nothing held; the newest history row and explain stay `errored`/failure beside the flush; close/reopen; a permanently unavailable source flushes once and never re-delivers; a failed flush write keeps the batch held for the next tick; sibling progress; same id in another workspace untouched; a cron-scheduled source's next due tick (debounce) and not-due window check (rollup); schema-invalid, missing, and rejected-in-flight definitions keep the work held; a SIGKILLed child process after the flush commit leaves the flush durable and the next tick re-records the failure. `libs/core/src/runtime/source-error-state.test.ts` — the same across reopen and retry) |
| Subagent sessions do not receive events projected to the lead session                                                                  | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "projects events only to the lead session when a subagent session exists")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 3.4 Persistence and snapshotting

The `RuntimeStore.saveSnapshot()` and `RuntimeStore.latestSnapshot()` methods (in `libs/core/src/runtime/store.ts`) implement snapshot storage keyed by `(workspacePath, monitorId, objectKey)`. The `materializeObservation` method in `libs/core/src/runtime/service.ts` uses these to retrieve the prior snapshot and compute a `diffText` before atomically saving the event, projections/cursor seeds, and snapshot.

| Scenario                                                                    | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshotText` stores a later-retrievable snapshot                          | Covered (`libs/core/src/runtime/service.test.ts` — "stores and retrieves snapshots isolated by workspace, monitor, and object key"; "computes a diff against the prior snapshot when an object changes").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A prior snapshot produces diff text on later change                         | Covered (`libs/core/src/runtime/service.test.ts` — "computes a diff against the prior snapshot when an object changes"; "renders a structural json-diff diffText for a real observation routed through materializeObservation").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Snapshots are isolated by workspace, monitor, and object key                | Covered (`libs/core/src/runtime/service.test.ts` — "stores and retrieves snapshots isolated by workspace, monitor, and object key").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Event, projection/cursor, and snapshot writes roll back together            | Covered (`libs/core/src/runtime/transactional-materialization.test.ts` — injected cursor and snapshot failures leave no event, projection, cursor, or snapshot).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Retry outbox survives reopen with route and envelope intact                 | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — ordered envelopes and timestamps round-trip through an on-disk database reopen).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Retry outbox capacity is batch-atomic and workspace-scoped                  | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — exact 256-row and 8 MiB UTF-8 boundaries, competing connections, two-sibling count/aggregate-byte overflow with no partial batch, and independent monitor/workspace scopes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Retry envelopes round-trip without silent data conversion                   | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — BigInt, negative zero, nested/customized Date, non-Date observedAt, and accessor/proxy values fail with a domain error before any sibling is written; altered-prototype built-in brands are rejected; route getters and direct or inherited proxy traps never run).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Retry errors are safe and bounded                                           | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — C0/DEL controls are stripped and persisted errors are capped at 1,024 characters).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Retry backoff terminalizes and requires explicit re-arm                     | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — due filtering, fixed delays, five-attempt terminal state and re-arm; `retry-lifecycle.test.ts` — subsecond deadlines never shorten delays, typed lifecycle failures, callback non-execution, real snapshot/deletion fault rollback, failed-update sanitization and failed/terminal/rearmed/completed states across on-disk reopen).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A terminal retry is repaired by re-arm or skip, and only a terminal one     | Covered (`libs/core/src/runtime/retry-repair.test.ts` — re-arm then success with later input in order, re-arm then failure, re-arm and skip across a store reopen, skip records the loss with its reason and resumes the monitor, a failed loss write keeps the retry and records nothing, younger retained work drains next and supersedes the skipped key, a later event of another key does not, refusal of a pending retry and of another monitor/workspace/unknown id with nothing changed, a skip reason over 200 characters refused with nothing changed, a long last error shortened with `…` while the skip note and a full-length reason survive, a paused watcher woken by re-arm and by skip; `apps/cli/src/retry-repair.test.ts` — the built CLI against a real `daemon run` for re-arm then success, re-arm then failure and skip, each with one daemon and across a daemon restart, refusals through the daemon and in-process, a reachable daemon's error reported and never applied in-process, a daemon that received the request and replied after the client timeout or dropped the connection reported as an unknown outcome with nothing written, and the in-process path running the re-arm `doctor` suggests; `apps/cli/src/daemon-ipc.test.ts` — a connection failure marked unsent, and a timeout, a dropped connection and a half-written reply after the request marked sent). |
| A stopped monitor's tick report, explain and doctor name both repairs       | Covered (`libs/core/src/runtime/retry-repair.test.ts` — tick `erroredObservations` and the explain materialization reason; `apps/cli/src/retry-diagnostics.test.ts` — doctor text and JSON for an attached, orphaned and ephemeral terminal retry, scoped with `--workspace`; `apps/cli/src/retry-repair.test.ts` — `daemon once` output, the doctor remediation run as written, and the skip's `monitor explain` hint for a quoted monitor id and a workspace path with spaces run verbatim through `sh` from another directory).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Every follow-up inspection hint keeps leading-hyphen monitor IDs positional | Covered (`apps/cli/src/retry-repair.test.ts` — nine follow-up regressions execute skip-success, both unknown-outcome hints and doctor explain/history hints for attached drops, pending/terminal retries, orphan drops and orphan retained work verbatim through `/bin/sh` from another directory; the reported retry or loss is read without changing it. `libs/core/src/commands/shell-arguments.test.ts` preserves existing runtime repair command bytes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A repair of a retired verify artifact's terminal retry is cleanup, not loss | Covered (`libs/core/src/runtime/retry-repair-retired-artifact.test.ts` — re-arm and skip of a terminal row whose verify artifact has cleanup authority remove it with no loss row and no `errored` row, never re-arm it, `doctor` reports no dropped observation and the monitor resumes with newer input, a paused watcher woken by the skip; controls for an unregistered scratch-looking key, the key retired only in a foreign workspace, and an artifact still in its proof phase, where skip records the loss and re-arm re-arms; `apps/cli/src/retry-repair.test.ts` — the built CLI re-arming and skipping such a row through a real `daemon run` and in-process, with the cleanup text and JSON `outcome`, no loss in `doctor`, and newer input after restart; unregistered and foreign-workspace controls that still record the loss).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Retained retry diagnostics survive unusable definitions and stay isolated   | Covered (`libs/core/src/runtime/retry-diagnostics.test.ts` — all explain early returns, removed/parse-failed/duplicate doctor outboxes, same-id workspace and NULL-scope isolation, omitted-workspace fallback, 257 rows across two monitors, metadata privacy/order and read-only state preservation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Retry summaries never expose captured envelopes or payloads                 | Covered (`libs/core/src/runtime/retry-outbox.test.ts` and `retry-diagnostics.test.ts` — explicit safe metadata shape and private captured-input sentinels absent across reports).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Retry CLI/IPC diagnostics are covered by `apps/cli/src/retry-diagnostics.test.ts`: real socket
roundtrips revive distinct created/updated/next-attempt Dates for explain, doctor attached summaries
and orphan groups; older-daemon omissions work in both commands and formats. Its CLI subprocesses run the shared Nx-built
`apps/cli/dist/index.cjs` (built by `nx test`'s dependency, never rebuilt by the test, per §2.9).
No retries or timing delays mask artifact ownership. Built CLI text/JSON
preserve missing/invalid/duplicate definition errors and retained IDs exactly once, normalize legacy
unsafe errors, exclude private metadata fields and other workspaces, and leave durable state unchanged.

### Snapshot materialization order

`runtime/snapshot-materialization-order.test.ts` verifies that the diff predecessor is
selected by committed insertion order, not timestamp/ULID order. Two actual child
processes prime genuine snapshot ULID factories in private databases under an identical
clock; the parent commits the higher-ID writer first and the lower-ID writer second,
awaiting process exit at each barrier. An already-open independent connection and a fresh
reader process must both return the second snapshot, giving the adjacent B→C diff.
No stored IDs are replaced. Children have bounded lifetimes and their exits are awaited.

Additional cases cover wall-clock reversal, rolled-back and rejected writes, deletion of
the newest/all rows followed by insertion, `VACUUM` and reopen, legacy rowid bootstrap
with unchanged public data/indexes/triggers and no replayed trigger effects, migration
idempotence, and simultaneous first-open migration. The existing transactional
materialization suite retains event/projection/cursor/snapshot rollback coverage.

`inbox/db.migration.test.ts` additionally requires the coordinated event/snapshot
rebuild to preserve cross-table triggers in both directions, mutual dependencies,
third-table dependencies, quoted names and only-one-legacy-table cases. Ordinary
triggers remain controls. Assertions retain exact stored trigger/index SQL, public
rows and logical references, compatibility metadata and pragmas, prohibit copy-time
trigger replay, exercise explicit behavior after open/reopen, and require no schema
churn on an already-current open. Native duplicate-table DDL faults at the second
rebuild and trigger restoration boundaries must roll back the whole original schema,
rows, indexes, trigger definitions and metadata; tests inject real SQLite DDL rather
than a fabricated error or public fault-injection API.

`inbox/db.released-shapes.test.ts` requires opening a database in each `monitor_events` /
`monitor_snapshots` layout a released version created (0.0.1–0.3.0 with `event_kind`,
0.4.0–0.8.0, 0.9.0–0.13.0 with `baseline_strategy`) to succeed with every event and
snapshot row and value intact, including an index on the legacy-only `event_kind` column
and operator-added columns, indexes and a trigger on both tables. Each column carries a
distinct value so a dropped or reset column fails. Indexes and triggers keep their exact
stored SQL, the current writer can insert afterwards, and a reopen does not rebuild again.
A carried column keeps its declared type and default and loses only its collation and a
`NOT NULL` without a default. A rebuild that cannot complete (a generated column; a retained
row with `NULL` in a required column; a `UNIQUE` or `PRIMARY KEY` constraint other than the
lone `id` key, including a rowid alias; a `CHECK` or `REFERENCES` constraint; a `STRICT`
table) must fail with an error naming the table, and the column when one is identifiable,
and leave the database's schema and rows unchanged (002 §5.2 lists what is preserved, lost
and refused).

### Equal-time event order

`runtime/event-materialization-order.test.ts` uses two genuine independent event ULID
factories and controlled commit order at the same clock. Pending/unread queries, event
listings, pure net selection, actual runtime preview, capped claim, suppression and
claimed cursor must agree on the later commit. Private sequences must not appear in
public event records. A high/normal coalescing case checks that concatenating bands
cannot reverse an equal-time endpoint; the mutating boundary reloads canonical stored
records and rejects unknown/duplicate IDs before side effects. Unequal observed times
retain their existing primary order.

Additional cases cover transaction rollback, caller-modified artifact rejection, legacy
migration with unchanged projections/snapshots/cursors/indexes/triggers, no replayed
trigger effects, deletion/reinsert, VACUUM/reopen and simultaneous migrating writers.
Direct public-boundary cases also cover incremental/single-net recipient views whose
delta differs from shared history, raw shared inputs, lifecycle preservation, forged or
other-recipient overlays, and a legitimate stale delta after re-anchoring. These must
resolve to the requested recipient's current persisted projection without trusting
caller-provided delta text. Lifecycle-only session list views must retain their shared
diff for incremental and single-net events; lifecycle presence does not select a
recipient delta. Existing net and hook-cap suites continue to cover per-recipient
delivery semantics.

### 3.4.1 Real daemon crash recovery

`apps/cli/src/commands/daemon-crash-recovery.integration.test.ts` exercises a built CLI daemon
with its own temporary workspace, user-data directory, database, and socket. It observes a real
file change into a lead session, waits for the unread event, kills the owned daemon with SIGKILL,
and explicitly starts a replacement on the same database. It verifies that doctor reports the
dead daemon with a registered session, reopening the same host-session identity retains its
session id and exact unread event, and delivery leaves that event unread until explicit acknowledgment.
The test is registered in the serial configuration; child exits are awaited before fixture removal.
This proves recovery of already-persisted recipient work, not automatic process supervision,
uncommitted observation recovery, power-loss durability, or the pending materialization-retry stack.
| First/later failures produce truthful committed results | Covered (`libs/core/src/runtime/atomic-ingest-retry.test.ts` — exact ids, errors, history, outbox order, and Interpret calls for event, projection, cursor, and snapshot faults). |
| State/outbox failure rolls back the ingest batch | Covered (`libs/core/src/runtime/atomic-ingest-retry.test.ts` — post-write state and outbox faults leave no events/retries, preserve the source baseline, and replay after restart). |

| Whole poll span precedes first Interpret | Covered (`libs/core/src/runtime/poll-admission.test.ts` — independent connection sees three same-object transitions including empty text, two recipients, and the ordered retry suffix while the first adapter invocation is suspended). |
| Admission rollback preserves source, notify and committed cache | Covered (`libs/core/src/runtime/poll-admission.test.ts` — state/outbox faults preserve held notify work and prior recipient cache, leave no partial projections/cursors/snapshots, and replay on reopen; held-only admission also rolls back). |
| Native SQLite whole-transaction rollback differs from local ABORT | Covered (`libs/core/src/runtime/poll-admission.test.ts` — a later-event trigger first proves the new prefix exists, then real ROLLBACK preserves fresh/held source state and prior rows/cache, including a nonempty committed recipient cache. No suffix/checkpoint escapes; error-only audit and no Interpret precede complete replay from a forced-due reopened runtime. Real ABORT retains a committed prefix and ordered retry suffix). |
| Held retries retain their captured source after a source-type edit | Covered (`libs/core/src/runtime/poll-admission.test.ts` — actual debounce/rollup holds plus a real later-event ABORT preserve the captured route, instructions, urgency, content and timestamps, retain the opaque source baseline and reopen exact retry/state records; corresponding successful-materialization controls remain green). |
| Retry backoff starts at enqueue, not tick start _(current)_ | Covered (`libs/core/src/runtime/poll-admission.test.ts` — an observation at `12:00:00.000` admitted at `12:00:03.850` stores first deadlines of `12:00:05.000`, not an already-due `12:00:01.000`; observation, event, envelope, source and notify timestamps stay at observation time). |

| Unretainable retry suffix still reaches one outcome per observation and advances the baseline _(current)_ | Covered (`libs/core/src/runtime/unretainable-suffix-admission.test.ts` — real ticks with native `RAISE(ABORT)`: a 301-record suffix over the 256-record outbox commits 599 events (both recipients), one in-transaction `errored` row naming capacity and the advanced baseline, failing `explainMonitor`'s verdict and doctor's rollup through a later span of other keys until a later event for `object-299`; a single span whose suffix exactly fills the 256-record outbox is retained whole, while one record over is `errored` (a span is only admitted into an empty outbox, 002 §2.7), and both drain once the fault clears; a BigInt payload and a non-serializable later sibling are `errored` while siblings materialize. Every case asserts each observation is in exactly one of event/retry/`errored`, and that the next tick progresses). |
| A dropped (unretained) observation is never less visible than a retained one _(current)_ | Covered (`libs/core/src/runtime/unretainable-suffix-admission.test.ts` — real ticks with native faults: the drop row names the observation's position, span size, `objectKey` and `title`, with no payload and bounded control-free text; the span's batch row carries `notRetainedCount`; `explainMonitor`'s verdict fails at materialization and `doctorReport` attaches `unretainedObservationLoss`, kept across a later observe failure and accumulated by a later drop; a retained and a dropped failure both fail explain and doctor) |
| An outstanding drop is cleared only when superseded _(current)_ | Covered (`libs/core/src/runtime/unretainable-suffix-admission.test.ts` — a keyed drop survives a `no-change` tick, an observe failure, a retained-only later span and a later span of other keys, and clears on a later event for its key, including a later sibling of its own span; the same key from another monitor or workspace does not clear it; a retry admitted before the drop that completes after it does not clear it, while a newer observation of the key, a retry admitted after the drop (with no event between them) and a retained later sibling of the dropping span do once they complete; an unkeyed drop survives quiet ticks and a later span that drops again, and clears on a later span that materializes and drops nothing; a rollup hold keeps it and the flush that materializes its key clears it; it survives reopening the store; a removed, unparseable or duplicated definition reports it in `orphanedMonitorWork` (with no invented retry summary) and an invalid one on its rollup; a live ephemeral monitor's drop and retained work are attributed to it in `ephemeralMonitorWork` and move to `orphanedMonitorWork` as `monitorKind: "ephemeral"` once it is cancelled; a monitor whose source config the preflight now rejects is skipped without observing, dropping or retaining, keeps its drop on its invalid rollup (not orphaned), reports it in explain beside the definition-failure verdict, and clears it once the corrected config observes the key; a drop beside pending events that predate an edited definition fails explain at materialization while the delivery stage notes the stale events. `libs/core/src/inbox/db.migration.test.ts` — a pre-#497 store, with and without event `sequence`, gains the drop and admission columns and the three indexes on open and reports a drop recorded afterwards; a pre-`sequence` table holding `definition_fingerprint` and `admission_sequence` keeps both values through the order rebuild and gets the object-key index; a completed pre-upgrade retry stamps admission 0 and the observing definition's fingerprint. `apps/cli/src/retry-diagnostics.test.ts` — the built CLI's `doctor` text and JSON keep failing the monitor check after a tick of other keys and pass after an event for the dropped key; removed, unparseable and invalid definitions fail a `dropped-observation:<id>` check in text and JSON; duplicated-id rows with only an orphaned drop show `retry-outbox=0/0` and `dropped-observation=orphaned`; a live ephemeral drop gets an ephemeral-monitor check and a cancelled one a retired-ephemeral check, neither telling the user to repair a definition; a real `daemon run` socket still reports the loss in doctor and explain after a quiet scheduled tick; a monitor whose bundled `schedule` config is now rejected keeps a skipped monitor check, a failing `dropped-observation:<id>` check and no orphan group in doctor, and explain JSON/text shows the drop beside the definition-failure verdict) |
| A hold refusal is outstanding loss under the same rule as an unretained drop (002 §2, §4.7, issue #575) _(current)_ | Covered (`libs/core/src/runtime/hold-refusal-loss.test.ts` — real ticks over a file-backed store: a debounce refusal and a rollup refusal, each with and without an object key, are counted by `doctorReport` as `unretainedObservationLoss` and fail `explainMonitor`'s materialization stage, and stay that way through quiet ticks, a hold, newer history rows and a close/reopen of the store; a keyed refusal also survives a flush of other keys and a held observation of its key, and clears on that observation's event; an unkeyed refusal clears on a later span that materializes and drops nothing, but not on a span that materializes and refuses again; within the refusing span an earlier same-key sibling does not supersede it and a later one does; when an escalation later in that span flushes the debounce batch (002 §4.1), a same-key observation the batch held before the refusal (from an earlier tick, or earlier in the span) does not supersede it, and one held after the refusal does; a retained retry of an older same-key sibling queued in that span does not supersede it once it completes. `libs/core/src/runtime/notify-hold-serializability.test.ts` — the refusal row carries `holdRefused` and the observation's identity, and a span mixing a refusal and an unretainable drop leaves both outstanding. `apps/cli/src/retry-diagnostics.test.ts` — the built CLI's `doctor` (text and JSON) fails the monitor with the refusal as its newest drop, and `monitor explain` text names it) |
| Rollup window flush clears its hold only together with the flushed span _(current)_ | Covered (`libs/core/src/runtime/unretainable-suffix-admission.test.ts` — not-due window flush of 600 held observations with an ABORT on the 300th commits 599 events plus one capacity `errored` row and clears `pendingRollup`; a fitting suffix is retained with the hold cleared; a native `RAISE(ROLLBACK)` leaves the whole window held, records and reports the error, and the next check in the open window flushes all of it). |

| Watch batches and source state admit together | Covered (`libs/core/src/runtime/watch-batch-admission.test.ts` — two-recipient full-span/suffix visibility while first Interpret is suspended; whole and empty-state failures stop before newer input, preserve old state and replay on reopen). |
| Watch batch whose suffix the outbox cannot retain is admitted and the watcher keeps pulling _(current)_ | Covered (`libs/core/src/runtime/unretainable-suffix-admission.test.ts` — a yielded 600-observation batch with an ABORT on the 300th, and a 10-observation batch with a BigInt payload, commit their events, one `errored` row and the batch checkpoint; `onError` reports once and the next yielded batch is admitted). |
| Watch source migration and lifecycle fencing | Covered (`libs/core/src/runtime/watch-batch-admission.test.ts` — checkpoint callback absent, legacy yields refused, omitted/undefined/null semantics, other-workspace isolation, abort before admission/during Interpret, old-handle replacement safety, normal completion and synchronous setup failure). |
| Retained work drains before newer source input _(current)_ | Covered (`libs/core/src/runtime/retry-drain.test.ts` — a due retry completes before the source is observed again, so events are A then B; while a retry fails or backs off the source is not called and the tick reports `erroredObservations` or a `skippedMonitors` entry at the retry's next attempt; watch: a retained batch is drained before the next pull). |
| A retry that keeps failing stays isolated and visible every tick _(current)_ | Covered (`libs/core/src/runtime/retry-drain.test.ts` — eight ticks: one `erroredObservations` entry and one `errored` history row per tick through the terminal state, the failing source called once, and a healthy sibling monitor emitting every tick). |
| Retained work from before a restart drains first, in order, exactly once _(current)_ | Covered (`libs/core/src/runtime/retry-drain.test.ts` — three retained retries reopened from the database by a new runtime complete as A, B, C before D is observed, each once; a restarted watcher keeps its gate closed until a tick drains its batch, then pulls the next one). |
| Held work waits behind retained work while the source fails _(current)_ | Covered (`libs/core/src/runtime/retry-drain.test.ts` — a debounce flush whose write fails leaves A as a retry while C is held; with the source rejecting and both due, a failing retry and a terminal one each keep C held and no event written, report only the retry failure, and never call the source; once the failing retry completes, the next tick writes A then C through the source-error flush (002 §2.6, §2.7)). |
| A retired verify artifact's retained retry is dropped, not drained _(current)_ | Covered (`libs/core/src/runtime/verify-artifact-ownership-retry-drain.test.ts` — a retry queued before cleanup authority took effect is removed by the tick drain and by the watcher drain without an event or an `errored` row, and newer input proceeds; a terminal one no longer pauses the monitor; a legitimate retry behind a dropped one completes before newer input; cleanup recorded by a second writer between the drain's read and completion still drops the row; a removal that cannot commit is a failed drain step contained to its monitor; retries for an unregistered scratch-looking key, a foreign workspace, a real path, and an artifact still in its proof phase materialize (002 §2.7, §2.8)). |
| A hold refusal behind a dropped verify artifact keeps its place among the kept envelopes _(current)_ | Covered (`libs/core/src/runtime/verify-artifact-ownership-refusal-position.test.ts` — a debounce refusal of key K made while a registered artifact was held, after which cleanup authority took effect, is superseded by a newer same-key sibling an escalation flushes with the batch, with and without an older kept sibling held beside the artifact; that older sibling alone does not supersede it; with nothing filtered the artifact materializes and the newer sibling still supersedes the refusal (002 §2, §2.8, §4.7)). |
| A session registered after an observation never receives its retry _(current)_ | Covered (`libs/core/src/runtime/retry-drain.test.ts` — a session opened 500 ms after admission, in the same second, gets no projection or cursor while an earlier session does; a retry without a position reaches no positioned session; a session without a position falls back to time; a resumed session keeps its position. `libs/core/src/inbox/db.released-shapes.test.ts` opens every released `agent_sessions` shape, keeps its rows with no position, and reserves new positions after existing events). |

| Concurrent admission decisions preserve newer durable work | Covered (`poll-admission.test.ts` — independent notify writer commits immediately before BEGIN and its held envelope is materialized; mutation of observation context cannot alter the captured source token; `watch-batch-admission.test.ts` refuses a stale later batch without changing the winning source/notify state). |

| Not-due rollup decisions use current state under the writer lock | Covered (`rollup-admission.test.ts` — controlled owned child runtimes commit competing not-due, due and watch admissions before BEGIN; no duplicate events/Interpret or checkpoint/time rewinds; same-minute newly held work survives). |
| Rollup suffix, rollback and non-emitting admission are coherent | Covered (`rollup-admission.test.ts` — suspended first Interpret exposes exact prefix/suffix/marker; state/outbox failure restores all durable artifacts and cache, reopens for one flush; empty/closed-window failures preserve state and healthy sibling progress without routine audit spam). |
| Native rollback in a held not-due rollup flush | Covered (`rollup-admission.test.ts` — a later-sibling trigger first proves the new prefix, snapshot and both projections exist in the same transaction, then real ROLLBACK leaves no event/snapshot/projection/cursor/retry, checkpoint or cleared hold; prior rows and a nonempty recipient cache survive, the original error is reported with one errored history row, no Interpret runs, and a forced-due reopen replays the whole held span once. Real ABORT retains prefix and ordered suffix. A hold captured before a parsed source/instructions/urgency edit keeps its captured route, content and urgency, and the opaque source baseline, through an ABORT flush and reopen). |
| A notify-policy edit drains held rollup work through the flush's owned transaction | Covered (`rollup-admission.test.ts` — an edit that moves the rollup window drains, outside any window, the hold read under the writer lock, including an envelope another writer committed immediately before BEGIN; the source baseline and its clock are unchanged. A real ROLLBACK or ABORT on the second held envelope, at a minute the edited window matches, rolls the whole drain back: no event, snapshot, projection, cursor, retry, drop or metadata change, the prior recipient cache survives, the edit is reported blocked, and no window flush, poll or Interpret runs. After the fault clears the next tick drains every captured envelope once). |

### 3.4.2 Process-level ingress interruption acceptance (Refs #568)

`apps/cli/src/commands/daemon-ingress-kill-fault.integration.test.ts` is required in
`test:serial`, shared by CI and `pnpm verify`. It starts the already-built CLI as a real
owned child, with an isolated on-disk SQLite database, Unix socket and loopback HTTP stub.
The poll fixture uses bundled `api-poll`. The watch fixture adds a **test-only** `fs.watch`
wrapper around bundled `file-fingerprint.observe()` and exercises the runtime's actual
watch ingestion; this does not claim shipped file-source watch support (003 §3.8 remains
target). Each fixture watch round waits for both a native notification and the parent's
completed file write before sampling; repeated callbacks do not create additional rounds.
A flush requests a state-only pull over IPC and never rewrites the input file. This isolates
runtime interruption from concurrent input mutation without claiming shipped watch settling.
Deterministic source-level read-race tests separately require checkpoint/snapshot consistency
and refusal of detected concurrent writes (003 §3.2).

For immediate, debounce and rollup pacing, tests MUST interrupt every SQL write occurrence
observed during acceptance, held release, retry admission and retry completion. Immediate
pacing has no held-release phase. Discovery traces the entire asynchronous tick and
watch-consumption lifecycle at the SQLite driver, including `RETURNING` statements and repeated writes for two recipients. Each discovered
occurrence receives both a fault before execution and a SIGKILL immediately after execution,
then an independent process restart. No source data, runtime result or transaction is mocked.
Fixed wall clocks govern deadlines/windows; IPC messages and actual filesystem notifications
synchronize the test. Timeout timers only fail stalled waits. Owned children are reaped, with
POSIX group termination confirmed by the shared helper, before fixture files are removed.

Every case MUST assert exactly one event per distinct source change, persisted monitor order,
complete snapshots/cursors/projections, unread delivery to both registered lead sessions across
restart, and no projection to a subagent session. Failed ingest writes MUST identify the monitor
in the original `erroredObservations` tick result or watch `onError` callback and persist an
`errored` history row. History MUST never claim `triggered` when no event committed. The extra
post-commit history-write cases retain 002 §15's existing best-effort audit semantics: a failed
audit write cannot undo a committed event and is not itself an ingestion error.

The independent reader MUST compare each shared snapshot's content against the expected
source value, and its workspace/monitor/object/event identity against the corresponding
event. Comparing only row counts or the event's separate inline snapshot is insufficient.
Each recipient cursor MUST retain the expected baseline content and baseline event identity
under the exact session/workspace/monitor/object key, including after restart.

The four admission operations (`ingest`, held flush, retry drain and notify reconciliation)
automatically contribute every executed prepared write to the interruption inventory. Every
other lifecycle write MUST match an explicit named exclusion or fail with its SQL and call
site, even if runtime error handling catches the failure. Current exclusions are unarmed
startup/restart setup, the exact expired-object-suppression DELETE from its maintenance
method, and an `errored` audit INSERT reporting the selected injected fault (whose outcome
is checked separately). Delivery refresh reaches no additional durable writes in these
fixtures; it has no blanket exclusion. Direct SQL and deferred iterator writes are refused
with the same diagnostic until they have deliberate interruption support. Both `exec()`
and the native `pragma()` entrypoint MUST require an explicit read-only PRAGMA
allowlist, no assignment (including parenthesized setting writes), and SQLite
statement `readonly` metadata. Only schema-inspection PRAGMAs accept object-name
arguments. Unknown PRAGMAs and state-changing operations such as `optimize`,
`analysis_limit`, `wal_checkpoint`, `incremental_vacuum`, `auto_vacuum` and even a
`journal_mode` query MUST fail with their exact SQL, regardless of `readonly`.
Direct `ANALYZE`, `VACUUM`, `REINDEX`, `ATTACH` and `DETACH` are likewise refused.
Other direct SQL requires one preparable read-only statement; a readable prefix
cannot conceal another statement. Database-file changes, including statistics and
maintenance, require deliberate interruption support or a named exclusion.
Prepared read statements MUST apply the same admission at execution, including
handles prepared before lifecycle entry, through `run`, `get`, `all` and iterator
advancement/finalization. Table-valued `pragma_*` functions outside the query
allowlist MUST be refused even inside a read-only outer `SELECT`.
The allowlist is the first line of admission; a SQL-independent comparison of the
complete main-file and WAL bytes around each synchronous admitted read is the
file-effect guarantee. It detects statistics writes, maintenance, truncation and
same-size WAL frame reuse. A changed file MUST fail with `unclassified-write`,
SQL and call-site evidence, including after an execution throws. Shared-memory
reader-lock changes are excluded. Fixtures own private database paths and one
writable runtime connection; sources never receive the database path, IPC uses
the same connection, and parent assertions only read at completed command
barriers or after writer exit. Synchronous sampling permits no interleaved runtime
callback. A separate-process WAL-reader regression MUST remain admitted, and
unknown same-size main/WAL effects MUST be refused independently of SQL patterns.
`ingress-preload.test.ts` independently exercises asynchronous tick/watch discovery and
classification failures. The acquisition-path extra-write, corrupted shared-snapshot-content,
and corrupted recipient-baseline mutations MUST all fail the suite.

This is executed-path discovery, not proof that every possible branch in arbitrary source/Interpret
code was reached; invalid-envelope/loss-capacity and policy-edit branches retain their separate
runtime regression obligations. A scratch-copy mutation removing a durable snapshot write must
fail the invariant assertions even though that removed write no longer appears in discovery.
Retry re-arm and skip interruption cases remain an explicit linked TODO for #615 in the test
file, rather than skipped tests. The repair commands themselves are already on main.

Verification launched with an isolated home/data root MUST retain 002 §10.3's socket
normalization. `apps/cli/src/manual-daemon.test.ts` compares the canonical resolved socket,
including an explicitly overlong derived path, rather than assuming the raw workspace path
always fits the Unix socket limit.

### 3.5 CLI behavior

| Scenario                                                                                                                                                                           | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate` accepts a directory of valid monitors                                                                                                                                   | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "validates monitors in a directory")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `validate` rejects a nonexistent directory                                                                                                                                         | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "errors on nonexistent directory")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `validate` emits structured JSON when `--format json`                                                                                                                              | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "returns JSON error when --format json and path missing")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `validate` rejects an invalid `--format` value                                                                                                                                     | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects invalid --format value")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `validate` rejects a monitor with an unknown source name                                                                                                                           | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects an unknown source name")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `validate` rejects a monitor with invalid source config                                                                                                                            | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects a scope that violates the source schema")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `validate` hints for old top-level `source:` + `scope:` frontmatter                                                                                                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "hints when a monitor uses the old top-level source/scope shape")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `validate` redirects to `monitor test` when given a single file (issue #338 item 6)                                                                                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "redirects to `monitor test` when given a single file instead of a directory")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `monitor test` redirects to `validate` when given a directory (issue #338 item 6)                                                                                                  | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "redirects to `validate` when given a directory instead of a single file")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `scan` lists discovered monitors and parse failures                                                                                                                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "scans monitors and returns JSON"; `libs/core/src/parser/scan-monitors.test.ts` — "reports parse errors without aborting")                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `source list` reflects bundled registry contents                                                                                                                                   | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "lists sources in text format", "lists sources in JSON format")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `schema generate` emits source-discriminated monitor schema                                                                                                                        | Covered (`apps/cli/src/commands/cli.integration.test.ts` — `schema generate` › "emits a watch.type-discriminated monitor JSON schema" runs the CLI and checks the `watch.type` enum and the `urgency` pattern accept `low`/`normal`/`high`; "writes the schema to a file with -o"; function-level coverage stays in `libs/core/src/observation/schema-generator.test.ts`)                                                                                                                                                                                                                                                             |
| `session open/close/list` reflects runtime session records                                                                                                                         | Covered (`apps/cli/src/commands/cli.integration.test.ts` — `session list and close` › "lists an open session and marks it dormant on close" opens a session, asserts `session list` shows it `active`, runs `session close`, and asserts `session list` then shows it `dormant`)                                                                                                                                                                                                                                                                                                                                                      |
| `events list/ack` round-trips through daemon runtime behavior, including `deliveryState` tracking unread -> claimed -> acknowledged (issue #338 item 1)                            | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "opens a session, detects file changes through the daemon, claims a hook delivery, and acknowledges events"; `libs/core/src/runtime/service.test.ts` — "reports deliveryState on session-scoped listEvents, tracking unread -> claimed -> acknowledged")                                                                                                                                                                                                                                                                                                                   |
| `session open --format id` prints the bare session id (issue #338 item 4)                                                                                                          | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "prints only the bare session id, matching the id from --format json")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `hook claim` returns lifecycle-appropriate payloads                                                                                                                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — `hook claim --lifecycle turn-interruptible` in the runtime flow test; `libs/core/src/runtime/service.test.ts` — various `claimDelivery` lifecycle tests)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `monitor test` / `validate` scope rejection parity before source side effects                                                                                                      | Covered (`apps/cli/src/commands/monitor-scope-parity.integration.test.ts` — `monitor test / validate scope parity`, text/JSON matrix and live sentinel controls)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `monitor test` stateful baseline flow                                                                                                                                              | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "tests a valid file-fingerprint monitor"; `apps/cli/src/commands/monitor-test.test.ts` — "preserves previousState and refreshes now")                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `monitor test` errors on missing or unparseable file                                                                                                                               | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "errors on missing file", "errors on invalid MONITOR.md content")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `inbox list` argument validation                                                                                                                                                   | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects invalid --state value", "rejects invalid --urgency value", "rejects invalid --since date")                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Activation plugin `hooks.json` command strings stay wired to the CLI stdin contract (config drift)                                                                                 | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "drives the plugin's literal hooks.json command strings end to end (boot, deliver body, deregister)"; "SessionStart command falls back to the install-hint JSON when agentmonitors is not on PATH"). The suite parses the real `agent-plugins/agentmonitors/hooks/hooks.json` and runs each `SessionStart`/`UserPromptSubmit`/`SessionEnd` command verbatim via `/bin/sh -c` with an `agentmonitors` PATH shim, so a drifted command string (flag re-added, binary renamed, chain broken), a regressed stdin contract, or an invalid missing-CLI fallback breaks the test. |
| A global install of the packed launcher (no workspace `node_modules`) can go from `agentmonitors init` to a delivered signal over the real hook stdin/stdout contract (issue #276) | Covered (`scripts/test-e2e-fresh-install-hooks.mjs`, `pnpm test:e2e-fresh-install-hooks`, CI per-PR) — see [§2.7](#27-fresh-environment-e2e-hooks-path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `daemon run --detach` failure cleanup signals only its own unreaped child, never a recorded pid after that child has exited (issue #479, 008 §5)                                   | Covered (`apps/cli/src/commands/daemon.test.ts` — "never signals a recorded pid after our child has exited, even when that pid is now a live, unrelated process")                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 3.5.1 Verify observation boundary

Scratch cleanup after arbitrary delay, restart and held-work recovery is proved separately by the
verify-artifact ownership scenarios ([§2.5](#25-runtime-tests)); the checks below cover the
observation boundary. See 005 §16 step 9.

`apps/cli/src/verify-observe.test.ts` verifies distinct old/new observation identities with actual
SQLite second-rounded timestamps, command-start versus completion evidence, repeated-row refusal,
adjacent and truncated windows, retained settling evidence and manual-mode/explicit-timeout rules.
`apps/cli/src/commands/verify.integration.test.ts` runs a real owned daemon and a trigger command
that waits for its durable `triggered` history row before returning; verification must still succeed.
Run the daemon suite serially with retries disabled when accepting this boundary repair. This proves
the deterministic recording-order defect and repair, not that every historical CI failure had that cause.

### 3.5.2 Literal-path verify cleanup and first-attempt acceptance

The literal-glob integration scenario must prove that verify removes the file it created and its
create/delete events, then materializes the user's later file contents for the existing lead session.
The same event identity must survive at least two subsequent completed observations. A filename
substring or a fixed sleep cannot establish those durable-state guarantees on a loaded daemon.

Acceptance for #452 runs the entire verification integration file repeatedly with retries disabled,
including bounded CPU contention whose workers are reaped afterward. Failed verification assertions
include the command report; the literal-path assertion also includes retained observation history.

### 3.6 PR-alerting presets (`init --type pr-review` / `--type my-prs`, issue #444)

All rows below are covered by `apps/cli/src/commands/pr-alerting-presets.test.ts`, which drives the
real `command-poll` source over the real scaffolded `watch:` block with only the `gh` binary stubbed
(see [003 §11.9](./003-source-plugins.md#119-pr-alerting-recipe-reviewer-and-author-roles)).

| Scenario                                                                                                                                                                                                                                                                                                         | Coverage (describe block)                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer scoping defaults to `review-requested:@me` (the generated scaffold, before any user edit, always carries a reviewer-scoping qualifier — `search=''` is a supported, user-chosen alternative, not something the preset itself rejects)                                                                   | `reviewer scoping (PR #446 review, thread 1)`                                                                                                                                  |
| `pr-review` fires only for actionable transitions (appear/leave/draft-marked-ready)                                                                                                                                                                                                                              | `--type pr-review reviewer queue`                                                                                                                                              |
| `my-prs` fires on every actionable `needs` transition (CI, review, draft, terminal)                                                                                                                                                                                                                              | `--type my-prs fires on every actionable transition`                                                                                                                           |
| A repeat review from the same reviewer in the same state still fires (`at` field)                                                                                                                                                                                                                                | `--type my-prs review-revision signal (PR #446 review, thread 2)`                                                                                                              |
| Terminal (`merged`/`closed`) rows are time-bounded to 6h and never re-churn                                                                                                                                                                                                                                      | `--type my-prs terminal states are time-bounded`                                                                                                                               |
| `my-prs` stays silent across benign transitions (approval, retitle, post-merge chat)                                                                                                                                                                                                                             | `--type my-prs stays silent on non-events`                                                                                                                                     |
| `pr-review` and `my-prs` payloads never both claim the same PR (issue #441)                                                                                                                                                                                                                                      | `the two presets do not overlap (issue #441 interrupt multiplier)`                                                                                                             |
| `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`/`GH_REPO` are scrubbed before invoking `gh`                                                                                                                                                                                            | `gh environment/temp-file hardening (PR #446 review, thread 3)`                                                                                                                |
| The per-invocation stderr temp file is `mktemp`-created and always cleaned up                                                                                                                                                                                                                                    | `gh environment/temp-file hardening (PR #446 review, thread 3)`                                                                                                                |
| `commentCount` excludes the PR author's own comments and bot comments                                                                                                                                                                                                                                            | `--type my-prs fires on every actionable transition` ("does NOT fire when only…" / "fires when a reviewer…" cases)                                                             |
| A missing/unauthenticated `gh` surfaces `Command failing`, never a silent baseline                                                                                                                                                                                                                               | `graceful degradation when gh is unusable (issue #444)`                                                                                                                        |
| Neither preset hardcodes a repository, username, or working directory                                                                                                                                                                                                                                            | `preset portability guarantees (issue #444)`                                                                                                                                   |
| `my-prs`'s open-PR coverage survives terminal-history volume, up to `--limit 1000`                                                                                                                                                                                                                               | `` `--type my-prs` open-PR coverage survives terminal-history volume (PR #446 review, finding 989) ``                                                                          |
| `pr-review` excludes PRs authored by the current identity under EVERY `--search` scope, so a self-authored PR can never cross between the two payloads (PR #446 review, thread `r3615190027`)                                                                                                                    | `the two presets do not overlap (issue #441 interrupt multiplier)` ("gives a red undecided PR to my-prs only…", "a self-authored PR never enters pr-review, under any scope…") |
| The delivered event body stays readable (short titles, no raw command)                                                                                                                                                                                                                                           | `delivered alert readability (issue #449 guard)`                                                                                                                               |
| `gh api user`'s identity lookup resolves its host from the current repository (`gh repo view`), never a hardcoded `github.com` (PR #446 review, thread `discussion_r3617759108`)                                                                                                                                 | `reviewer scoping (PR #446 review, thread 1)` (argv assertions); `gh environment/temp-file hardening (PR #446 review, thread 3)` (end-to-end Enterprise-host stub)             |
| `pr-review` keeps a PR whose repo-wide `reviewDecision` already reads a decision when this identity is still an unresolved requested reviewer (PR #446 review, thread `discussion_r3617759232`)                                                                                                                  | `--type pr-review reviewer queue`                                                                                                                                              |
| Neither preset's diffed payload carries `title`, so a retitle never re-fires an already-actionable entry (PR #446 review, thread `discussion_r3617759355`)                                                                                                                                                       | `--type my-prs fires on every actionable transition` / `--type pr-review reviewer queue`                                                                                       |
| `my-prs`'s merged/closed calls are scoped by a `merged:`/`closed:` search date range (not `--limit` + creation order), so an older PR terminating inside the 6h window is never missed (PR #446 review, thread `discussion_r3617759463`)                                                                         | `` `--type my-prs` open-PR coverage survives terminal-history volume (PR #446 review, finding 989) ``                                                                          |
| `pr-review`'s pending-team-request override only keeps an `APPROVED` PR visible under the default `review-requested:@me` scope; switching `search=` to `label:needs-review` or unscoped drops it, since `reviewRequests` no longer guarantees viewer relevance (PR #446 review, thread `discussion_r3624450049`) | `--type pr-review reviewer queue`                                                                                                                                              |

Environment isolation is the `env`-focused rows above, not a separate scenario: it is exercised as a
property of the same `gh`-stubbed `observe()` calls rather than through a dedicated sandbox, since
`command-poll`'s `env` config field is already the mechanism under test (003 §11.9's "Repository
auto-scoping"). `cwd`/workspace-root portability is covered at the source level, not the preset level,
since it is `command-poll`'s own resolution behavior (003 §11.1) that both presets now rely on by
omitting `cwd:` entirely: see `plugins/source-command-poll/src/index.test.ts`'s "cwd resolution (003
§11.1)" describe block, which proves the SAME monitor state resolves to a different working directory
once `workspacePath` changes (simulating a relocated project) with no state baked into the monitor.
High-urgency silence on non-events is the `stays silent on non-events` row.

## 4. Test Style Guidance

Each tricky rule should have a named example plus explicit assertions. Agent Monitors tests MUST prefer:

- Structural assertions for event shape, hook state, and projection rules — assert on the specific fields that the spec defines, not on a serialized whole.
- Hand-authored scenario checks for subtle lifecycle behavior — write expected values by reading the spec, not by capturing current output.
- Direct assertions on current behavior when a limit is intentionally preserved (e.g., asserting that a second `claimDelivery` returns `null` after coalescing).

Snapshot-only approval is too weak for the subtler runtime rules in this repo. A test that passes solely because captured output matches a stored snapshot can never detect a regression in the rule it is meant to guard.

When tests depend on timing (settle windows, debounce), use fake timers (`vi.useFakeTimers()` / `vi.setSystemTime()`) rather than real `setTimeout` waits. Exceptions are integration tests that must exercise real process boundaries; these SHOULD use the shortest feasible polling intervals and document why fake timers cannot be used.

## 5. Ambiguity and Drift Handling

When sources disagree, the spec process MUST NOT silently average them together. The required process is:

1. Identify the contradiction explicitly.
2. Distinguish current implementation behavior from desired future behavior.
3. Record the resolution in `spec-changelog.md`.
4. Update the relevant numbered spec doc.
5. Update or add tests so the decision is enforced.

### 5.1 Current known mismatches that the spec already resolves

- `low` urgency is real and MUST be treated as first-class. The schema generator includes it in the `urgency` enum, and `monitor-schema.test.ts` "accepts all urgency values" asserts `low`, `normal` and `high` are each accepted (§3.1).
- The runtime/session event pipeline is the primary delivery path.
- The inbox item lifecycle is separate from the event pipeline, not merely another view of the same data.
- Duplicate monitor IDs are a correctness hazard: `scanMonitors()` reports collisions, and `validate` rejects duplicate IDs within the scanned tree (§2.2).
- Source-specific validation is fully enforced by `validate` against each source's `scopeSchema` using draft-07 JSON Schema checks, including types, enums, required fields, and nested items. Both `validate` and `monitor test` use `validateWatchScope` for the same rejection details; `monitor test` rejects invalid scopes before source observation (§2.2/§2.4). Runtime execution rejects the same invalid config before source effects (002 §2.0), preserving state until corrected.

### 5.2 Evidence priority during this transition

Until the repository is fully realigned with the new spec set:

1. The internal numbered specs are the desired contract.
2. Existing implementation and tests are the evidence for current behavior.
3. Older public website docs are explanatory and MAY lag.

If a future implementation change intentionally diverges from current behavior, that MUST be called out as a target change rather than described as if it were already implemented.

## 6. Acceptance Checklist For Spec Changes

Any substantive spec addition or change MUST answer all of the following:

- Is the rule normative or informative?
- Does it say whether the behavior is current or target?
- Is there at least one concrete example for the tricky part?
- Is there at least one test or validation implication attached to it?
- If it resolves a contradiction, is that recorded in `spec-changelog.md`?

If any answer is "no", the change is underspecified.

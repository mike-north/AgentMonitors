# @agentmonitors/core

## 0.10.0

### Minor Changes

- a4c642f: Add `agentmonitors doctor` — a unified, diagnose-only workspace health check. It runs a named sequence of checks (project enabled, monitors directory found, every monitor validates, daemon reachable, lead session present, and per-monitor health) and prints a per-monitor rollup (id, source type, cadence, last-observed, next-due, last-event, and unread/claimed/acknowledged counts for the workspace's lead session — or an explicit never-observed / no-lead-session marker). Each check reports pass/fail/skip with an actionable remediation; doctor exits 0 only when every check passes. Like `monitor explain`, it reads persisted state in-process, so the per-monitor rollup still works (and says so) when the daemon is down. `--format json` emits a stable machine-readable shape documented in the CLI reference. The reusable durable-state diagnosis is exposed on the core runtime as `AgentMonitorRuntime.doctorReport()` (host-agnostic).
- 867f8b7: DX papercut sweep from a blind DX study batch (S1 F3, S2 F4/F5, S5 F3/F4/F5/F7): help-text
  precision, claimed-vs-unread clarity, branding consistency, and symmetric path-argument errors.
  - **`events list` reports each event's delivery state.** `--unread` matches an unacknowledged
    event (002 §7), which includes events already claimed at a delivery lifecycle but not yet
    acknowledged — a surprise for a debugger reading "unread" as "never seen". Each returned event
    now carries a `deliveryState: 'unread' | 'claimed' | 'acknowledged'` field (new optional field on
    `@agentmonitors/core`'s `MonitorEventRecord`, present for the session-scoped `events list`
    query), and the CLI's text output gained a visible `deliveryState` column.
  - **`session open --format id`** prints just the bare session id — no more hand-rolled
    JSON-parsing one-liner needed to pull `.id` out of a verification script.
  - **`monitor test` given a directory now redirects to `agentmonitors validate`**, symmetric with
    `validate`'s existing redirect to `monitor test` for a single-file argument — instead of a raw
    `EISDIR` read error.
  - **`agentmonitors init`'s bootstrap summary** no longer claims unconditionally that "monitoring
    starts automatically when you open a Claude Code session" — that's conditioned on the Claude Code
    plugin being present, with the manual `agentmonitors daemon run` alternative on the next line.
  - **Required CLI options are now marked `(required)`** in their own `--help` output
    (`session open --host-session-id`, `events list`/`ack --session`,
    `hook claim --session`/`--lifecycle`).
  - **The `agentmonitors doctor` banner** now reads `agentmonitors doctor`, matching the real
    invocation (and the same command's own remediation text elsewhere in its output), instead of the
    prose product name "AgentMon".

- 697b525: Redeliver hook events omitted by the 4000-char context cap (fixes silent high-urgency signal loss).

  A `turn-interruptible` high-urgency claim used to mark the **full** settled candidate set claimed before the length-bounded hook-deliver transport rendered and truncated it, so events truncated out of the 4000-char `additionalContext` were marked claimed yet never re-delivered at the next context event — durable signal that stayed unread but was never surfaced again.

  The claimed set now equals the rendered set: the transport previews the settled high-urgency delivery without mutating state (`AgentMonitorRuntime.previewSettledHighDelivery`), sizes how many whole event blocks fit under the cap, and claims exactly that many via the new `maxEvents` argument on `AgentMonitorRuntime.claimDelivery`. The deferred remainder stays pending and re-delivers in order at the next context event; every event remains unread until explicitly acknowledged (claiming ≠ acking). Uncapped callers (the channel transport) are unchanged.

- 77d9568: Add `hook deliver --debug` for diagnosing silent hook-delivery output (fixes indistinguishable "correctly idle" vs. "misconfigured" states).

  `agentmonitors hook deliver` emits empty stdout + exit 0 both when nothing is pending AND when the stdin payload is misconfigured (unknown session, workspace not enabled, urgency held) — a blind DX study surfaced these as indistinguishable failure modes for the command most often run by an invisible hook system.

  `--debug` writes a step-by-step diagnosis to **stderr only** — stdout stays byte-identical in every mode. It reports which resolution step in the stdin → session → workspace → daemon → session-match chain stopped (or succeeded), pending-event counts by urgency for the resolved session, and a per-band hold reason for anything not yet deliverable: `settle-window` (aging inside the 15s claim-time threshold), `already-claimed` / `coalesced-until-ack` (the same vocabulary `monitor explain`'s reminder-suppression diagnosis uses), or `deferred-by-cap` (deferred by the hook-deliver transport's 4000-char context cap).

  New in `@agentmonitors/core`: a pure, read-only `AgentMonitorRuntime.diagnoseHookDelivery(sessionId, lifecycle)` plus the `HookDeliveryDiagnosis` / `HookDeliveryHold` / `HookDeliveryHoldReason` types and `classifyReminderHold` / `classifySettleWindowHold` classifiers. It never claims or mutates state.

- 0504103: Make a suppressed normal/low-urgency inbox reminder explainable instead of silent. The generic
  `turn-interruptible` (normal) and `turn-idle` (low) reminders coalesce until acknowledgment: once an
  unread event of that band has been claimed but not yet acknowledged, the reminder is intentionally
  suppressed until the claimed events are acknowledged or a fresh unclaimed event arrives — so a
  repeated `hook claim` correctly returns `null`. Previously that `null` was indistinguishable from
  "nothing was ever pending." Now `monitor explain`'s projection-and-delivery stage reports a
  `reminderSuppression` finding per session-and-band naming the reason (`already-claimed` or
  `coalesced-until-ack`) and pointing at the remedy, so "why did nothing surface?" is answerable
  rather than a dead end. The delivery stage stays healthy — a paused reminder is expected behavior,
  not a fault — and no signal is lost (the events remain unread and durable).

### Patch Changes

- fd2aeff: Declare the supported Node runtime and complete npm package metadata on every published package.
  Each package now declares `"engines": { "node": ">=24" }` — a floor at Node 24, the version CI tests — so
  an install on an unsupported Node release gets an actionable npm compatibility warning instead of
  an opaque runtime/native-addon failure. Each package also declares consistent
  `repository`/`bugs`/`homepage` metadata (pointing at its subdirectory of this repo) and ships a
  `README.md`, and the root README states the Node 24 requirement in its install instructions. The
  release-collateral validation run by `pnpm publish:packages:dry-run` (and CI's `publish-dry-run`
  job) now fails loudly if any published package is missing `engines.node`, `repository`, `bugs`,
  `homepage`, `README.md`, or `LICENSE`.
- d4299cf: Relicense the published packages under the MIT License. Each package now declares `"license": "MIT"` and ships a `LICENSE` file in its published tarball.
- b7e2711: Fix `agentmonitors doctor` disagreeing with `session list`/`daemon status` about whether a lead session exists, when the daemon was started directly via `agentmonitors daemon run` (the Getting Started guide's own documented usage) rather than lazily booted by a Claude Code hook.

  A directly-invoked `daemon run`/`daemon once` — with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides — used to bind to the bare global default database and socket, while `doctor` already assumed an enabled workspace gets its own isolated, derived per-workspace database. `session open`, `session list`, and `daemon status` all talked to the live daemon directly and correctly showed an active lead session; `doctor` independently re-derived a different, empty database and reported no lead session at all.

  `daemon run`/`daemon once` now resolve their database and socket the same per-workspace-aware way `doctor` and `session start`'s lazy boot already do, so a directly-started daemon is visible to every other workspace-aware command. `daemon status`/`daemon stop` (previously socket-only) now share the same resolution too, so they keep agreeing after this fix. `session open --workspace` is now resolved to an absolute path (matching `doctor`), and doctor's `lead-session` failure now names the exact workspace path it searched so a future mismatch is self-diagnosing.

## 0.9.0

### Minor Changes

- dcb7ae9: Default `baseline-strategy` changed from `incremental` to `net` (per-object consolidation, Refs #110)

  The standard delivery contract is now **one before/after delta per changed object per notification
  window**: monitors that omit `baseline-strategy` now receive `net` behavior by default.

  **Before (old default):** omitting `baseline-strategy` yielded `incremental` — every observation in
  a recipient's catch-up span was delivered as its own ordered delta (play-by-play). A recipient that
  missed N saves received N events.

  **After (new default):** omitting `baseline-strategy` yields `net` — the catch-up span is collapsed
  per `(monitorId, objectKey)` to a single before/after delta (cursor → endpoint), with intermediate
  saves recorded claimed-but-suppressed. A recipient that missed N saves of one object receives one
  event carrying the net before/after change. Multiple objects changed in the same window each produce
  their own event in the claim envelope (per object, not per monitor).

  **Migration:** monitors that need the full ordered play-by-play history (e.g. comment threads where
  each reply is a discrete step) must now declare `baseline-strategy: incremental` explicitly.
  Monitors that want "where things stand now vs. my baseline" (the common case for spec docs, shared
  files, and any monitor where intermediate churn is noise) work correctly with the new default and
  need no change.

  No runtime logic was changed — only the schema default
  (`z.enum(['incremental', 'net']).default('incremental')` → `.default('net')`). The per-recipient
  `collapseNetForClaim` machinery (shipped in G10 PR-B) is unchanged.

- 0dd2223: Author-declared baseline strategy: `baseline-strategy: incremental | net` (roadmap G13)

  A monitor may now declare a `baseline-strategy` frontmatter field that controls how the
  per-recipient Diff stage spans a recipient's catch-up span (the observations that accumulated since
  its baseline):
  - `baseline-strategy: incremental` (**default**) — every observation in the span is delivered as its
    own ordered delta (play-by-play). This is the existing, backward-compatible behavior.
  - `baseline-strategy: net` — the span is collapsed per object to a **single** net delta (the last
    observation of each object's run, diffed against the prior snapshot baseline); intermediate churn
    is discarded.

  Omitting the field is equivalent to `incremental`, so existing monitors are unaffected.
  - **core**: new optional schema field (`z.enum(['incremental', 'net']).default('incremental')`),
    surfaced on `MonitorFrontmatter` as `baselineStrategy`; new exported `BaselineStrategy` type; the
    runtime `ingest()` collapses the emitted catch-up span for `net`.
  - **cli**: `agentmonitors validate` accepts `baseline-strategy: incremental | net` and rejects any
    other value.

- 19f2d8d: `file-fingerprint` project monitor globs now resolve relative paths from the runtime workspace/config root instead of the daemon process cwd.

  Core now passes `workspacePath` to source observation contexts and records a distinct `no-files-matched` observation outcome when a source can tell that a zero-observation run matched no files. The bundled `file-fingerprint` source uses that context for relative `globs` and relative `cwd`, while preserving absolute `cwd` values and absolute glob patterns. `agentmonitors monitor test` now derives the same config root from the supplied `MONITOR.md` path so dry-runs match daemon ticks.

- 3ecc9bb: Add the optional **Interpret** stage (roadmap G14): a cheap agentic digest + significance gate via the user's own AI tool

  A `payload.form: prose` monitor may now have its **per-recipient delta** read by the user's own
  installed AI tool to produce a cheap, natural-language digest and, optionally, an agentic
  significance gate that suppresses a not-substantive change (capabilities C10/C11/C38). The stage runs
  **after** the per-recipient Diff and before Deliver, and only for `prose` — the deterministic-floor
  forms (`structured` / `artifact` / `rendered`) skip it.

  The host-specific tool invocation lives behind a new public `InterpretAdapter` interface
  (`createClaudeInterpretAdapter` shells out to `claude -p`, argv-only, never a shell) — **never** in
  the runtime core (002 §11.1, 006 §2.1). **Agent Monitors ships no model and holds no credentials**
  (C45): Interpret is disabled unless an `InterpretAdapter` is injected into `AgentMonitorRuntime`, so
  the default behavior is fully backward compatible, and summarization inherits the user's existing
  data-governance and egress posture.

  The stage is **best-effort**: a tool failure (missing / errors / times out) falls back to delivering
  the deterministic `rendered` artifact and is recorded — delivery correctness never depends on a model
  call. Every per-recipient verdict (`deliver` / `suppress` / `failed`) is recorded on
  `session_event_state` and surfaced by `monitor explain` (§10.7), so "why nothing fired" is
  inspectable (C12). New public exports: `InterpretAdapter`, `InterpretInput`, `InterpretResult`,
  `ClaudeInterpretAdapterOptions`, `createClaudeInterpretAdapter`, `InterpretDecision`, and an optional
  fifth `interpretAdapter` constructor argument on `AgentMonitorRuntime`.

- 3e197fc: Rewire `net` collapse and Interpret onto the per-recipient seam (roadmap G10 PR-B, 002 §1.1.7/§1.1.8)

  The `net` baseline collapse and the Interpret stage now span **per recipient** off each recipient's
  own baseline cursor, completing the right-of-seam stages of the post-processing pipeline (G10
  complete).
  - **`net` is a per-recipient decision at claim time.** The shared `monitor_events` chain now records
    **every** observation in order, regardless of `baseline-strategy` (the incremental substrate). When
    a recipient claims its unclaimed catch-up span, a `net` monitor delivers only the **newest** event
    per `objectKey` — its delta recomputed against that recipient's cursor → endpoint — and records the
    older intermediates **claimed-but-suppressed**: retained and explainable via `monitor explain`,
    excluded from delivery, never a silent drop. `incremental` (default) delivers all in order. So a
    recipient that was away across several separate windows now gets the correct single net delta against
    **its own** baseline, where before it got one row per window.
  - **Interpret runs once per distinct per-recipient delta.** Two recipients at divergent baselines
    invoke the user's AI tool twice (one per distinct delta, verdict recorded per session); identical
    baselines invoke it once and fan the verdict.
  - **Public types.** `MonitorEventRecord` gains `baselineStrategy` and `MonitorDeliveryProjection`
    gains an optional `netSuppressed` flag. New durable columns (`monitor_events.baseline_strategy`,
    `session_event_state.net_suppressed_at`) migrate additively; legacy rows are treated as
    `incremental` / never-suppressed.

  Backward compatible: a `net` monitor with a single (or co-registered, never-missing) session behaves
  exactly as before — `net` ≡ `incremental` in the degenerate single-observation span. The shared event
  chain keeping every intermediate is the only externally-visible change (`events list` shows N rows for
  a `net` catch-up span; the per-recipient delivery still collapses to one).

- 8a9388c: Make `urgency` optional in monitor frontmatter, defaulting to `normal` (001 §3)

  `urgency` was a required field. It is now optional: an omitted `urgency` flattens to the degenerate
  band `normal..normal`, so the minimal valid monitor is just a `watch:` block and a body. This is the
  gradual-reveal floor — an author opts into mid-session interruption (`urgency: high`) or a `lo..hi`
  escalation band only when needed. Backward compatible: every monitor that already declares an
  `urgency` level or band is unchanged, and the parsed `MonitorFrontmatter` shape is identical
  (`urgency`/`urgencyMax` are still always present after parsing). The default is deliberately
  `normal`, not `high`.

- 7ab21d3: Per-recipient baseline seam + per-recipient Diff (roadmap G10 PR-A, 002 §1.1.2)

  The runtime now materializes **one** shared `monitor_events` row per observation and computes a
  **per-recipient** delta for each projected lead session — the shaped artifact diffed against **that
  session's own baseline cursor** — recorded on the new `session_event_state.diff_text`. Two sessions
  at divergent stored baselines each receive the correct span from one shared observation (capability
  C15). The shared object-level diff is retained on `monitor_events.diff_text` for `events
list`/history display.

  A new durable table `session_object_cursor` holds each recipient's per-object baseline cursor
  (unique on `(session_id, monitor_id, object_key, workspace_path)`, with `baseline_content`
  denormalized for prune-immunity). Cursor semantics: a recipient's first projection of an object
  seeds its cursor caught-up to the pre-event state (a late joiner hears only changes after it
  registered); the cursor advances at claim (`markClaimed`); cursors persist across dormancy and
  survive a daemon restart (BP1).

  New public API on `RuntimeStore`: `getSessionObjectCursor` / `seedSessionObjectCursor` /
  `advanceSessionObjectCursor` / `perRecipientDiffsForSession`, the `SessionObjectCursorRecord` type,
  and a `diffText` field on `MonitorDeliveryProjection`. `insertEvent` takes an optional `baseline`
  argument used to seed first-time cursors.

  Backward compatible: a single lead session (or sessions co-registered at the same point) reproduces
  the pre-G10 diff byte-for-byte; old DBs migrate additively (`CREATE TABLE IF NOT EXISTS` + a unique
  index + `addColumnIfMissing(session_event_state, diff_text)`); a legacy `NULL`
  `session_event_state.diff_text` falls back to the shared `monitor_events.diff_text`. The `net`
  baseline strategy (G13) and the Interpret stage (G14) are behaviorally unchanged — they keep
  operating over the shared baseline on top of this substrate (G10 PR-B rewires them per recipient).

- e0b52bd: Add the scheduled-rollup Pace mode (`notify.strategy: rollup`)

  A third notify strategy alongside `debounce` and `throttle`. A `rollup` monitor declares a required five-field cron `window` (and an optional IANA `timezone`, default `UTC`); the runtime accumulates every observation into a durable batch held in `monitor_state.notify_state` and delivers nothing between windows. On each tick it evaluates the `window` cron and, when the window fires with a non-empty batch, flushes the whole accumulation as a single composite delivery (one `monitor_events` row per accumulated observation) and clears the batch. An empty window produces no delivery. The accumulated batch survives a daemon restart.

  `agentmonitors validate` accepts a `rollup` monitor with a `window` and rejects `strategy: rollup` missing `window`. Public API additions: `PendingRollupState` (exported) and the `rollup` member of `NotifyStrategy`. See docs/specs/001 §3.6 and 002 §4.4–§4.5.

- 14c6b94: Add the deterministic **Shape** stage (roadmap G15): author-declared derived
  facts, render-then-diff, and payload form.
  - **New `shape` frontmatter** — `shape.derive` is an ordered list of named
    derived facts, each a CEL boolean predicate over `(snapshot, now)`; `shape.render`
    opts into rendering the shaped state to a stable, byte-identical text artifact.
    When `shape` is declared the runtime diffs **that artifact**, not the raw source
    (002 §1.1.4–§1.1.5).
  - **New `payload` frontmatter** — `payload.form` is one of `prose | structured |
artifact | rendered` (a stable contract the follow-on Interpret stage builds on).
    For `form: structured` a turnkey `payload.transform` runs over the canonical JSON
    snapshot: `jq` reshapes the delivered payload; a `cel` gate of `false` suppresses
    delivery entirely (002 §1.1.6). A malformed transform fails `validate`.
  - Derived facts are a pure function of `(snapshot, injected now)`; the only time
    input is the runtime-supplied tick clock, never an ambient `Date.now()`.

  **New public API:** `PayloadForm`, `PayloadEncoding`, `ShapeConfig`,
  `PayloadConfig`, `shapeSchema`, `payloadSchema`; `computeDerivedFacts`,
  `renderArtifact`, `renderShapeArtifact`, `validateCelPredicate`; `applyPayloadTransform`,
  `validatePayloadTransform`, `PayloadTransform`, `TransformLanguage`, `TransformOutcome`;
  `shapeObservation`, `ShapeStageConfig`, `ShapedObservation`; `DerivedFact`,
  `DerivedFactRule`.

  The transform evaluator is CSP/Workers-safe — both `cel-js` (Chevrotain-based) and
  `jq-in-the-browser` (a PEG parser-combinator) parse and interpret expressions
  without the `Function` constructor or `eval` (the same constraint that drove
  `@cfworker/json-schema` over `ajv`).

  Fully backward compatible: a monitor with no `shape`/`payload` block behaves
  exactly as before (raw `snapshotText` is the diff input).

### Patch Changes

- 8dbda37: `api-poll` change-detection robustness: non-2xx responses error instead of baselining, and `json-diff` warns on non-JSON bodies (Refs #219, #220)

  **Non-2xx responses are now errored observations, not silent baselines (#220).** Previously
  `api-poll` established its change-detection baseline from **any** HTTP response body, including a
  `401` from a missing/invalid bearer token or a `500` error page — so a misconfigured-auth monitor
  appeared to "work" while silently diffing error pages. For the `text-diff` and `json-diff` strategies,
  a non-2xx status now throws a status-bearing error (`api-poll received HTTP <status> from <url> —
check auth/url; not establishing a baseline on an error response`). The runtime records the tick as
  `errored` (no baseline advance, prior baseline preserved), `daemon once`/`run` report it,
  `monitor history` shows `errored`, and `monitor test` reports `Observation failed: … HTTP <status>`.
  2xx responses baseline/diff exactly as before. **Exception:** the `status-code` strategy still treats
  a non-2xx as a legitimate observed signal (the status is the watched object), so 200 → 5xx detection
  is unchanged.

  **`json-diff` against a non-JSON body now warns (#219).** When `change-detection.strategy: json-diff`
  is configured but the fetched body does not parse as JSON, the source attaches a non-fatal warning to
  the `ObservationResult` (the new optional `ObservationResult.warnings` field) and `agentmonitors
monitor test` prints it, steering the author to `text-diff` for HTML/plain-text pages instead of
  silently degrading to text comparison. The `api-poll` scaffold (`agentmonitors init`) and the
  authoring docs now state strategy-by-content-type inline: `text-diff` for HTML/plain pages, `json-diff`
  for JSON APIs.

- 33e2f0d: Add `skippedMonitors` field to `RuntimeTickResult`

  `RuntimeTickResult` now includes `skippedMonitors: SkippedMonitor[]`, populated from the same scheduling decision that gates evaluation. Each entry carries `monitorId` and `nextDueAt` (the earliest time the monitor will be due). `SkippedMonitor` is exported from the public API surface.

- 1836f04: DX polish (issue #153): validate output consistency, urgency error wording, api-poll feedback
  - **validate**: invalid monitors now display the monitor ID (matching valid-monitor output) instead of the full file path; passing a file path shows a `monitor test` pointer
  - **core**: inverted urgency range error no longer duplicates the field name (`urgency: range "high..normal" is inverted` instead of `urgency: urgency range …`)
  - **api-poll `monitor test`**: HTTP status and response body size are now printed after the baseline so authors can spot bad URLs immediately
  - **api-poll observe**: Node `fetch` errors now propagate the underlying network cause (ECONNREFUSED, ENOTFOUND, timeout) in the message, visible in `monitor explain` output

- 50db864: fix(explain): verdict selects highest-severity stage; materialization is pending during debounce

  `explainVerdict()` previously picked the _first_ stage whose status was not `'ok'`. After
  the `healthy` idle status was introduced in #98, a healthy Observation stage short-circuited
  the scan and masked downstream `failure` or `pending` stages (#149 regression).

  The verdict now selects the _highest-severity_ stage using the ranking
  `failure > pending > healthy > ok`. A healthy or idle observation stage can never mask a
  downstream fault.

  Also fixes the Materialization stage status for the debounce-pending case: when the Notify
  stage is holding a batch (`pending`), the Materialization stage now correctly reports
  `pending`/⏳ rather than `failure`/✗ — the absence of materialized events is expected
  behavior while the debounce settle window has not yet expired.

- 745b6fb: Fix: `collapseNetForClaim` now includes `workspacePath` in its object-identity key (regression #186)

  `collapseNetForClaim` grouped claim candidates by `(monitorId, objectKey)` without `workspacePath`.
  For a global (null-workspace) lead session — which receives projections from all workspaces — a
  `net` monitor with the same `(monitorId, objectKey)` materialized in two distinct workspaces had
  both events folded into one net group. Only the globally-newest event was delivered; the other
  workspace's newest event was wrongly recorded as `net_suppressed`, silently dropping a delivery and
  violating workspace isolation (002 §1.1.7).

  The grouping key in both the candidate-group pass and the newest-per-group pass is now the 3-tuple
  `[monitorId, objectKey, workspacePath ?? '']`, matching `advanceCursorsForClaimedEvents` and the
  `session_object_cursor` UNIQUE index. Single-workspace collapse behaviour is unchanged.

- 094fc2b: Fix: rollup not-due window flush now applies `net` baseline strategy and records audit history

  A `notify.strategy: rollup` monitor flushes its accumulated batch through two paths in the runtime
  tick. The **due** path (source poll interval elapsed) routes through `ingest()`, which applies the
  `baseline-strategy: net` collapse (002 §1.1.7) and records a `triggered` `observation_history` row
  (002 §10.7). The **not-due** path — the window fires on a tick where the source interval has _not_
  elapsed, which is the _normal_ operating mode for a rollup monitor with `watch.interval` relaxed to
  match the delivery window (002 §4.4) — was a separate, drifted re-implementation that did neither.

  Effect of the bug: a `rollup` + `net` daily-digest monitor delivered the full play-by-play (N
  events) instead of one net delta on every windowed flush, and the delivery was invisible to the
  audit trail (`monitor explain` / `agentmonitors … history` reported "nothing triggered").

  Both paths now route through a single shared span-materialization helper, so the `net` collapse and
  the `triggered` audit row are applied identically and can never drift again. `incremental` (default)
  behavior, the once-per-minute window guard, and the due-path behavior are unchanged.

## 0.8.0

### Minor Changes

- dfb124a: Monitor `urgency` frontmatter now accepts an authored band (`urgency: normal..high`); a bare scalar
  is the degenerate band `x..x`. A source observation may carry an optional `salience`, and the runtime
  resolves the effective urgency as `clamp(salience ?? band.lo, band.lo, band.hi)` — so a source can
  escalate a single observation only within the author's band, clamping outside it. An escalated
  observation arriving in a held debounce batch flushes the whole batch early (it is not split).

### Patch Changes

- 07f8cf7: Align the generated `urgency` JSON Schema pattern with the Zod parser's whitespace tolerance. The parser trims surrounding whitespace before validating (so `urgency: ' normal '` and `' normal .. high '` are accepted), but the generated editor-hint schema previously rejected leading/trailing whitespace. The pattern now allows it (`^\s*…\s*$`), so schema-based validation and the authoritative parser agree.

## 0.7.0

### Minor Changes

- 5c748a4: `daemon once` and the `daemon run` periodic tick log now report monitors whose `observe()` errored on a tick instead of printing a clean `emitted 0 event(s)`. The runtime tick result gains an `erroredObservations: { monitorId, message }[]` field (populated from the same path that records each `errored` row in `observation_history`), and the CLI surfaces a non-zero errored count plus each errored monitor's id and message without a verbose flag. A genuine no-change tick is unchanged, so an author can finally distinguish a broken source from a watched target that simply hasn't changed.

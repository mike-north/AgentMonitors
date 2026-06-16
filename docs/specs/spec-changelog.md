# Spec Changelog

This file records clarifications, contradiction resolutions, and structural changes to the
Agent Monitors spec set in `docs/specs/`.

## Usage

- Add entries when ambiguity is resolved or the intended contract changes.
- Prefer short entries tied to the numbered doc affected.
- If implementation behavior and desired behavior differ, say so explicitly.

## 2026-06-15 — Scheduled-rollup Pace mode formalized as _target_ (001 §3.6, §7.3; 002 §4.4–§4.5; roadmap G12) — Refs #147

Formalizes a resolved decision from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
capability C44; resolved §S5.2). Spec-only; all new rules are marked **target**, not current.

- **001 §3.6 — `notify: rollup` authoring surface (target).** The third `notify` strategy,
  `rollup`, is specified: `strategy: rollup` plus a five-field `window` cron expression and an
  optional `timezone` (defaulting to UTC). A `rollup` monitor accumulates observations between
  window openings and delivers them as a single composite batch when the window fires. Authors
  **SHOULD** relax `watch.interval` to match the delivery frequency — polling every 30 s is wasteful
  when delivery is a daily digest. The current schema rejects `strategy: rollup`; this section
  documents the intended authoring surface for the implementation ticket.

- **001 §7.3 — daily digest rollup authoring example (target).** Illustrates `strategy: rollup`
  with a 9am weekday `window` paired with `interval: 1h`, demonstrating the cadence-relaxation
  principle.

- **002 §4.4 — scheduled-rollup Pace mode semantics (target).** Full runtime semantics:
  accumulation in durable `notifyState` across restarts; window evaluation on each tick (five-field
  cron + timezone, same guard as the schedule source); non-empty batch → flush and clear; empty
  window → no delivery (no empty pings, C14). Key clarifications: the flushed batch enters the
  normal materialization → projection → delivery pipeline (§5 → §6 → §9); rollup is entirely on
  the shared side of the seam (§1.1.2); the delivery clock (§9) is independent of the window clock
  (§1.1.3). Three-clocks analysis applied: observation cadence **SHOULD** be relaxed independently,
  reducing token and observation cost (C44, §S5.2 primary motivation).

- **002 §4.5 — complete Pace mode reference (target row for rollup; others current).** A
  four-row comparison table: **immediate** (no notify) / **settle/debounce** (`debounce`) /
  **throttle** (`throttle`) / **scheduled rollup** (`rollup` ⚑). This completes the Pace set:
  no further Pace modes are anticipated. The table frames rollup as the lowest-cost delivery mode
  and the natural pairing with relaxed observation cadence.

- **roadmap G12** — implementation gap for `strategy: rollup`, P2, with five proof criteria
  (validate acceptance, accumulation-between-windows, flush-on-window, empty-window-no-delivery,
  restart-safety). Governs [001 §3.6], [002 §4.4–§4.5], C44/§S5.2.

Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — Deterministic Shape stage: derived facts, render-then-diff, author-declared payload form (001 §5.1–§5.2, 002 §1.1.4–§1.1.6, 003 §2.7) (#144)

Formalizes the **deterministic Shape stage** from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S2 areas C/E/G, §S3 Tier 1, §S5 item 5; ledger rows **C41/C42/C43/C46**, with C3/C4/C5/C21 as
the surrounding Shape area and E8 as the flagship cost story). Spec-only; **every new rule is marked
target**, not current. Builds directly on the just-formalized pipeline-shape framing (002 §1.1) and
does **not** contradict any _current_ rule: today's object-level textual diff (002 §5.2) is the
degenerate case where Shape does no compute/render, and the source/runtime split (PP3, AP3, 003 §2.5)
is reaffirmed, not changed.

- **002 §1.1.4 — Shape: deterministic derived facts (target, C41).** The Shape stage MAY compute
  derived/relative facts (timestamp → "past due"/"due soon", all-tasks-blocked → "stalled",
  defer-threshold-crossed → "revealed", priority+proximity → "urgent") as a **pure function of
  `(shaped snapshot, injected now)`** — no model, no ambient clock — on the **shared** side of the
  seam, **before** Pace and Diff (so a fact appearing/changing is itself a diffable delta). Author-
  declared and optional. Kills the E8 "≈100% waste" of an agent re-deriving these every poll.
- **002 §1.1.5 — Shape: render to a stable artifact, then diff the artifact (target, C42/C43).** Shape
  MAY render the shaped state to a stable, token-efficient, markdown-ish (not JSON) artifact, and the
  runtime MUST diff **that rendered artifact**, never the raw source — pinning the order
  `Observe → [Compose] → Shape(compute → render) → Pace → ⟦seam⟧ → Diff(of the artifact) → …`. Render
  is deterministic (byte-stable, or it produces phantom diffs) and shared; the diff **baseline** is
  per-recipient. Deterministic render is a prerequisite for a useful diff — the structural reason
  Shape precedes Diff.
- **002 §1.1.6 — author-declared payload form (target, C46).** The author declares the payload form —
  `prose | structured | artifact | rendered`. `prose` is the only form that invokes the optional
  Interpret stage; the others are deterministic-floor forms (`structured` is the explicit way to avoid
  a lossy digest for a computing recipient, E6). `structured` is produced by a **turnkey declarative
  transform** — **jq** (reshaping) or **CEL** (predicate) — evaluated over the **canonical JSON** form
  of the shaped snapshot (output `encoding` — json/yaml/toon/toml — is a downstream serialization
  concern, not part of predicate semantics); the transform is constrained, **not** arbitrary code, and
  runs once on the shared side of the seam.
- **001 §3 / §5.1 / §5.2 — authoring surface (target).** Adds optional `shape` (derived facts +
  render) and `payload` (form + transform + encoding) frontmatter blocks, with authoring rules,
  examples, and validation obligations. The §3 frontmatter table gains `shape` and `payload` rows
  marked _target_. Omitting both preserves today's textual delivery.
- **003 §2.7 — sources surface raw facts; the runtime computes derived facts (target, C41).** Draws
  the source/runtime line for **facts** (mirroring §2.5 for diffs): a source surfaces the raw
  primitives (a `due` timestamp, child task states) **as observed** and MUST NOT bake in time-relative
  or aggregate derived facts (which depend on runtime-`now` and would churn the diff); the runtime
  Shape stage derives them. This is where the raw facts the §1.1.4 rules consume originate.
- Glossary entries added (derived fact, rendered artifact, payload form). Roadmap gains target gap
  **G12** (deterministic Shape: derived facts + render-then-diff + payload form), with proof criteria;
  it is the per-stage detail under the §1.1 umbrella that G10 names.
- **Acceptance (004 §6):** every rule is normative + marked _target_; each tricky rule carries an
  example (E8 derived facts, E6↔E8 payload poles) and a test implication (fixed-`now` reproducibility,
  byte-stable render, jq-projection output). No contradiction resolved beyond reaffirming the existing
  split, so the resolution is recorded here per 004 §5.
- Spec-only — no implementation or published-package behavior change, so no changeset. Refs #144.

## 2026-06-15 — Post-processing pipeline shape + source/runtime diff split formalized as _target_ (002 §1.1, 003 §2.5–§2.6)

Formalizes resolved decisions from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S4, §S5; ledger rows C40/C6/C43/C15). Spec-only; every new rule is marked **target**, not
current — the current runtime implements a subset under different names and is reaffirmed, not changed.

- **002 §1.1 — locked pipeline stage order (target).** Names the conceptual stages an observation
  flows through and fixes their order:
  `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff → Interpret → Deliver → [React]` (bracketed
  stages optional). Each stage's responsibility and side of the seam is defined. Shape runs before
  Pace and before Diff (settle and diff the shaped/rendered artifact, not the raw source).
- **002 §1.1.2 — shared / per-recipient seam (target).** Everything left of the seam (Observe…Pace)
  is computed **once** and shared across all recipients; everything right (Diff…Deliver) is **per
  recipient**, against that recipient's baseline/cursor. Identical baselines may dedupe. This is the
  structural reason fan-out is cheap (C15). The current object-level diff (§5.2) is named as the
  degenerate **shared-baseline** case of the target per-recipient Diff — a refinement, not a
  contradiction. §5.2 gains a back-reference.
- **003 §2.5 — sources return snapshots, not diffs (target; reaffirms PP3/AP3).** The source contract
  now states explicitly that a source observes **current state** (+ its own `nextState`
  change-detection state) and the **runtime is the sole producer of the delivery diff**, parameterized
  by the consumer's baseline. A source's `nextState` is its internal "did anything change" cursor, not
  any recipient's baseline; a source MUST NOT compute "what is new for recipient X."
- **003 §2.6 — composite observation (target, C40).** One `Observation` MAY be assembled from many
  source queries/calls into a single stable whole-state snapshot under one `objectKey` — the
  `[Compose]` stage, on the shared side of the seam. Modeling, determinism, and partial-failure rules
  specified.
- Glossary entries added (post-processing pipeline, the seam, composite observation). Roadmap gains
  target gaps **G10** (pipeline stages + per-recipient seam) and **G11** (snapshots-not-diffs +
  composite observation), each with proof criteria.
- Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — CLI: `--format toon|json|text` with agent/human auto-detection on structured-output commands (#121)

**005 §1 (output formats), §4 (scan), §7.1 (source list), §11.1 (events list), §6 (monitor history / explain):**

- Added `toon` as a `--format` choice on all five structured-output commands (`events list`, `scan`, `monitor history`, `monitor explain`, `source list`). All three choices — `toon`, `json`, `text` — are now available on every command.
- **Default is auto-detected per invocation context** (via `is-agentic-tui`): agent-driven invocations (e.g. `CLAUDECODE=1`, `CURSOR_AGENT=1`) default to `toon`; interactive human terminals default to `text`. An explicit `--format` flag always overrides detection. Per-command `Default` column in §4, §6, §7.1, §11.1 updated to `auto (see §1)`.
- `--format json` output is **byte-for-byte identical** to the pre-change behaviour — no regressions for JSON consumers.
- TOON is a rendering-only transform at the CLI output edge. Durable storage (SQLite `monitor_events`, snapshots, source state, hook-state files) and the daemon IPC wire stay JSON everywhere.
- Round-trip safety: `decode(encode(value))` equals the original JSON value; asserted by tests for each command.
- Libraries: `@toon-format/toon@^2.3.0` (MIT, no deps) and `is-agentic-tui` (ISC, no deps). Both confirmed free of `new Function`/`Function(` — pass the CSP/Workers constraint.
- Layer B (delivered observation payload) is explicitly out of scope — deferred pending a standard-level design decision in §006 / the Monitor Standard.

## 2026-06-15 — DX polish: validate output, urgency error wording, api-poll feedback (#153)

Several author-facing DX improvements shipped as a cluster:

- **005 §3 (validate output consistency):** `validate` now displays the monitor ID (folder/stem
  name) for both valid and invalid monitors in text output, not the full file path for errors.
  Passing a file path to `validate` shows a `monitor test` pointer in the error. (Previously,
  invalid monitors printed the full absolute path; valid monitors printed the ID — inconsistent.)

- **core (urgency error wording):** The inverted-range error no longer repeats the field name.
  Before: `urgency: urgency range "high..normal" is inverted …`. After: `urgency: range
"high..normal" is inverted …`. (The Zod path prefix already includes `urgency:` as context.)

- **003 §4.6 (api-poll network error propagation):** Node `fetch` wraps real network errors
  (ECONNREFUSED, ENOTFOUND, …) as `err.cause`. The plugin now catches, extracts the cause
  message, and re-throws `"fetch failed: <cause>"` so `monitor explain` shows the real reason.

- **003 §4.7 (api-poll `monitor test` baseline output):** `monitor test` now prints the HTTP
  status code and UTF-8 response body size after the baseline for `api-poll` sources. This makes
  transport-level successes with unexpected responses (e.g. a 404 on a mistyped-but-resolvable URL,
  or an empty 200) immediately visible. Network-level failures (ECONNREFUSED, ENOTFOUND, …) are a
  separate case: they throw before a baseline exists and are surfaced via §4.6 error propagation
  (visible in `monitor explain`), not via the status/size line.

## 2026-06-15 — `monitor explain` / `monitor history` read the persisted DB in-process when no daemon is running (005 §6, 002 §10.7, #150)

`monitor explain` and `monitor history` were socket-only: with no daemon running — including right
after `daemon once` materialized events — both failed, and `monitor explain` reported a false
`✗ Scheduling: failure` for a monitor that had actually fired. On a genuine `DaemonConnectionError`
the CLI now runs the same read-only `explainMonitor` / `listObservationHistory` **in-process**
against the persisted SQLite store (the `daemon once` pattern) and renders the real diagnosis,
prefixed with the banner _"No daemon running — showing persisted state from the last tick."_ (text)
or annotated with a `"notice"` field (JSON). Only when the daemon is down **and** there is genuinely
nothing persisted (no `observation_history` and no `monitor_events` rows) does the CLI print an
actionable remediation line (`agentmonitors daemon run`, or `monitor test` for a one-shot) instead
of a raw `connect ENOENT …`. A daemon-side application error is still surfaced verbatim, never masked
as "daemon not running" (the #94/#98 distinction holds).

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('monitor explain / history
without a live daemon (issue #150)')`: after `daemon once` with no daemon, `monitor explain` shows
  the real diagnosis + banner and **no** false scheduling failure (text and `--format json`);
  `monitor history` returns the persisted rows; daemon-down-with-nothing-persisted yields the
  remediation message, not an `ENOENT`.
- Minor changeset: `@agentmonitors/cli` (CLI behavior change; no core public-surface change).
- Refs: issue #150 (relates to #94, #149).

## 2026-06-15 — file-fingerprint salience policy: `deleted` → `high`, others → default (003 §3.4)

`file-fingerprint` now emits `salience: 'high'` on `deleted` observations (information permanently
lost) and no `salience` on `created`, `modified`, or `descoped` observations (file still exists or
no information lost). This makes RANGE urgency reachable end-to-end with a bundled source: a monitor
authored with `urgency: normal..high` will receive a `high`-urgency delivery on file deletion and a
`normal`-urgency delivery for all other change kinds. Monitors with a bare scalar `urgency` are
unaffected (the degenerate band `x..x` is never escalated — backward compatible per 003 §2.3).

- **Proof:** `plugins/source-file-fingerprint/src/index.test.ts` — unit tests asserting `salience:
'high'` on `deleted` and absent salience on `modified`, `created`, `descoped`; end-to-end
  integration tests proving the runtime materializes `urgency: 'high'` for a deletion on a
  `normal..high` band monitor and `urgency: 'normal'` for a modification on the same monitor.
- Minor changeset: `@agentmonitors/source-file-fingerprint` (new salience behavior).
- Refs: issue #151.

## 2026-06-15 — monitor explain verdict uses severity ranking, not first-non-ok (005 §6.4, regression #149)

`explainVerdict()` previously selected the _first_ stage whose status `!== 'ok'`. After the `healthy`
idle status was introduced in #98, a healthy Observation stage (not `'ok'`) short-circuited the scan
and masked a downstream `failure` or `pending` stage (#149 regression).

**Fix (005 §6.4):** the verdict now selects the _highest-severity_ stage. Severity order:
`failure(3) > pending(2) > healthy(1) > ok(0)`. A `healthy` or `ok` observation stage can never
mask a downstream fault. The `verdict.status` field in JSON output may now be `"healthy"` for a
fully idle monitor (spec corrected from `"ok|pending|failure"` to `"ok|pending|healthy|failure"`).

**Related fix (005 §6.4):** when the Notify stage is `pending` (debounce/throttle holding a batch)
and no event has materialized yet, the Materialization stage now reports `pending`/⏳ instead of
`failure`/✗ — the absence of materialized events is correct behavior when the notify layer is
holding, not a fault.

## 2026-06-15 — `daemon once` distinguishes skipped-not-due monitors from no-monitors-found (002 §2.4, 005 §9.1)

`RuntimeTickResult` gains a `skippedMonitors: { monitorId, nextDueAt }[]` field, populated from the
same scheduling decision that gates evaluation — never recomputed separately. `daemon once` appends a
parenthetical suffix when non-empty: `(N not yet due — next due in Xs)`, reporting
the soonest next-due time. Previously a second `daemon once` run within a monitor's interval printed
`Evaluated 0 monitor(s), emitted 0 event(s).` — identical to the "no monitors found" output, giving
the author a silent dead end (issue #152). The genuine empty/no-monitors path is unchanged.

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('daemon once skipped-not-due
visibility (issue #152)')`: three tests cover (a) skipped suffix on second run, (b) empty-dir
  unchanged, (c) mixed evaluated + skipped counts reported accurately.
- Patch changesets: `@agentmonitors/core` (new `skippedMonitors` field + `SkippedMonitor` type in the
  public surface) and `@agentmonitors/cli` (user-visible tick output suffix).

## 2026-06-14 — Hydration backfill for pre-upgrade debounce batches (002 §3, restart-safety)

`hydrateStoredObservationEnvelope` now backfills a missing `effectiveUrgency` field (present on envelopes serialized before the range-urgency upgrade) by recomputing it from `effectiveObservationUrgency(monitor, observation)`. Without this, the first daemon restart after upgrade would materialize an invalid (undefined) urgency row. Degrades cleanly when the hydrated monitor snapshot itself lacks `urgencyMax`: returns the base urgency via `URGENCY_BY_RANK[NaN] ?? lo`.

## 2026-06-14 — Range urgency band + per-observation salience (001 §3.2, 002 §4.1/§5.1, 003 §2.3)

A monitor's `urgency` frontmatter is now an authored **band** `lo..hi`; a bare level is the degenerate
band `x..x` (unchanged behavior — fully backward compatible). A source observation may carry an
optional `salience`, and the runtime resolves the effective urgency as
`clamp(salience ?? band.lo, band.lo, band.hi)`.

- **Authored band (001 §3.2):** `urgency: normal..high` authorizes escalation within the band; a bare
  scalar can never be escalated. The schema rejects unknown bounds, malformed ranges, and inverted
  ranges (`lo > hi`). Parsed to `frontmatter.urgency` (low bound — the base/default) +
  `frontmatter.urgencyMax` (high bound).
- **Salience is observation, not policy (003 §2.3):** the per-observation field is named `salience`
  (PP3 — domain observation), reserving `urgency` for the monitor-level policy knob (PP5).
- **Effective urgency + debounce (002 §4.1, §5.1):** notify timing and the materialized
  `monitor_events.urgency` both use the clamped effective urgency. An escalated observation (effective
  urgency above the band's low bound) arriving in a held debounce batch flushes the **whole** batch
  early — it is not split (held-first ordering preserved).
- **Supersedes** the earlier "ceiling" design (min(monitor, source)): a source may now escalate within
  an explicitly authored band, not only de-escalate under a fixed ceiling.
- **Proof:** `libs/core/src/schema/monitor-schema.test.ts` (band parse + inverted/invalid rejection);
  `libs/core/src/parser/parse-monitor.test.ts` (YAML round-trip of a range band, inverted rejection);
  `libs/core/src/runtime/service.test.ts` (salience within band escalates; clamp above/below band;
  degenerate band never escalates; escalation flushes the whole held debounce batch without splitting).
- Minor changeset: `@agentmonitors/core` (public `Observation.salience`, `MonitorFrontmatter.urgencyMax`,
  and the banded-urgency / salience runtime semantics).

## 2026-06-13 — Tick reports errored observations instead of a silent `emitted 0` (002 §2.4, §10.1, §10.2)

`RuntimeTickResult` gains an `erroredObservations: { monitorId, message }[]` field, populated from the
same code path that writes each `errored` row to `observation_history` (single source of truth, no
re-scan). `daemon once` and the `daemon run` periodic tick log now surface a non-zero errored count and
each errored monitor's id + message without a verbose flag — e.g.
`Evaluated 3 monitor(s), emitted 0 event(s), 1 errored:` followed by `  <monitorId>: <message>` lines.
Previously the tick printed a clean `emitted 0 event(s)` even when a monitor's `observe()` threw, so an
author could not distinguish a genuine no-change (not a bug) from a broken source. The genuine
no-change case is unchanged (no errored line — the command must not "cry wolf").

- **Proof:** `libs/core/src/runtime/service.test.ts` (errored monitor surfaced on the tick result with
  its message, including the non-Error throw fallback; a no-change tick has empty `erroredObservations`);
  `apps/cli/src/commands/cli.integration.test.ts` (`daemon once error visibility (issue #117)`: error-only,
  genuine no-change, and a mixed errored/emitted/no-change tick all reported truthfully).
- Minor changeset: `@agentmonitors/core` (new `erroredObservations` field + `ErroredObservation` in the
  public surface) and `@agentmonitors/cli` (user-visible tick output).

## 2026-06-13 — `monitor explain` healthy/idle status, workspace scoping, and connection-only fallback (002 §10.7, 005 §6)

Three corrections to the #94 `monitor explain` command (review of PR #98):

- **Healthy/idle is not a failure.** A `no-change` or `rebaselined` observation outcome now maps to a
  new `healthy` stage status (rendered `○`, distinct from `✓` delivered and `✗` failure) with an
  affirmative verdict ("Source ran, observed 0 changes — your watched target genuinely hasn't changed
  (not a bug)."). Previously a perfectly idle monitor rendered as an error (`✗`/`failure`),
  contradicting #94's contract that "your watched thing genuinely didn't change" is not a bug. When
  the latest observation is `healthy`, the downstream materialization and delivery stages report
  `healthy` for the expected absence of events/projections rather than `✗`. `failure` is reserved for
  real faults (errored observe, invalid definition, missing projection, daemon down). The new status
  is carried in `--format json` as `"status": "healthy"`.
- **Workspace scoping (session isolation).** The inbox DB is global, so the same `monitorId` can
  exist in multiple workspaces. `explainMonitor()` now scopes the materialization stage to the
  explained workspace's `monitor_events` (plus workspace-agnostic events) and the delivery stage to
  that workspace's sessions (plus global sessions), so one workspace's report never counts another
  workspace's events or projections.
- **Connection-only fallback.** The daemon-unavailable fallback now fires only for a genuine
  connection failure (socket refused/absent or request timeout, surfaced as a typed
  `DaemonConnectionError`). A daemon-side application error is surfaced verbatim
  (`Explain failed: <message>`, exit 1) instead of being masked as "daemon not running".
- **Proof:** `libs/core/src/runtime/service.test.ts` (no-change + rebaselined → `healthy`/affirmative
  verdict, no downstream `✗`; cross-workspace event/projection isolation);
  `apps/cli/src/daemon-ipc.test.ts` (application error → plain `Error`, connection failure →
  `DaemonConnectionError`); `apps/cli/src/commands/cli.integration.test.ts` (live daemon application
  error surfaced, not masked).
- Minor changeset: `@agentmonitors/core` (new `healthy` value in the public `MonitorExplainStageStatus`
  union and workspace-scoped explain queries).

## 2026-06-12 — `command-poll` top-level json-diff ignore paths (003 §11.3)

Resolved issue #106 in [003 §11](./003-source-plugins.md): plain `command-poll` `json-diff`
monitors may now set top-level `change-detection.ignore-paths` to remove noisy fields before output
comparison, without requiring keyed-collection mode.

- **Behavior:** `change-detection.ignore-paths: [duration]` under `strategy: json-diff` suppresses
  changes that only affect the parsed JSON `duration` field, while changes to non-ignored fields
  still emit the ordinary command-output `modified` observation.
- **Validation:** `command-poll` `change-detection` now has an explicit allow-list. Unknown keys
  such as `bogus-nonsense-key` fail `agentmonitors validate` instead of validating cleanly and
  silently no-oping. Top-level `ignore-paths` is valid only with `strategy: json-diff`.
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the plain `json-diff`
  suppression path, and `apps/cli/src/commands/cli.integration.test.ts` covers rejection of unknown
  `change-detection` keys.

## 2026-06-12 — Keyed-collection paths accept bare dotted authoring form (003 §12)

Resolved an authoring compatibility gap in [003 §12](./003-source-plugins.md): keyed-collection
`path` and `ignore-paths` now accept either explicit-root dotted paths (`$.items`, `$.duration`) or
bare root-relative dotted paths (`items`, `duration`). The two forms are equivalent. This preserves
the original minimal dotted grammar (no wildcards, array indices, filters, or recursive descent)
while matching the monitor-author shorthand used in real `command-poll` configurations.

- **Behavior:** `change-detection.collection.path: items` now resolves to the root `items` array and
  emits per-object `modified`/`created`/`descoped` observations the same way `$.items` does.
  `ignore-paths: [duration]` is treated as element-relative `$.duration`.
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` covers bare `path` and
  `ignore-paths`; `plugins/source-command-poll/src/index.test.ts` covers the issue #105
  modify/create/descope sequence with `path: items`.

## 2026-06-12 — Keyed-collection change detection shipped (003 §12 target→current; G9 retired)

The `change-detection.collection` mode now turns a poll source's parsed JSON output into a
collection of keyed objects, promoting [003 §12](./003-source-plugins.md) from **target** to
**current** with `verified:` references.

- **Shared core helper.** The per-object diff is implemented **once** as `diffKeyedCollection`
  (`libs/core/src/observation/keyed-collection.ts`, exported from `libs/core/src/index.ts` alongside
  `parseKeyedCollectionConfig` and `resolveDottedPath`) and consumed by **both** `api-poll` and
  `command-poll`. The create/modified/descoped semantics are identical across the two sources;
  sharing the helper avoids a divergence risk that per-plugin copies would carry.
- **Semantics (§12 verbatim).** Each array element becomes a tracked object with
  `objectKey = <monitor-objectKey>#<key-value>`; per-object observations use the existing
  `ChangeKind` vocabulary — `created` (key appears), `modified` (present in both, content differs
  after `ignore-paths` removal), `descoped` (key disappears — never `deleted`). The baseline run
  records the keyed snapshot and emits nothing; reordering and whitespace are inherently ignored
  (comparison is per-key, not positional).
- **`path` syntax (resolving §12's open design point).** `path` is a **minimal `$.`-prefixed dotted
  path** (root `$`, then `.field` segments — `$.tasks`, `$.data.items`); no wildcards, indices,
  filters, or recursive descent. It MUST select exactly one array (a non-array/missing resolution is
  an error). `ignore-paths` entries use the same syntax, relative to each element.
- **BP3 rejection.** A `collection` block is only valid under `strategy: json-diff`. Under
  `text-diff`/`exit-code` (or a defaulted strategy) it is rejected by `agentmonitors validate` with
  `change-detection.collection requires strategy: json-diff` — enforced both by each source's
  generated schema (`if/then`) and by the shared `validate` path (for the actionable message).
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` (re-sorted → zero observations;
  one element changing → one `modified` with the keyed `objectKey`; addition → `created`; removal →
  `descoped`, not `deleted`; `ignore-paths` suppression; path-not-an-array error); per-source
  integration tests in `plugins/source-api-poll/src/index.test.ts` and
  `plugins/source-command-poll/src/index.test.ts`; and the `validate` rejection/acceptance tests in
  `apps/cli/src/commands/cli.integration.test.ts`. Roadmap **G9** retired.
- Minor changesets: `@agentmonitors/core` (new exported helper), `@agentmonitors/source-api-poll`
  and `@agentmonitors/source-command-poll` (new collection mode).

## 2026-06-12 — Clarify source config wording and old-shape validation hints (003 §7.3, 004 §2.1–§2.3/§3.5, 005 §3/§7.1)

Issue #92 resolves the remaining author-facing ambiguity after the `watch: { type, ... }` migration.
`source list` text now says `Config fields` instead of `Scope fields`, JSON output includes
`configFields` while keeping `scopeFields` as a backwards-compatible alias, and `validate` appends a
targeted hint when a monitor still uses the old top-level `source:` + `scope:` shape. The specs now
distinguish the plugin API term `scopeSchema` from the authoring surface: source config is written
flat inside `watch:` alongside `type`.

- CLI behavior/docs/tests; patch changeset for `@agentmonitors/cli`.

---

## 2026-06-12 — `command-poll` source shipped (003 §11 target→current; G8 retired)

The local-process sibling of `api-poll` is now a bundled source, promoting
[003 §11](./003-source-plugins.md) from **target** to **current** with `verified:` references.

- **New package `@agentmonitors/source-command-poll`** implements §11.1–§11.6 verbatim: argv-only
  `command` spawned directly (`execFile`, `shell: false` — never a shell, so metacharacters pass
  through as literal arguments); `cwd`/`env`/`timeout`/`key`/`interval` scope; `text-diff` (default) /
  `json-diff` / `exit-code` strategies; a 1 MiB stdout cap marking `truncated: true` and diffing
  stably on the capped leading slice; SIGTERM→SIGKILL-after-5s timeout handling that leaves no orphan
  process; `stateful` baseline (first successful run records `{ stdout, exitCode }` and emits
  nothing); and transition-edge failure health (`ok ↔ failing` observations only on the edge — a
  nonzero exit **with** output is a result that gets diffed, while spawn failure and timeout are
  failures that keep prior state). `env` values are never written to any payload, snapshot, or state
  row.
- **Registered** via `registerCoreSources` (`apps/cli/src/sources.ts`) and scaffolded by
  `agentmonitors init --type command-poll` (`apps/cli/src/commands/init.ts`).
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the §11.7 list (no-shell
  metacharacter pass-through, per-strategy detection, nonzero-exit-is-a-result, spawn/timeout
  transition edges, env-not-persisted, 1 MiB stable truncation, no-orphan-on-timeout);
  `apps/cli/src/commands/cli.integration.test.ts` covers registration, the init template, and
  `validate` accepting/rejecting a `command-poll` monitor. Roadmap **G8** retired.
- Keyed-collection (§12) and the cursor protocol (§13) remain unbuilt targets (roadmap G9).
- Minor changesets: `@agentmonitors/source-command-poll` (new package) and `@agentmonitors/cli` (new
  source registered + init template).

## 2026-06-12 — `command-poll` implementation correction: `snapshot.command` is the argv array (003 §11.4)

Corrected `changedObservation()` in `plugins/source-command-poll/src/index.ts`: `snapshot.command`
was incorrectly set to `scope.objectKey` (the joined-argv string or `key` override) instead of the
argv array (`scope.command`). §11.4 specifies `snapshot: { command, exitCode, stdoutLength,
strategy }` where `command` is the argv array — matching `payload.command`. This was a behavioral
deviation from the spec; the spec wording is unchanged (it was always correct).

Also tightened `isCommandState()` to require `typeof truncated === 'boolean'`, preventing a
malformed `previousState` (e.g. `truncated: "yes"`) from being accepted and re-persisted through
the failure-path state carry-forward.

## 2026-06-12 — Activation skill authors verified-firing monitors from intent (006 §5.6)

Issue #95 upgrades the activation plugin's bundled `setup-monitors` skill from setup/scaffolding
guidance into an intent-to-working-monitor workflow. The skill frontmatter now triggers on plain
language authoring requests ("watch this file", "tell me when...", "notify me when..."), and the
body instructs agents to select the smallest shipped source type, ask only for required config,
write the monitor body as user judgment, run `agentmonitors validate`, and verify that the monitor
fires before calling setup done. The debug playbook now routes "it didn't fire" reports through
`agentmonitors monitor explain` rather than ad hoc guessing.

- Plugin-skill/test/docs only; no published package changeset.

## 2026-06-12 — `monitor explain` diagnosis command and read-only IPC report (002 §10.5–§10.7, 005 §6)

Issue #94 adds an author-facing pipeline diagnosis command:
`agentmonitors monitor explain <monitorId>`. The command returns a staged report for definition,
scheduling, observation, notify state, materialization, and projection/delivery, with text output
using `✓` / `✗` / `⏳` and a JSON report for agents. The daemon exposes a read-only
`monitor.explain` IPC method that composes the report from existing persisted runtime state:
`monitor_state`, `observation_history`, `monitor_events`, `session_event_state`, and
`agent_sessions`. The CLI also has a daemon-unavailable fallback that validates the local
definition, then reports scheduling as failed because the daemon is not running or unreachable.

- Minor changesets for `@agentmonitors/core` (new public explain report/runtime API) and
  `@agentmonitors/cli` (new command and IPC wrapper).

## 2026-06-11 — Steel-thread UAT now drives the plugin's literal `hooks.json` command strings (004 §3.5 config-drift coverage)

Follow-up to the steel-thread entry below (issue #89, review point 2 of #83, deferred at merge). The
existing steel-thread UAT drives `['session','start']` / `['hook','deliver']` as **argv** with
hand-built stdin — it proves the CLI's stdin contract but skips the seam the #83 bug actually lived
in: the mismatch between the plugin's `hooks.json` command **strings** and that contract (the
now-removed vestigial `&& agentmonitors hook deliver` chain was dead precisely because the first
command had already consumed stdin — invisible to an argv-level test).

A new **plugin hooks.json config-drift UAT** (`apps/cli/src/commands/cli.integration.test.ts`) closes
that gap: it parses the real
[`agent-plugins/agentmonitors/hooks/hooks.json`](../../agent-plugins/agentmonitors/hooks/hooks.json)
at test time (no copies) and runs each `SessionStart` / `UserPromptSubmit` / `SessionEnd` command
**verbatim** through `/bin/sh -c`, with an `agentmonitors` PATH shim satisfying the commands' own
`command -v agentmonitors` guard. It asserts the same end-to-end outcomes as the steel thread (daemon
boots + session registers; the dropped monitor's body arrives as `additionalContext`; session
deregisters; no orphan daemons) plus the missing-CLI fallback branch (empty PATH → the printed
fallback JSON parses and carries the `npm i -g @agentmonitors/cli` install hint). The test therefore
fails if a command string drifts incompatibly (a flag re-added, the binary renamed, the chain
broken), if the stdin contract regresses, or if the fallback emits invalid JSON. Recorded as a new
[004 §3.5](./004-validation-testing.md) scenario row.

- Test-and-spec only — no implementation or published-package behavior change, so no changeset.

## 2026-06-11 — `command-poll` source specified as target (003 §11–§13); 003 examples migrated to `watch:` syntax

Issue #81's problem framing is resolved into a normative **target** design (PP7) in
[003](./003-source-plugins.md):

- **§11 `command-poll`** — the local-process sibling of `api-poll`. Field-level scope (`command`
  argv array, `cwd`, `env`, `timeout`, `key`, `interval`, `change-detection`), execution model
  (1 MiB stdout cap, SIGTERM→SIGKILL timeout), strategies (`text-diff` default / `json-diff` /
  `exit-code`), identity and stateful baseline mirroring `api-poll`, and transition-edge failure
  semantics (`ok ↔ failing` health observations; **nonzero exit with output is a result, not a
  failure**). #81's open questions are decided in-spec: argv-only (no shell form, ever);
  env = inherit + literal overrides, never persisted; v1 executes without acknowledgment (a
  `MONITOR.md` is workspace code, same trust class as `package.json` scripts) with a
  command-acknowledgment ledger designed as target (§11.6); `exit-code` stays first-class;
  `observe()`-only in v1.
- **§12 keyed-collection change detection** — generic `change-detection.collection` mode
  (`path`/`key`/`ignore-paths`) emitting per-object observations with
  `created`/`modified`/`descoped`; applies to `api-poll` and `command-poll`; separable.
- **§13 caller-held cursor protocol** — sketch-only target ({{state}} argv templating +
  `next-state` extraction), deliberately not scheduled; the mtime pre-gate and monitor-chaining
  alternatives are recorded as rejected (003 §11.8), adopting #81's reasoning.
- **Roadmap:** new items G8 (`command-poll`, P2) and G9 (keyed collections, P3) with proofs.
- **Migration cleanup:** 003's YAML examples and schema-generation description still used the
  pre-migration `source:`/`scope:` authoring syntax; all examples now use the current
  `watch: { type, … }` shape ([001 §3.1](./001-monitor-definition.md)) and §7.2 reflects the
  actual generated schema (`watch`/`urgency` required, `watch.type` enum + conditional config).
- Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-11 — Follow-up: §10 session-id-equality question marked resolved (006 §10)

Review follow-up to the entry below (the PR merged before the review comment was addressed): the
2.1.160 re-verification already answered the **next** §10 open question — "confirm
`CLAUDE_CODE_SESSION_ID` equals the `hostSessionId` the `SessionStart` hook passes to
`session open`". The env var equals the live session id (verified), and the hook passes the stdin
`session_id`, which is by the hooks contract that same live id — so both transports resolve the same
identifier. The bullet is now marked **Resolved (2.1.160)** with the same observed-not-contracted
caveat. Docs-only; no changeset.

## 2026-06-11 — Channel session binding re-verified; `CLAUDE_CODE_SESSION_ID` is observed-not-documented (006 §4.4)

Prompted by the just-merged session-lifecycle stdin fix (hooks read `session_id` from stdin, **not**
an env var): does the same "no session-id env var" trap apply to the channel server, which runs as an
**MCP server** rather than a hook? Verified it does **not**.

- **Confirmed: an MCP-server subprocess receives `CLAUDE_CODE_SESSION_ID`.** Re-confirmed live against
  Claude Code 2.1.160 (the variable is present in MCP/child-process environments and its value exactly
  equals the live session id), corroborating the 2026-05-31 `experiments/channel-probe` run on 2.1.157.
  So `agentmonitors channel serve` resolving its session via `process.env['CLAUDE_CODE_SESSION_ID']`
  (`apps/cli/src/commands/channel.ts`) is correct — **no code change**. The hooks/stdin trap does not
  transfer: a hook is a short-lived per-event command (session id arrives on stdin), whereas the
  channel server is a long-lived MCP subprocess that inherits Claude Code's process environment.
- **Doc-precision correction.** The previous §4.4 cited <https://code.claude.com/docs/en/mcp.md> in a
  way that implied all three signals are documented. They are not: the current MCP reference documents
  only `CLAUDE_PROJECT_DIR` and `roots/list`; it is **silent** on `CLAUDE_CODE_SESSION_ID`. §4.4 now
  marks the two workspace signals **documented** and the session-id signal **empirically observed but
  undocumented** (host-version-dependent), with workspace binding (§4.4 #2) as the documented-safe
  fallback. Added an explicit hooks-vs-MCP contrast citing <https://code.claude.com/docs/en/hooks.md>
  (hook session id = stdin `session_id`; documented hook env vars do not include it).
- Updated the §10 open-question note to record the 2.1.160 re-confirmation and the observed-not-
  contracted caveat. Docs-only; no published-package behavior change, no changeset.

## 2026-06-11 — `session start`/`session end` read the host session id from stdin; steel-thread UAT

**Correction (production bug).** `session start` and `session end` previously read the host session
id from `process.env['CLAUDE_CODE_SESSION_ID']` and quick-exited when it was absent. That env var
**does not exist** in a real Claude Code hook invocation (input arrives as JSON on stdin — the same
issue [`hook deliver`](./006-agent-integration.md) was already corrected for). The effect was severe:
in a real session `session start` returned before booting the daemon, so the session never
registered, and the entire activation chain (lazy daemon boot + delivery) silently no-opped in
production. Plan B's tests passed only because they set the env var manually.

Both commands now read the **stdin hook payload** (006 §5.0): `hostSessionId = payload.session_id`
(no env fallback), `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? process.cwd()`. The shared
stdin reader (`readHookPayload` + `HookPayload`) is extracted to `apps/cli/src/hook-payload.ts` and
imported by `hook deliver`, `session start`, and `session end`. Documented in
[006 §5.0/§5.6](./006-agent-integration.md) and [005 §10.4/§10.5](./005-cli-reference.md).

- **Single-process `SessionStart` (one stdin stream).** A Claude Code hook invocation provides **one**
  stdin stream, and both `session start` and `hook deliver` consume all of stdin via
  `readHookPayload()`. So a chained `agentmonitors session start && agentmonitors hook deliver`
  (the previous SessionStart hook form) is broken: `session start` consumes the payload and the
  chained `hook deliver` sees EOF, parses `{}`, and silently no-ops — killing the post-compact recap.
  Fixed by folding the recap into `session start`: it reads the payload **once**, registers, then
  claims `post-compact` and prints the rendered `additionalContext` itself. The SessionStart hook
  (`agent-plugins/agentmonitors/hooks/hooks.json`) now runs the single command
  `agentmonitors session start`. Documented in [006 §5.6](./006-agent-integration.md).
- **Steel-thread UAT added** (Plan D Task 4): an end-to-end CLI integration test that drives the
  `UserPromptSubmit` delivery path over **stdin** — a dropped file-fingerprint monitor + a
  watched-file change ends with the agent handed that monitor's own body-instruction as
  `additionalContext` at the turn boundary. A companion test drives the **actual shipped SessionStart
  command form** (one subprocess, one stdin payload) and asserts the post-compact recap is surfaced by
  that single command — the regression guard for the single-stdin-stream bug above. The Plan B
  lifecycle tests were migrated from `CLAUDE_CODE_SESSION_ID` to stdin payloads so they fail against
  the old env-reading code, locking the stdin contract so the env-var regression cannot return.
- **Follow-up — now resolved (see the channel-binding entry above):** the question of whether
  `channel serve` (`apps/cli/src/commands/channel.ts`) shares the same "no session-id env var" trap was
  verified separately and answered **no** — an MCP-server subprocess _does_ receive
  `CLAUDE_CODE_SESSION_ID` (re-confirmed against 2.1.160), so the channel server's
  `process.env['CLAUDE_CODE_SESSION_ID']` resolution is correct and needs no change. The hooks/stdin
  trap does not transfer (hook = short-lived per-event command with the id on stdin; channel = long-lived
  MCP subprocess that inherits the process environment).
- `@agentmonitors/cli` patch changeset included.

## 2026-06-10 — Activation plugin via a colocated aipm marketplace; `channel-plugin/` folded in

Activation now ships as a single installable Claude Code plugin (`agentmonitors`) in a colocated
[aipm](https://www.npmjs.com/package/@ai-plugin-marketplace/cli) marketplace embedded in this repo
(`agent-plugins/`, with `aipm.repo.ts` relocating `pluginsRoot` off the package `plugins/` glob).
The plugin wires the host lifecycle to the already-built CLI verbs — `SessionStart` →
`agentmonitors session start` then `agentmonitors hook deliver`, `UserPromptSubmit` →
`agentmonitors hook deliver`, `SessionEnd` → `agentmonitors session end` — and bundles the channel
MCP and a `setup-monitors` skill. Install once; thereafter a project opts in with project-local
state (no reinstall per monitor). Documented in [006 §5.6](./006-agent-integration.md).

- **Folded + retired `channel-plugin/`.** The standalone root `channel-plugin/` is removed; its
  `.mcp.json` (server key `agentmonitors`, preserving the `<channel source="agentmonitors">` tag)
  now lives at `agent-plugins/agentmonitors/.mcp.json` inside the activation plugin. The 2026-06-01
  entry below remains as a historical record of the original standalone packaging.
- **`PreToolUse`/`Stop` deliberately unwired** (they ignore `additionalContext`); `PostToolUse` left
  as a documented future tunable (per-tool firing → too many daemon round-trips for v1).
- **Targets: `claude` only.** aipm v0.3.0 does not generate Codex hooks and only Claude Code has the
  channel transport, so a non-Claude target would ship no working delivery path.
- **Hooks authored as host-native `hooks/hooks.json`.** aipm v0.3.0's Claude hooks transform only
  models `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`, so the lifecycle events
  (`SessionStart`/`SessionEnd`) are authored directly as a Claude-native `hooks/hooks.json`
  referenced from the plugin manifest, rather than via aipm's YAML→JSON generation.
- CLI/plugin-content only — no published-package behavior change, so no changeset.

## 2026-06-10 — Correction: `hook deliver` reads stdin JSON; corrected event support; truncation marker

Supersedes the input/event-support details of the Plan D entry below after verifying against the
current Claude Code hooks docs (<https://code.claude.com/docs/en/hooks.md>). Three corrections:

- **Input is stdin JSON, not env vars.** Claude Code delivers hook input as a JSON object on stdin
  (`session_id`, `cwd`, `hook_event_name`, …). There is **no `CLAUDE_CODE_SESSION_ID` environment
  variable** — the prior `hook deliver` relied on one and would silently no-op in real sessions. The
  command now reads stdin (robust against a TTY/empty/unparseable stream — it never hangs), derives
  `sessionId = payload.session_id` (no env fallback), `hookEventName = payload.hook_event_name`, and
  `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? cwd`.
- **`additionalContext` is honored only by context events.** Per the docs, only `UserPromptSubmit`,
  `SessionStart`, and `PostToolUse` honor `hookSpecificOutput.additionalContext`; `PreToolUse` (uses
  `permissionDecision`) and `Stop` (uses a top-level `decision`) do **not**. The old default
  `--hook-event-name PreToolUse` therefore targeted an event that ignores the context. The
  `--hook-event-name` flag is **removed**; the lifecycle is now **derived** from `hook_event_name`
  (`UserPromptSubmit`/`PostToolUse` → `turn-interruptible`, `SessionStart` → `post-compact`; any
  other event → emit nothing). `--lifecycle` remains as an optional override (mainly for tests). One
  command line — `agentmonitors hook deliver` — now works for every registered event.
- **Code-point-safe truncation with an explicit marker.** When the rendered context exceeds the
  4000-char cap it is truncated at a Unicode code-point boundary (never splitting a surrogate pair)
  and an explicit `[truncated — … run "agentmonitors events list --unread" …]` marker is appended
  (final string still ≤ cap). Truncation does **not** lose events: claiming marks rows claimed, not
  acknowledged (`unreadEventsForSession` filters on `acknowledgedAt IS NULL` only), so a
  truncated-away event stays **unread** and re-delivers via the next context event.

Docs updated: [006 §5.0/§5.1/§5.2/§5.3/§5.4/§5.5](./006-agent-integration.md),
[005 §12.2](./005-cli-reference.md). Tests: stdin-driven `hook deliver` integration tests, a
truncation-recoverability integration test (truncated-away events still in `events list --unread`),
and renderer truncation-marker + surrogate-pair unit tests.

---

## 2026-06-09 — Package scope rename: `@mike-north/*` → `@agentmonitors/*`; public npm publish

All published packages now use the `@agentmonitors` npm scope published to public npm
(`https://registry.npmjs.org`), replacing the previous `@mike-north` GitHub Packages scope.
The CLI (`@agentmonitors/cli`) is now a publishable package (no longer `private: true`); the
canonical install is `npm install -g @agentmonitors/cli`.

Packages renamed:

- `@mike-north/core` → `@agentmonitors/core`
- `@mike-north/source-file-fingerprint` → `@agentmonitors/source-file-fingerprint`
- `@mike-north/source-api-poll` → `@agentmonitors/source-api-poll`
- `@mike-north/source-schedule` → `@agentmonitors/source-schedule`
- `@mike-north/source-incoming-changes` → `@agentmonitors/source-incoming-changes`
- `@mike-north/cli` → `@agentmonitors/cli`
- `@mike-north/website` → `@agentmonitors/website`

Release pipeline: `release.yml` now uses `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (repo
owner must add the `NPM_TOKEN` secret). Changeset `access` set to `"public"`.

No spec behavior changes. All package references in docs, source files, and tooling updated.

---

## 2026-06-10 — Plan D Tasks 2–3: hook-deliver renderer + `hook deliver` command

- Added `apps/cli/src/hook-deliver-render.ts` — a **pure, side-effect-free renderer** that maps a
  `DeliveryClaim` to the Claude Code hook wire shape
  `{ continue: true, hookSpecificOutput: { hookEventName, additionalContext } }`. Returns `null`
  when the claim is null or has no events. `additionalContext` is capped at 4000 characters; unlike
  the channel transport (§4.6), it is a plain JSON string that is **not** tag-delimited, so
  markdown/code punctuation (`<>`, `[]`, `;`) and newlines are preserved verbatim (a monitor body is
  trusted, user-authored markdown) — only raw C0/C1 control characters (except tab/newline) are
  stripped. The rendered context includes a lead line and one block per event: monitorId, urgency,
  title, and the monitor's `body`-instructions from `DeliveryEventSummary.body`.
- Added `hook deliver` subcommand to `apps/cli/src/commands/hook.ts`. Designed to run as a Claude
  Code lifecycle hook (`PreToolUse`, `Stop`, `PostCompact`). Reads `CLAUDE_CODE_SESSION_ID` +
  `CLAUDE_PROJECT_DIR` from env, resolves the daemon socket via `.local.md`, looks up the session,
  claims pending deliveries at the given `--lifecycle`, renders, and writes the wire JSON to stdout.
  **Always exits 0** — any internal error is swallowed (a hook that exits non-zero would interrupt
  the user's session). Prints nothing when there is nothing pending.
- [005 §12.2](./005-cli-reference.md) added (`hook deliver` command reference, flags, wire output,
  always-exit-0 contract).
- [006 §5](./006-agent-integration.md) added (hook-deliver transport spec: wire contract, behavior
  steps, lifecycle-to-delivery mapping, and hook registration examples).
- `.changeset/hook-deliver-command.md`: `@agentmonitors/cli` minor (new `hook deliver` command).

---

## 2026-06-09 — Plan D Task 1: `DeliveryEventSummary` carries the monitor `body`

- A new required field `body: string` is added to `DeliveryEventSummary`
  (`libs/core/src/runtime/types.ts`). It carries the raw monitor body-instructions
  (`MonitorEventRecord.body`, set from `observation.body ?? monitor.instructions`), so a delivery
  transport can surface what the agent should **do** when a monitor fires — not just the
  `title`/`summary`.
- `claimDelivery()` in `service.ts` populates `body: event.body` in both places that map events to
  `DeliveryEventSummary`: the settled-high (`turn-interruptible`) path and the recap
  (`post-compact`) path. The `normal` and `low` paths return `events: []` and are unaffected.
- `DeliveryEventSummary` is re-exported from the public index; the api-extractor rollup
  (`dist/public.d.ts`) is updated to include the new field.
- [002 §9.1](./002-runtime-delivery.md) and [002 §9.4](./002-runtime-delivery.md) updated to
  document the `body` field. [006](./006-agent-integration.md) updated to reflect the enrichment.

## 2026-06-09 — Lazy project-scoped daemon (Plan B)

CLI-only change (no `@agentmonitors/core` public API change; no changeset needed).

**New files:**

- `apps/cli/src/workspace-paths.ts` — `workspacePaths(workspacePath)` derives a stable per-workspace
  `{ dir, db, socket }` under `XDG_DATA_HOME ?? ~/.local/share/agentmonitors/workspaces/<hash>/`.
- `apps/cli/src/local-state.ts` — `readLocalState`/`writeLocalState` for
  `.claude/agentmonitors.local.md` (minimal YAML frontmatter: `enabled`, `socket`, `db`,
  `reap-after-ms`). Absent/unparseable → `{ enabled: false }` (quick-exit).
- `apps/cli/src/detached-spawn.ts` — `spawnDetachedDaemon()` spawns `daemon run` with
  `detached: true, stdio: 'ignore'`, `.unref()`. The spawner exits; the daemon runs in the background.

**Modified files:**

- `apps/cli/src/commands/session.ts` — adds `session start` (lazy-boot daemon + `session.open`) and
  `session end` (finds session by `hostSessionId`, calls `session.close`). Both are no-ops when
  `CLAUDE_CODE_SESSION_ID` is absent or `enabled: false`.
- `apps/cli/src/commands/daemon.ts` — adds `--reap-after-ms <ms>` to `daemon run` (default 300000;
  0 disables). After each tick, the daemon counts active sessions for the workspace; if zero for
  `reapAfterMs` ms continuously, it stops itself.

**Spec updates:**

- [002 §10.2](./002-runtime-delivery.md#102-daemon-run--continuous-loop--unix-socket-server) — lazy
  boot, per-workspace isolation, idle reaping.
- [005 §9.2](./005-cli-reference.md#92-daemon-run--continuous-loop), [§10.4](./005-cli-reference.md#104-session-start--lazy-boot-daemon-and-register-session),
  [§10.5](./005-cli-reference.md#105-session-end--deregister-session) — `session start`/`session end` + `--reap-after-ms`.

## 2026-06-09 — `rebaselined` observation outcome and `ObservationResult.outcome` diagnostic

- A new optional field `outcome?: 'rebaselined'` is added to `ObservationResult`
  (`libs/core/src/observation/types.ts`). A source can set this to signal that it advanced its
  persisted baseline to the current point but could not compute a delta (e.g. a gc'd or
  force-pushed prior ref), as opposed to a genuine quiet tick.
- A new `ObservationOutcome` member `'rebaselined'` is added to the union in
  `libs/core/src/runtime/types.ts` and to the drizzle enum in `libs/core/src/inbox/schema.ts`.
- `ingest()` in `service.ts` maps `sourceOutcome: 'rebaselined'` to the new history result, with
  correct precedence: emitted > 0 → `triggered`; else if `rebaselined` → `rebaselined`; else
  observed > 0 → `suppressed`; else → `no-change`.
- The `incoming-changes` source (`plugins/source-incoming-changes`) now sets `outcome: 'rebaselined'`
  on the diff-failure re-baseline path (the `entries === undefined` branch). The other early-return
  paths (not-a-repo, initial baseline, genuine no-advance) are left unchanged.
- `agentmonitors monitor history` help text updated to include `rebaselined` in the result legend.
- [002 §`observation_history`](./002-runtime-delivery.md) and [005 §6](./005-cli-reference.md) updated.
- Issue: [#56](https://github.com/mike-north/AgentMonitors/issues/56).

## 2026-06-08 — Authoring surface → `watch: { type }` (closes #41)

Replace the mechanism-first `source:` + `scope:` frontmatter pair with an
intent-first `watch:` block carrying an explicit `type` discriminator. This is a
**hard cut** — the old `source:`/`scope:` shape no longer validates.

### New canonical shape

```yaml
name: ...               # optional, unchanged
watch:
  type: <source-name>   # e.g. file-fingerprint, api-poll, schedule, incoming-changes
  <...per-source config flat here...>
urgency: normal         # unchanged
notify: {...}           # optional, unchanged
tags: [...]             # optional, unchanged
```

Per-source config keys (including `interval`) live **flat inside `watch:`** as
siblings of `type`. There is no nested `scope:` object.

### Files changed

- `libs/core/src/schema/monitor-schema.ts`: replaced `source` (string) + `scope`
  (record) with `watch` (object with validated `type` + `.catchall(z.unknown())`
  for per-source config).
- `libs/core/src/runtime/service.ts`: all `frontmatter.source` → `frontmatter.watch.type`;
  all `frontmatter.scope` → `watchConfig(frontmatter.watch)` (helper that returns the
  `watch` block minus `type`).
- `libs/core/src/schema/validate-scope.ts`: unchanged — callers now pass the watch config
  object (watch minus type) instead of `scope`.
- `libs/core/src/observation/schema-generator.ts`: updated to discriminate on
  `watch.type` instead of `source`; required fields are now `['watch', 'urgency']`.
- `apps/cli/src/commands/init.ts`: all templates rewritten to `watch:` shape; `--source`
  option renamed to `--type`.
- `apps/cli/src/commands/validate.ts`, `scan.ts`, `monitor-test.ts`: updated to read
  `frontmatter.watch.type` instead of `frontmatter.source` and pass watch config to
  `validateScope`.
- `.claude/monitors/spec-changes/MONITOR.md`: dogfood monitor converted to `watch:` shape.
- All test fixtures in `libs/core/src/` and `apps/cli/src/` updated.
- `docs/specs/001-monitor-definition.md` §3 updated to document `watch:` block.

### api-extractor

`monitorFrontmatterSchema` and `MonitorFrontmatter` public API changed; report
regenerated.

## 2026-06-08 — Reconcile `changeKind` vocabulary (closes #42)

The `changeKind` vocabulary is now canonical across the standard and the codebase. The
four values `created | modified | deleted | descoped` were already the implementation
contract in `libs/core/src/observation/types.ts`; this entry records the corresponding
update to the outward standard.

- `docs/standard/monitor-md-standard.md` §2: replaced the five-row table (which listed
  `appeared` and `elapsed`) with the four canonical values; folded "a new member of a
  collection/feed appeared" into the `created` row; removed the "being reconciled"
  caveat blockquote (the vocabularies now agree).
- `libs/core/src/observation/types.ts`: rewrote the `ChangeKind` doc-comment to make
  `created` and `descoped` crisply distinct. `created` = a new object or member entered
  the monitor's scope (including new items in a watched collection/feed); `descoped` =
  still exists upstream but left the monitor's scope (no information lost).
- No runtime behavior change — the type was already `created | modified | deleted | descoped`.

## 2026-06-08 — Per-monitor `observe()` failure isolation and `errored` outcome

- The runtime now **isolates per-monitor failures in `tick()`**: if a source's `observe()` throws
  or rejects, the failure is caught, an `errored` observation-history row is recorded, and the tick
  continues to the next due monitor. A single buggy source can no longer abort the entire tick and
  starve all other monitors ([002 §`observation_history`](./002-runtime-delivery.md)).
- The same isolation is applied to the **watch path** (`consumeWatch()`): an `ingest()` failure on
  one yielded observation records an `errored` history row and the watcher continues consuming
  subsequent observations. The outer catch (for errors from the async iterator itself) is unchanged.
- **State preservation on failure**: `ingest()` is not called for a failing monitor, which means
  `setMonitorState()` is never reached. The persisted `sourceState` is left exactly as it was after
  the last successful tick, so the next tick's diff spans from the last good baseline rather than
  from an empty state — no subsequent delta is dropped.
- **New `ObservationOutcome` member**: `'errored'` is added to the
  `ObservationOutcome` union (`libs/core/src/runtime/types.ts`) and the drizzle enum in
  `libs/core/src/inbox/schema.ts`. The raw SQL in `libs/core/src/inbox/db.ts` uses `result TEXT NOT
NULL` with no CHECK constraint and needed no change.
- Minor `@agentmonitors/core` changeset (new public `ObservationOutcome` member + runtime guarantee).
- Issue: [#46](https://github.com/mike-north/AgentMonitors/issues/46).

## 2026-06-08 — New bundled source `incoming-changes`

- Added `@agentmonitors/source-incoming-changes` as the fourth bundled observation source
  ([003 §6](./003-source-plugins.md)). The source detects per-file changes when a git ref advances
  (pull, merge, fast-forward, or local commit) and reports them as `Observation` records with a
  `changeKind` (`created`/`modified`/`deleted`), `objectKey` (file path), `snapshotText` (new text
  content for created/modified non-binary files), and `payload: { path, status, fromRef, toRef }`.
- **Resumption token** = last-seen commit SHA (`nextState: { ref: '<sha>' }`). Restart-safe: on wake
  the diff spans `<stored-sha>..<current-head>` — the net change across all missed commits is
  reported in one batch (PP6).
- **v1 scope boundary**: fires on any ref advance touching `paths`; "fetch-only" filtering is a
  planned later refinement.
- **Error resilience**: `rev-parse` failures return an empty result with no `nextState`; `git diff`
  failures (gc'd SHA, history-rewritten range) trigger a silent re-baseline. Neither propagates to
  the tick loop.
- CLI registration and `init` scaffolding land with issue #39.
- Minor `@agentmonitors/source-incoming-changes` changeset (initial `minor`).

## 2026-06-07 — Remove `event-kind` frontmatter field

- `event-kind` (and its runtime counterparts `eventKind` / `event_kind`) are **removed** from the
  schema and the entire pipeline. The field was never surfaced in a delivered signal and served no
  runtime purpose. Affected: frontmatter schema ([001 §3](./001-monitor-definition.md)), required
  fields for JSON Schema generation ([003 §2](./003-source-plugins.md)), `monitor_events` and
  `inbox_items` DB columns ([002 §5/§12](./002-runtime-delivery.md)), delivery meta key table
  ([006 §4.2](./006-agent-integration.md)), CLI scan output and filter options
  ([005 §5/§9](./005-cli-reference.md)). No DB migration — a local no-users project. Minor
  `@agentmonitors/core` changeset.

## 2026-06-04 — Flat-file monitor authoring; `name` optional

- Monitors may now be authored as a flat `.claude/monitors/<id>.md` file (id = filename), in
  addition to the folder form `<id>/MONITOR.md` (id = directory). The scanner discovers both;
  markdown assets nested inside a folder monitor are not treated as monitors
  ([001 §scanning](./001-monitor-definition.md)). Verified: `parse-monitor.ts` id derivation and
  `scan-monitors.ts` combined glob.
- `name` is now **optional** in frontmatter and defaults to the monitor id. Minor
  `@agentmonitors/core` changeset.

## 2026-06-02 — Channel transport, automated end-to-end UAT

- Added `experiments/channel-uat/` — an MCP-client harness that verifies the channel **push** path
  ([006 §4](./006-agent-integration.md)) end to end without a live Claude session or a
  channels-enabled org. It starts a real daemon + monitor, spawns `agentmonitors channel serve`,
  connects to it over stdio as the MCP host (injecting `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR`
  exactly as Claude Code would), mutates the watched file, and asserts the `<channel>` push.
- Confirmed both delivery shapes: `normal` urgency pushes the coalesced reminder; `high` urgency
  pushes the concrete event (`event_count: 1`, `monitor_id`, `event_id`) after the ~15s settle.
- Retires the last G7 follow-up (the previously "manual, not CI-able" end-to-end UAT). Experiment-only
  (outside the workspace globs); no changeset.

## 2026-06-02 — Watch-mode source execution (G5)

- The runtime now drives continuous `watch()` for opt-in sources:
  `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)` consumes each watch-capable
  source's `AsyncIterable<Observation>` and funnels every yielded observation through the **same**
  notify dispatch → materialization → projection pipeline as `observe()` (extracted into a shared
  `ingest()` helper, which also records the `observation_history` audit row, so watch-mode
  observations are audited identically to ticked ones). Returns a `WatchHandle` whose `stop()` aborts
  and awaits the watchers ([002 §2.3](./002-runtime-delivery.md)). `daemon run` starts/stops watchers
  around its tick loop.
- A watched monitor is skipped by the tick loop's `observe()` (no double-processing); a watcher that
  throws outside its own abort is surfaced via `onError` and released so the tick loop resumes it.
- Added `ObservationContext.signal?: AbortSignal` (passed to `watch()` for teardown) and the exported
  `WatchHandle` type. Promoted **NP4** from "the runtime does not define watch-mode" to
  "watch-mode is opt-in and additive" ([000](./000-principles.md), [003 §2](./003-source-plugins.md)).
- Closes roadmap **G5**. No bundled source opts into `watch()` yet, but the path is exercised
  end-to-end (`libs/core/src/runtime/service.test.ts`). Minor `@agentmonitors/core` changeset
  (new `watchMonitors` method, `WatchHandle` type, `ObservationContext.signal` field).

## 2026-06-01 — Observation history audit trail (G6)

- The runtime now **writes `observation_history`** — for each due monitor per tick it records the
  outcome (`triggered` / `suppressed` / `no-change`) plus a `{ observed, emitted }` summary, via the
  new `RuntimeStore.recordObservationHistory` / `listObservationHistory`
  ([002 §"Persistence Schema"](./002-runtime-delivery.md)).
- Added a daemon IPC method `history.list` and the `agentmonitors monitor history [monitorId]`
  command to read it ([005 §6](./005-cli-reference.md)) — a "why didn't my monitor fire?" diagnostic.
- Closes roadmap **G6** (the dead table now has a write path **and** a reader). Runtime + CLI
  integration tests added; minor `@agentmonitors/core` changeset (new `RuntimeStore` methods, exported
  `ObservationHistoryRecord` / `ObservationHistoryQuery` / `ObservationOutcome` types, runtime write).

## 2026-06-01 — Channel transport, stage 3 (plugin packaging); G7 shipped

- Added `channel-plugin/` — a Claude Code channel plugin (`.claude-plugin/plugin.json` + `.mcp.json`)
  that runs `agentmonitors channel serve`, plus a README with the prerequisites and the manual UAT
  command. Lives at the repo root (outside the `plugins/*` workspace glob, since it is a plugin
  manifest, not an npm package).
- Marks the channel transport ([006 §4](./006-agent-integration.md)) implemented and retires roadmap
  **G7**. Non-blocking follow-ups remain: the end-to-end manual UAT (channels are research-preview)
  and optional `object_key` meta (needs `DeliveryEventSummary` enrichment).

## 2026-06-01 — Channel transport, stage 2 (two-way ack)

- `agentmonitors channel serve` is now two-way: it declares `capabilities.tools` and exposes the
  **`agentmon_ack`** tool (`apps/cli/src/channel-ack.ts`), which routes through `events.ack` for the
  bound session — the bound session id is the "outbound gate" (006 §4.3). Tool arguments are
  validated defensively at the MCP boundary (`parseAckArgs`, unit-tested). Session resolution is
  shared between the poll loop and the ack tool. Marked [006 §4.3](./006-agent-integration.md)
  implemented; updated roadmap G7 (remaining: plugin packaging + manual UAT). CLI-only; no changeset.

## 2026-06-01 — Channel transport, stage 1 (one-way push)

- Shipped `agentmonitors channel serve` ([005 §13](./005-cli-reference.md)): an MCP **channel**
  server that binds via `CLAUDE_CODE_SESSION_ID`, polls `claimDelivery('turn-interruptible')` over
  the daemon socket, and pushes each settled claim as a `<channel>` event. Reuses the claim path, so
  claimed-state and cross-transport dedup come for free; a missing daemon is handled quietly (the
  hook path still delivers). The claim→event renderer is unit-tested.
- Clarified [006 §2](./006-agent-integration.md): the transport seam needs **no in-process
  `DeliveryTransport` refactor** — the channel transport is realized out-of-process over the daemon
  IPC surface. Marked [006 §4.1](./006-agent-integration.md) one-way push as implemented; updated
  roadmap G7 (stage 1 done; remaining: ack tool + packaging + manual UAT).
- `apps/cli` is changeset-exempt, so no changeset. Also corrected a stale `validate` status in the
  005 command inventory (full schema validation since G2).

## 2026-06-01 — Closed remaining test gaps (T2, T4; T1 retired)

- **T2** — added `RuntimeStore` snapshot tests (save/retrieve + isolation by
  `(workspace, monitor, objectKey)`, SP5) and a runtime test asserting `diffText` is computed
  against the prior snapshot when an object changes.
- **T4** — added standalone CLI integration tests for `schema generate` (and `-o` output) and the
  `session list` → `session close` lifecycle.
- Retired the already-shipped **T1** (`low` urgency, #21) from the roadmap; all tracked test gaps
  (T1–T4) are now closed. Test-only change — no changeset.

## 2026-06-01 — First-class observation change-kind; file-fingerprint create/delete (G3)

- Introduced a **source-agnostic `changeKind`** primitive on the core `Observation` contract
  (`created` / `modified` / `deleted` / `descoped`), exported as the `ChangeKind` type. `deleted`
  (information lost upstream) and `descoped` (still exists upstream, left the monitor's scope) are
  deliberately distinct so agents react differently — e.g. a pull request _deleted_ vs _closed_.
  See [003 §2.3](./003-source-plugins.md).
- The runtime copies `observation.changeKind` into the materialized event's `queryScope.changeKind`
  ([002 §5.1](./002-runtime-delivery.md)), so it is filterable without each source duplicating it.
- `file-fingerprint` is the first emitter: it now reports `created` / `modified` / `deleted` /
  `descoped` (stat-ing the path to distinguish a true disk deletion from a glob/config change),
  closing roadmap G3 — promoted [003 §3.3](./003-source-plugins.md) from limitation to current
  behavior. Minor changesets for `@agentmonitors/core` and `@agentmonitors/source-file-fingerprint`.

## 2026-05-31 — Channel transport binding confirmed (006 §4.4)

- Ran the `experiments/channel-probe` diagnostic against Claude Code 2.1.157 with the probe spawned
  **as an MCP server** (`--mcp-config`). Confirmed: the server receives `CLAUDE_PROJECT_DIR`
  (= workspace), its cwd is the workspace, it **inherits `CLAUDE_CODE_SESSION_ID`**, and `roots/list`
  returns the workspace root.
- Resolved the [006 §4.4](./006-agent-integration.md) open question: **session-level binding is
  available** (the MCP subprocess inherits the host session id), so it is now the documented
  preferred strategy, with workspace binding as fallback. Updated roadmap G7 (binding proof done;
  remaining work is the transport seam + channel server). The channel transport itself is still
  target (unbuilt); only the binding mechanism is confirmed.

## 2026-05-31 — Full per-source scope validation in `validate` (G2)

- Promoted [004 §2.2](./004-validation-testing.md) and [001 §8](./001-monitor-definition.md)
  from target to **current**: `validate` now performs full JSON Schema (draft-07) validation of
  each monitor's `scope` against its source's `scopeSchema`, not just required-field presence.
  Closes roadmap G2 (and test gap T3).
- Added the exported core helper `validateScope(scope, scopeSchema)`
  (`libs/core/src/schema/validate-scope.ts`); the CLI calls it (AP4/AP6).
- Validator is **`@cfworker/json-schema`**, chosen over ajv specifically because it validates by
  walking the schema at runtime rather than compiling with the `Function` constructor — safe under
  restrictive CSP / Workers-style environments. Minor `@agentmonitors/core` changeset.

## 2026-05-31 — Duplicate monitor IDs are now rejected (G1)

- Promoted [001 §4](./001-monitor-definition.md) from target to **current**: duplicate
  folder-derived monitor IDs are now a hard error, closing roadmap item G1.
- `scanMonitors` surfaces collisions via a new `ScanResult.duplicateIds`
  (`DuplicateMonitorId[]`) field; the runtime tick refuses to run on duplicates; `validate`
  exits non-zero and `scan` reports them. Enforces SP2. Regression tests added at the scanner,
  runtime, and CLI layers; minor `@agentmonitors/core` changeset included.

## 2026-05-31 — Agent integration & delivery transports

- Added normative [006-agent-integration.md](./006-agent-integration.md): a delivery-**transport**
  abstraction behind the adapter seam, covering the current hook-state transport and a **target**
  Claude Code **channel** transport. Recorded as roadmap item G7.
- Scoped the channel transport's binding model from evidence. A spawned MCP server can recover its
  **workspace** (`CLAUDE_PROJECT_DIR` / MCP `roots/list`). For **session** identity there is no
  `CLAUDE_SESSION_ID`, but a probe found `CLAUDE_CODE_SESSION_ID` present in Claude Code's process
  environment; whether MCP-server subprocesses inherit it is the open question the one-way prototype
  (`experiments/channel-probe/`) resolves. Binding therefore prefers **session** scope when that
  variable is available and falls back to **workspace** scope (single-active-lead-session assumption,
  degrade on multi-lead); the hook-state transport remains the per-session-accurate surface either way.
- Established that channels are **optional and additive** (NP-CH): research-preview, version- and
  org-gated, so they must never become a delivery dependency. The hook-state transport stays the
  always-available default.

## 2026-05-31 — In-repo authoring pass

The numbered draft set was promoted into `docs/specs/` as the
canonical contract, verified against the code, and enriched. See
[maintainer-migration-notes.md](./maintainer-migration-notes.md) for the source mapping.

### Structure

- Established `docs/specs/` as the canonical location (previously only referenced as a plan).
- Added supporting docs: [README.md](./README.md), [glossary.md](./glossary.md),
  [roadmap.md](./roadmap.md).
- Added normative [005-cli-reference.md](./005-cli-reference.md) covering the full
  `agentmonitors` command surface.

### 001-monitor-definition.md

- Verified the `source` field constraint against `monitor-schema.ts`: the regex is
  `^[a-z][a-z0-9-]*$` (first character must be a lowercase letter), which is stricter than
  the prose "kebab-case". The doc now states the exact regex.

### 002-runtime-delivery.md

- Enriched with verified sections for the **daemon/IPC** layer, **agent-integration
  adapters** (`claudeCodeAdapter` lifecycle→hook mapping), and a **persistence-schema
  appendix** covering the real Drizzle/SQLite tables.
- Clarified that `daemon once` / a single tick runs **in-process without the Unix socket**;
  only `daemon run` serves the socket that `session`/`events`/`hook` round-trip through.
- Clarified that lead-only event projection is enforced as a post-query role filter, that
  `latestHighTitles` is capped at 5, and that computed diffs are capped at 20 changed lines.
- Recorded that `observation_history` is defined in the schema but has **no runtime write
  path** (current-vs-target; tracked as roadmap G6).

### 003-source-plugins.md

- Verified `api-poll` is **stateful**, that `text-diff` is its **default** change-detection
  strategy, that its `method` scope enum is limited to `GET`/`POST`, and that its
  `snapshot` carries `{ url, status, bodyLength, strategy }` rather than the full body.
- Clarified that `schedule` omits the `stateful` field entirely (rather than setting it
  `false`), and that `queryScope` values may be `string | string[]`.

### 004-validation-testing.md

- Replaced the external "FormSpec" style reference (from the source author's other project)
  with project-local guidance, since FormSpec does not exist in this repo.
- Mapped each required test scenario to the test file that covers it and flagged the
  uncovered ones (`low` urgency, snapshot persistence/isolation, `validate` failure paths,
  `schema generate` and standalone `session list|close` wiring). Tracked in
  [roadmap.md](./roadmap.md) as T1–T4.

### Carried forward from the prior draft set (2026-04-06)

- **000-principles.md** — established the numbered spec set as the canonical implementation
  contract; recorded the runtime/session event pipeline as authoritative delivery; recorded
  the legacy inbox lifecycle as a separate still-implemented model; made `low` urgency
  first-class.
- **001-monitor-definition.md** — split monitor authoring/frontmatter into its own doc; made
  duplicate monitor IDs a normative correctness requirement even though the scanner does not
  yet reject them; clarified single-root (no multi-root merge) evaluation.
- **002-runtime-delivery.md** — split runtime polling, persistence, session projection, and
  hook delivery into a dedicated contract; clarified unread/claimed/acknowledged as distinct;
  clarified that high urgency defaults to debounced delivery rather than immediate interrupt.
- **003-source-plugins.md** — split the source contract and bundled-source behavior into a
  dedicated doc; recorded `file-fingerprint` create/delete limitations; recorded
  plugin-management CLI commands as placeholders.
- **004-validation-testing.md** — clarified that `agentmonitors validate` performs partial
  source-specific validation rather than full per-source JSON Schema validation; defined the
  evidence hierarchy for resolving drift during the transition to the internal numbered specs.

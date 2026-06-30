# @agentmonitors/cli

## 0.7.1

### Patch Changes

- d4299cf: Relicense the published packages under the MIT License. Each package now declares `"license": "MIT"` and ships a `LICENSE` file in its published tarball.
- Updated dependencies [d4299cf]
  - @agentmonitors/core@0.9.1
  - @agentmonitors/source-api-poll@0.3.1
  - @agentmonitors/source-command-poll@0.2.5
  - @agentmonitors/source-file-fingerprint@0.3.1
  - @agentmonitors/source-incoming-changes@0.2.6
  - @agentmonitors/source-schedule@0.1.6

## 0.7.0

### Minor Changes

- e4e1c2e: `monitor explain` and `monitor history` now read the persisted SQLite store **in-process** when no daemon is reachable, instead of failing. Previously both were socket-only, so with no daemon running — including right after `daemon once` materialized events — they errored with a raw `connect ENOENT …`, and `monitor explain` reported a false `✗ Scheduling: failure` for a monitor that had actually fired. A read-only diagnosis tool must not require a live daemon.

  On a genuine connection failure the CLI runs the same read-only diagnosis against the local DB and renders the real per-stage report, labeled with a banner ("No daemon running — showing persisted state from the last tick.") in text mode or a `notice` field in `--format json`. When the daemon is down **and** there is genuinely nothing persisted to read, it prints an actionable remediation line (start `agentmonitors daemon run`, or use `monitor test` for a one-shot) rather than a raw `ENOENT`. A daemon-side application error is still surfaced verbatim, never masked as "daemon not running".

- d3e1ba9: feat(cli): add `--format toon|json|text` with agent/human auto-detection to structured-output commands (issue #121, Layer A)

  Adds TOON (Token-Oriented Object Notation, `@toon-format/toon@^2.3.0`) as a `--format` option on the five structured-output commands — `events list`, `scan`, `monitor history`, `monitor explain`, and `source list`.
  - `--format toon`: compact, human-readable encoding designed for LLM context windows; ~40% fewer tokens for typical monitor output shapes; round-trips losslessly to the identical JSON value
  - `--format json` output is **byte-for-byte unchanged** — no regressions for existing JSON consumers
  - `--format text` human-readable columnar output (unchanged)
  - **Default auto-detected per invocation context** via `is-agentic-tui`: agent-driven invocations (Claude Code, Cursor, Gemini CLI, etc.) default to `toon`; interactive human terminals default to `text`; explicit `--format` always overrides
  - TOON is a rendering-only transform at the CLI output edge; durable storage (SQLite, IPC wire) stays JSON
  - Layer B (delivered observation payload) is out of scope — deferred pending a standard-level design decision

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

- b1bb206: `api-poll` infers the change-detection strategy from the response `Content-Type` (Refs #230)

  `change-detection.strategy` is now **optional**. When it is omitted, `api-poll` infers the strategy
  from the response `Content-Type`: a JSON media type (`application/json` or any structured-syntax
  `+json` suffix, e.g. `application/ld+json`) → `json-diff`; everything else — `text/html`,
  `text/plain`, or a missing/unknown `Content-Type` → `text-diff`. The common "watch a web page" case is
  now zero-config: drop the `change-detection` block entirely and the source picks `text-diff` for an
  HTML page and `json-diff` for a JSON API automatically.

  **An explicit `change-detection.strategy` always wins** — it is used verbatim, with no inference and no
  Content-Type override (user specification is absolute). An explicit `json-diff` against an HTML page
  stays `json-diff` (and still triggers the existing #219 json-diff-on-non-JSON warning); an explicit
  `text-diff` against a JSON body stays `text-diff`. The #219 warning now fires **only** for the explicit
  `json-diff` case — an inferred strategy never warns, because inference picks `json-diff` solely for JSON
  `Content-Type`s and so never mismatches the body.

  The `api-poll` scaffold (`agentmonitors init --type api-poll`) and the authoring docs now show the
  zero-config "watch a page" example and document that `change-detection` is optional and inferred, with
  an explicit override honored. No public-type change.

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

- a01affb: Use an upstream-safe command-poll scaffold.

  `agentmonitors init --type command-poll` now scaffolds a `git ls-remote origin refs/heads/main`
  `text-diff` monitor instead of a local `git status --porcelain` command, so the generated example
  can watch remote branch tips without relying on stale local refs.

- 33e2f0d: `daemon once` now distinguishes skipped-not-due monitors from no monitors found

  When monitors exist but are skipped because their interval has not elapsed, `daemon once` appends a parenthetical to the summary line: `(N skipped: interval not elapsed — next due in Xs)`, reporting the soonest next-due time across all skipped monitors. Previously, a second `daemon once` run within a monitor's interval printed `Evaluated 0 monitor(s), emitted 0 event(s).` — identical to the "no monitors found" output, making it impossible to distinguish the two cases.

- 1836f04: DX polish (issue #153): validate output consistency, urgency error wording, api-poll feedback
  - **validate**: invalid monitors now display the monitor ID (matching valid-monitor output) instead of the full file path; passing a file path shows a `monitor test` pointer
  - **core**: inverted urgency range error no longer duplicates the field name (`urgency: range "high..normal" is inverted` instead of `urgency: urgency range …`)
  - **api-poll `monitor test`**: HTTP status and response body size are now printed after the baseline so authors can spot bad URLs immediately
  - **api-poll observe**: Node `fetch` errors now propagate the underlying network cause (ECONNREFUSED, ENOTFOUND, timeout) in the message, visible in `monitor explain` output

- c81e868: Teach the inline pipeline idiom for `command-poll` (003 §11.1)

  `command` remains argv-only (spawned with `shell: false` — no injection surface), but the common
  mistake of writing a shell pipeline as a bare string is now self-correcting: `parseScopeConfig`
  rejects a string `command` with a message that names the supported inline form,
  `['sh', '-c', '<pipeline>']`, and the `init --type command-poll` scaffold documents it in a comment.
  No behavior change for existing argv monitors; this only improves the error and the template.

- 19f2d8d: `file-fingerprint` project monitor globs now resolve relative paths from the runtime workspace/config root instead of the daemon process cwd.

  Core now passes `workspacePath` to source observation contexts and records a distinct `no-files-matched` observation outcome when a source can tell that a zero-observation run matched no files. The bundled `file-fingerprint` source uses that context for relative `globs` and relative `cwd`, while preserving absolute `cwd` values and absolute glob patterns. `agentmonitors monitor test` now derives the same config root from the supplied `MONITOR.md` path so dry-runs match daemon ticks.

- 1f27b2e: Surface the file-fingerprint observe interval in source metadata and CLI source listing.

  The file-fingerprint source schema now documents the `watch.interval` knob and its 30s default, and
  `agentmonitors source list` includes per-field descriptions so authors can see that the interval is
  tunable without reading source code.

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

- b3d5ed3: Add `--format text|json` to `agentmonitors hook deliver` while preserving the default Claude Code
  hook wire output.
- 3743641: Fix: `hook deliver` emits a reminder line for pending `normal`/`low` changes (Refs #198)

  A default file-fingerprint monitor (`urgency: normal`) was silent mid-session. The wired
  `agentmonitors hook deliver` (on `UserPromptSubmit`) emitted **nothing** for a pending
  `normal`-urgency change because `renderHookDelivery` returned `null` whenever the claim carried no
  event bodies (`events: []`), even though the claim had a populated advisory `message`. `hook claim`
  reported the reminder while `hook deliver` — the actually-wired command — did not.

  `renderHookDelivery` now renders the claim's advisory `message` (sanitized and length-capped) into
  `hookSpecificOutput.additionalContext` for a `normal`/`low` reminder claim, producing a visible
  mid-turn reminder line (no per-event body block). The claimed rows are still **not** acknowledged
  (BP2 / SP4), so the event stays unread and re-discoverable via `agentmonitors events list --unread`.

  High-urgency body injection and the `post-compact` (`SessionStart`) recap are byte-unchanged.
  `hook deliver` still prints nothing and exits 0 when there is genuinely nothing pending.

- 9770d85: Use the enabled workspace socket for manual session/events/hook commands and show an actionable no-daemon error.
- Updated dependencies [f6bc858]
- Updated dependencies [5e83550]
- Updated dependencies [8dbda37]
- Updated dependencies [b1bb206]
- Updated dependencies [dcb7ae9]
- Updated dependencies [0dd2223]
- Updated dependencies [33e2f0d]
- Updated dependencies [1836f04]
- Updated dependencies [c81e868]
- Updated dependencies [fe357f3]
- Updated dependencies [19f2d8d]
- Updated dependencies [0b8fece]
- Updated dependencies [3874f52]
- Updated dependencies [ae664c7]
- Updated dependencies [1f27b2e]
- Updated dependencies [5ce5979]
- Updated dependencies [50db864]
- Updated dependencies [745b6fb]
- Updated dependencies [094fc2b]
- Updated dependencies [3ecc9bb]
- Updated dependencies [3e197fc]
- Updated dependencies [8a9388c]
- Updated dependencies [7ab21d3]
- Updated dependencies [e0b52bd]
- Updated dependencies [14c6b94]
  - @agentmonitors/source-api-poll@0.3.0
  - @agentmonitors/core@0.9.0
  - @agentmonitors/source-command-poll@0.2.4
  - @agentmonitors/source-file-fingerprint@0.3.0
  - @agentmonitors/source-incoming-changes@0.2.5
  - @agentmonitors/source-schedule@0.1.5

## 0.6.1

### Patch Changes

- Updated dependencies [dfb124a]
- Updated dependencies [07f8cf7]
  - @agentmonitors/core@0.8.0
  - @agentmonitors/source-api-poll@0.2.3
  - @agentmonitors/source-command-poll@0.2.3
  - @agentmonitors/source-file-fingerprint@0.2.4
  - @agentmonitors/source-incoming-changes@0.2.4
  - @agentmonitors/source-schedule@0.1.4

## 0.6.0

### Minor Changes

- 5c748a4: `daemon once` and the `daemon run` periodic tick log now report monitors whose `observe()` errored on a tick instead of printing a clean `emitted 0 event(s)`. The runtime tick result gains an `erroredObservations: { monitorId, message }[]` field (populated from the same path that records each `errored` row in `observation_history`), and the CLI surfaces a non-zero errored count plus each errored monitor's id and message without a verbose flag. A genuine no-change tick is unchanged, so an author can finally distinguish a broken source from a watched target that simply hasn't changed.

### Patch Changes

- Updated dependencies [5c748a4]
  - @agentmonitors/core@0.7.0
  - @agentmonitors/source-api-poll@0.2.2
  - @agentmonitors/source-command-poll@0.2.2
  - @agentmonitors/source-file-fingerprint@0.2.3
  - @agentmonitors/source-incoming-changes@0.2.3
  - @agentmonitors/source-schedule@0.1.3

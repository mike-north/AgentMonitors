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
  and held debounce/rollup work survives reopen without flushing until a successful observe.
  Do not fold #558/#559 into this repair.
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

**Verified in:** `libs/core/src/runtime/service.test.ts` and
`libs/core/src/runtime/transactional-materialization.test.ts`.

For the current retry-diagnostic contract in [002](./002-runtime-delivery.md), a regression **MUST**
hold the real asynchronous monitor scan at a deterministic test-only barrier, commit valid retry
work through the public store API while it waits, then release the real parser result. The report
must retain the committed count and retry IDs; a valid-definition report with a committed event
prefix must diagnose its retained suffix as pending. Include a no-interleaving control and missing,
parse-invalid, duplicate and invalid-schedule routes. Assert that native retry/envelope/error bytes,
opaque source state, event and history rows remain unchanged by diagnosis, and that diagnosis does
not invoke a source. This is a same-runtime ordering check, not a cross-process snapshot guarantee.
The permanent scenarios are in `libs/core/src/runtime/retry-diagnostics.test.ts`.

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
for the live production-advisory gate. `test:scripts` exercises audit fixtures and
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

### 3.1 Monitor authoring and parsing

| Scenario                                         | Coverage                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid full monitor parses successfully           | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "parses valid full monitor")                                                                                                                                                                                                                                                      |
| Minimal valid monitor parses successfully        | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "parses minimal valid monitor")                                                                                                                                                                                                                                                   |
| Body trimming is preserved                       | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns body content as instructions (trimmed)")                                                                                                                                                                                                                                 |
| Invalid top-level schema fields fail clearly     | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns error for invalid frontmatter values"; `libs/core/src/schema/monitor-schema.test.ts` — "rejects invalid urgency", missing-required-field cases)                                                                                                                          |
| Invalid notify config fails clearly              | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "returns error for invalid notify config"; `libs/core/src/schema/monitor-schema.test.ts` — "rejects debounce without settle-for", "rejects throttle without suppress-for")                                                                                                        |
| File path and directory-derived ID are preserved | Covered (`libs/core/src/parser/parse-monitor.test.ts` — "derives id from parent folder name", "preserves filePath in error result")                                                                                                                                                                                                       |
| `low` urgency is accepted as valid               | **TEST GAP** — `libs/core/src/schema/monitor-schema.test.ts` "accepts all urgency values" iterates only `['high', 'normal']`; `low` is absent from the loop despite being defined in the schema and being a first-class value per spec [000-principles.md](./000-principles.md) and [002-runtime-delivery.md](./002-runtime-delivery.md). |

### 3.2 Source-specific behavior

| Scenario                                                                                                                        | Coverage                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stateful baseline returns no first-run observations (file-fingerprint)                                                          | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "returns no observations on first run (baseline)")                                                                                                                                      |
| Stateful baseline returns no first-run observations (api-poll)                                                                  | Covered (`plugins/source-api-poll/src/index.test.ts` — "returns no observations on first poll (baseline)")                                                                                                                                             |
| Changed file content emits file-fingerprint observations                                                                        | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "detects file changes on subsequent runs")                                                                                                                                              |
| Unchanged file content does not emit observations                                                                               | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "returns no observations when files have not changed"; `plugins/source-api-poll/src/index.test.ts` — "returns no observations when response is unchanged")                              |
| `text-diff` strategy detects response body changes                                                                              | Covered (`plugins/source-api-poll/src/index.test.ts` — "detects response changes on subsequent polls (text-diff)")                                                                                                                                     |
| `json-diff` strategy ignores whitespace differences                                                                             | Covered (`plugins/source-api-poll/src/index.test.ts` — "json-diff: ignores whitespace differences in JSON")                                                                                                                                            |
| Explicit `json-diff` on a non-JSON body emits a warning                                                                         | Covered (`plugins/source-api-poll/src/index.test.ts` — "warns when json-diff is configured but the body is not JSON"; "redacts credentials, query, and fragment from the non-JSON warning URL")                                                        |
| `api-poll` body-diffing strategies reject non-2xx responses as errors                                                           | Covered (`plugins/source-api-poll/src/index.test.ts` — "non-2xx → errored observation (issue #220)"; `apps/cli/src/commands/cli.integration.test.ts` — "api-poll over a real endpoint (#219, #220)")                                                   |
| `status-code` strategy detects status change, ignores body                                                                      | Covered (`plugins/source-api-poll/src/index.test.ts` — "status-code: detects status change, ignores body change")                                                                                                                                      |
| Schedule source emits one observation whenever invoked                                                                          | Covered (`plugins/source-schedule/src/index.test.ts` — "fires an observation when called")                                                                                                                                                             |
| Missing required source config field throws clearly                                                                             | Covered (`plugins/source-file-fingerprint/src/index.test.ts` — "throws on missing globs config"; `plugins/source-api-poll/src/index.test.ts` — "throws on missing url"; `plugins/source-schedule/src/index.test.ts` — "throws on missing cron config") |
| `api-poll`/`command-poll` `timeout` request/body deadline is enforced and validated (issue #304, §4.9/§11.1)                    | Covered (`plugins/source-api-poll/src/index.test.ts` — "request/body deadline" suite; `libs/core/src/notify/notifier.test.ts` — `parseOperationTimeoutMs` suite; `plugins/source-command-poll/src/schema-parity.test.ts` — timeout cases)              |
| Response body size cap enforced (declared `Content-Length` and streamed count), exempt for `status-code` (issue #304, §4.9)     | Covered (`plugins/source-api-poll/src/index.test.ts` — "request/body bounds (issue #304)" suite, "status-code" byte-cap exemption cases)                                                                                                               |
| Composite concurrency is bounded and fails fast, aborting in-flight siblings (issue #304, §4.9)                                 | Covered (`plugins/source-api-poll/src/index.test.ts` — "composite concurrency (003 §2.6)"; `plugins/source-api-poll/src/map-with-concurrency.test.ts` — "fail-fast + sibling abort (issue #304 review finding 3)")                                     |
| Composite cumulative rendered-artifact byte budget is enforced across all parts (issue #304 review, second + third round, §4.9) | Covered (`plugins/source-api-poll/src/index.test.ts` — "composite cumulative byte budget (issue #304 review, second + third round)")                                                                                                                   |
| Composite part count and part-`id` length are capped, in both schema and parser (issue #304 review, third round, §4.9)          | Covered (`plugins/source-api-poll/src/index.test.ts` — "composite part-count and part-id bounds (issue #304 review, third round)", including the reviewer's two repro shapes: 100,000 empty-body parts and an 11 MiB `id`)                             |

### 3.3 Runtime delivery

| Scenario                                                                                                         | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source state survives runtime restart                                                                            | Covered (`libs/core/src/runtime/service.test.ts` — "persists source state across runtime restarts and emits changes later")                                                                                                                                                                                                                                                                                                                         |
| High urgency waits for settle window before interruptible delivery                                               | Covered (`libs/core/src/runtime/service.test.ts` — "claims high-urgency deliveries after the debounce window and updates hook state"; "emits all debounced high-urgency observations after the settle window")                                                                                                                                                                                                                                      |
| Normal urgency coalesces — second delivery not offered until session is acknowledged                             | Covered (`libs/core/src/runtime/service.test.ts` — "coalesces normal-urgency reminders until unread events are acknowledged")                                                                                                                                                                                                                                                                                                                       |
| Low urgency delivers only at idle lifecycle points                                                               | Covered (`libs/core/src/runtime/service.test.ts` — "defers low-urgency delivery until idle lifecycle points")                                                                                                                                                                                                                                                                                                                                       |
| Recap emits recent unread events and command hints                                                               | Covered (`libs/core/src/runtime/service.test.ts` — "returns recap deliveries after post-compact with recap messaging")                                                                                                                                                                                                                                                                                                                              |
| Events project only into matching workspace sessions                                                             | Covered (`libs/core/src/runtime/service.test.ts` — "projects events only into matching workspace sessions and supports scope filters"; `apps/cli/src/commands/cli.integration.test.ts` — "projects events only to the lead session when a subagent session exists")                                                                                                                                                                                 |
| Scope filters query `queryScope` correctly                                                                       | Covered (`libs/core/src/runtime/service.test.ts` — "projects events only into matching workspace sessions and supports scope filters")                                                                                                                                                                                                                                                                                                              |
| Hook state reflects pending and unread counts correctly                                                          | Covered (`libs/core/src/runtime/service.test.ts` — "claims high-urgency deliveries after the debounce window and updates hook state"; `libs/core/src/hook-bridge/bridge.test.ts` — `computeHookState` suite)                                                                                                                                                                                                                                        |
| Cron timezone matching works correctly                                                                           | Covered (`libs/core/src/runtime/service.test.ts` — "matches schedule cron expressions in the configured timezone")                                                                                                                                                                                                                                                                                                                                  |
| An invalid schedule timezone is isolated to that monitor, not the whole tick (issue #297)                        | Covered (`libs/core/src/runtime/service.test.ts` — "isolates an invalid schedule timezone so a sibling monitor still emits (issue #297)"; `apps/cli/src/commands/cli.integration.test.ts` — "isolates an invalid schedule timezone instead of aborting the whole tick, so a sibling monitor still emits")                                                                                                                                           |
| `monitor.explain` renders an invalid schedule timezone as an observation-stage failure, not a crash (issue #297) | Covered (`libs/core/src/runtime/service.test.ts` — "explains an invalid schedule timezone as an observation-stage failure, not a crash (issue #297)"; `apps/cli/src/commands/cli.integration.test.ts` — "explains an invalid schedule timezone as an observation-stage failure instead of crashing")                                                                                                                                                |
| `doctor` reports an invalid schedule timezone as invalid without crashing (issue #297)                           | Covered (`libs/core/src/runtime/doctor-report.test.ts` — "reports an invalid schedule timezone as invalid without crashing, isolated from a healthy sibling (issue #297)")                                                                                                                                                                                                                                                                          |
| `validate`/`monitor test` reject an invalid IANA schedule/rollup timezone at authoring time (issue #297)         | Covered (`libs/core/src/schema/validate-scope.test.ts` — `validateWatchScope` schedule-timezone suite; `libs/core/src/schema/monitor-schema.test.ts` — "rejects a rollup monitor with an invalid IANA timezone"; `apps/cli/src/commands/cli.integration.test.ts` — "rejects a schedule monitor with an invalid IANA timezone, alongside a valid sibling" (`validate`), "rejects a schedule monitor with an invalid IANA timezone" (`monitor test`)) |
| Subagent sessions do not receive events projected to the lead session                                            | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "projects events only to the lead session when a subagent session exists")                                                                                                                                                                                                                                                                                                               |

### 3.4 Persistence and snapshotting

The `RuntimeStore.saveSnapshot()` and `RuntimeStore.latestSnapshot()` methods (in `libs/core/src/runtime/store.ts`) implement snapshot storage keyed by `(workspacePath, monitorId, objectKey)`. The `materializeObservation` method in `libs/core/src/runtime/service.ts` uses these to retrieve the prior snapshot and compute a `diffText` before atomically saving the event, projections/cursor seeds, and snapshot.

| Scenario                                                                  | Coverage                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshotText` stores a later-retrievable snapshot                        | Covered (`libs/core/src/runtime/service.test.ts` — "stores and retrieves snapshots isolated by workspace, monitor, and object key"; "computes a diff against the prior snapshot when an object changes").                                                                                                                                                                                   |
| A prior snapshot produces diff text on later change                       | Covered (`libs/core/src/runtime/service.test.ts` — "computes a diff against the prior snapshot when an object changes"; "renders a structural json-diff diffText for a real observation routed through processObservation").                                                                                                                                                                |
| Snapshots are isolated by workspace, monitor, and object key              | Covered (`libs/core/src/runtime/service.test.ts` — "stores and retrieves snapshots isolated by workspace, monitor, and object key").                                                                                                                                                                                                                                                        |
| Event, projection/cursor, and snapshot writes roll back together          | Covered (`libs/core/src/runtime/transactional-materialization.test.ts` — injected cursor and snapshot failures leave no event, projection, cursor, or snapshot).                                                                                                                                                                                                                            |
| Retry outbox survives reopen with route and envelope intact               | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — ordered envelopes and timestamps round-trip through an on-disk database reopen).                                                                                                                                                                                                                                                    |
| Retry outbox capacity is batch-atomic and workspace-scoped                | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — exact 256-row and 8 MiB UTF-8 boundaries, competing connections, two-sibling count/aggregate-byte overflow with no partial batch, and independent monitor/workspace scopes).                                                                                                                                                        |
| Retry envelopes round-trip without silent data conversion                 | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — BigInt, negative zero, nested/customized Date, non-Date observedAt, and accessor/proxy values fail with a domain error before any sibling is written; altered-prototype built-in brands are rejected; route getters and direct or inherited proxy traps never run).                                                                 |
| Retry errors are safe and bounded                                         | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — C0/DEL controls are stripped and persisted errors are capped at 1,024 characters).                                                                                                                                                                                                                                                  |
| Retry backoff terminalizes and requires explicit re-arm                   | Covered (`libs/core/src/runtime/retry-outbox.test.ts` — due filtering, fixed delays, five-attempt terminal state and re-arm; `retry-lifecycle.test.ts` — subsecond deadlines never shorten delays, typed lifecycle failures, callback non-execution, real snapshot/deletion fault rollback, failed-update sanitization and failed/terminal/rearmed/completed states across on-disk reopen). |
| Retained retry diagnostics survive unusable definitions and stay isolated | Covered (`libs/core/src/runtime/retry-diagnostics.test.ts` — all explain early returns, removed/parse-failed/duplicate doctor outboxes, same-id workspace and NULL-scope isolation, omitted-workspace fallback, 257 rows across two monitors, metadata privacy/order and read-only state preservation).                                                                                     |
| Retry summaries never expose captured envelopes or payloads               | Covered (`libs/core/src/runtime/retry-outbox.test.ts` and `retry-diagnostics.test.ts` — explicit safe metadata shape and private captured-input sentinels absent across reports).                                                                                                                                                                                                           |

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
| `schema generate` emits source-discriminated monitor schema                                                                                                                        | **TEST GAP** — No CLI integration test invokes `agentmonitors schema generate` and inspects the output. The `generateMonitorSchema` unit tests in `libs/core/src/observation/schema-generator.test.ts` cover the function directly, but the `schema generate` command wire-up has no end-to-end coverage.                                                                                                                                                                                                                                                                                                                             |
| `session open/close/list` reflects runtime session records                                                                                                                         | Partially covered (`apps/cli/src/commands/cli.integration.test.ts` — `session open` is exercised as part of the runtime flow test; `session close/list` as standalone commands have no dedicated tests). **PARTIAL GAP** — `session list` and `session close` command invocations are not independently verified.                                                                                                                                                                                                                                                                                                                     |
| `events list/ack` round-trips through daemon runtime behavior, including `deliveryState` tracking unread -> claimed -> acknowledged (issue #338 item 1)                            | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "opens a session, detects file changes through the daemon, claims a hook delivery, and acknowledges events"; `libs/core/src/runtime/service.test.ts` — "reports deliveryState on session-scoped listEvents, tracking unread -> claimed -> acknowledged")                                                                                                                                                                                                                                                                                                                   |
| `session open --format id` prints the bare session id (issue #338 item 4)                                                                                                          | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "prints only the bare session id, matching the id from --format json")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `hook claim` returns lifecycle-appropriate payloads                                                                                                                                | Covered (`apps/cli/src/commands/cli.integration.test.ts` — `hook claim --lifecycle turn-interruptible` in the runtime flow test; `libs/core/src/runtime/service.test.ts` — various `claimDelivery` lifecycle tests)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `monitor test` / `validate` scope rejection parity before source side effects                                                                                                      | Covered (`apps/cli/src/commands/monitor-scope-parity.integration.test.ts` — `monitor test / validate scope parity`, text/JSON matrix and live sentinel controls)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `monitor test` stateful baseline flow                                                                                                                                              | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "tests a valid file-fingerprint monitor"; `apps/cli/src/commands/monitor-test.test.ts` — "preserves previousState and refreshes now")                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `monitor test` errors on missing or unparseable file                                                                                                                               | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "errors on missing file", "errors on invalid MONITOR.md content")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `inbox list` argument validation                                                                                                                                                   | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "rejects invalid --state value", "rejects invalid --urgency value", "rejects invalid --since date")                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Activation plugin `hooks.json` command strings stay wired to the CLI stdin contract (config drift)                                                                                 | Covered (`apps/cli/src/commands/cli.integration.test.ts` — "drives the plugin's literal hooks.json command strings end to end (boot, deliver body, deregister)"; "SessionStart command falls back to the install-hint JSON when agentmonitors is not on PATH"). The suite parses the real `agent-plugins/agentmonitors/hooks/hooks.json` and runs each `SessionStart`/`UserPromptSubmit`/`SessionEnd` command verbatim via `/bin/sh -c` with an `agentmonitors` PATH shim, so a drifted command string (flag re-added, binary renamed, chain broken), a regressed stdin contract, or an invalid missing-CLI fallback breaks the test. |
| A global install of the packed launcher (no workspace `node_modules`) can go from `agentmonitors init` to a delivered signal over the real hook stdin/stdout contract (issue #276) | Covered (`scripts/test-e2e-fresh-install-hooks.mjs`, `pnpm test:e2e-fresh-install-hooks`, CI per-PR) — see [§2.7](#27-fresh-environment-e2e-hooks-path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 3.5.1 Verify observation boundary

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

- `low` urgency is real and MUST be treated as first-class. The schema generator correctly includes it in the `urgency` enum (`schema-generator.ts` line 31). The `monitor-schema.test.ts` "accepts all urgency values" test currently omits `low` from its loop — this is a test gap, not an implementation gap.
- The runtime/session event pipeline is the primary delivery path.
- The inbox item lifecycle is separate from the event pipeline, not merely another view of the same data.
- Duplicate monitor IDs are a correctness hazard: `scanMonitors()` reports collisions, and `validate` rejects duplicate IDs within the scanned tree (§2.2).
- Source-specific validation is fully enforced by `validate` against each source's `scopeSchema` using draft-07 JSON Schema checks, including types, enums, required fields, and nested items. Both `validate` and `monitor test` use `validateWatchScope` for the same rejection details; `monitor test` rejects invalid scopes before source observation (§2.2/§2.4).

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

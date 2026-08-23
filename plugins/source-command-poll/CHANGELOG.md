# @agentmonitors/source-command-poll

## 0.4.0

### Minor Changes

- 74db101: `cwd` now resolves against the runtime workspace/config root for a project monitor, matching `file-fingerprint`'s existing relative-`cwd`/`globs` resolution: an **absolute** `cwd` is unchanged, a **relative** `cwd` resolves against the workspace root instead of the daemon's own process working directory, and an **omitted** `cwd` now defaults to the workspace root instead of the daemon's own process working directory (a user-level monitor, with no workspace root available, keeps the prior default).

  This closes a portability gap: a scaffolded `MONITOR.md` that relied on an absolute `cwd:` baked in at authoring time broke the moment the project was relocated, cloned elsewhere, or shared to another checkout path. Omitting `cwd` (or writing a relative one) now keeps working, since the runtime resolves the workspace root fresh on every tick from wherever `MONITOR.md` was actually found.

### Patch Changes

- 14f4846: Fix a P1 correctness defect in `command-poll`: excess `stdout`/`stderr` no longer kills the child
  process. `stdout` is streamed and retains only its leading 1 MiB; `stderr` is streamed and retained
  independently of the stdout cap for failure diagnostics. Neither cap ever terminates the command —
  a command producing more than the cap on either stream still runs to its real completion (side
  effects included) and reports its actual exit code, instead of being killed mid-write and having its
  exit status silently fabricated as a truncated success.
- fde6b6a: Adopt core's shared `parseOperationTimeoutMs`/`OPERATION_TIMEOUT_PATTERN` for the `timeout` scope
  field instead of a hand-maintained copy of the default/parse/pattern. Behavior is unchanged except
  that a zero-length `timeout` (`"0s"`, `"0m"`, `"0h"`, `"0d"`) is now rejected — previously it
  silently aborted every execution instantly.
- fde6b6a: Tighten `timeout` scope-field validation via core's hardened `parseOperationTimeoutMs` (issue #304
  review, second round). Two compat-affecting changes: a leading-zero duration (`"01s"`) is now
  **rejected** — previously accepted by the parser even though the JSON Schema `pattern` already
  rejected it, a schema/parser mismatch this closes by tightening the parser to match the schema; and
  a present but non-string `timeout` (e.g. `timeout: 123` or `timeout: null`) is now rejected instead
  of silently falling back to the 30s default like a genuinely omitted field. Also rejects a duration
  exceeding Node's `setTimeout` maximum (`2_147_483_647`ms, ~24.8 days — e.g. `"25d"`), which
  previously would have silently overflowed to a near-instant timer instead of the author's intended
  deadline.
- c4a16fd: Fix `command-poll` timeout handling to terminate the entire process tree, not just the direct
  child. A command that backgrounds a worker via a shell (e.g. `['sh', '-c', 'sleep 30 & wait']`)
  previously left the backgrounded process running — and could hang the observation indefinitely
  waiting on its inherited stdout/stderr — after the shell itself was killed on timeout. Each command
  now runs as the leader of its own process group on POSIX (signaled as a group on timeout) and is
  torn down via `taskkill /T /F` on Windows; timeout resolution no longer waits on stdio stream
  closure, so an orphaned descendant can never hang the call.
- 97b0673: Use the monitor's authored name as a delivered event's title, instead of the source's
  implementation detail. A `command-poll` monitor announced itself with its raw argv as both `title`
  and `summary` — a GitHub poller with a large `jq` program produced a ~400-character headline that
  was entirely its own implementation, on every delivery, while the author's perfectly good `name:`
  appeared nowhere.
  - The runtime now decides an event's `title` at materialization: the monitor's authored `name` when
    present, otherwise the source-provided title unchanged (the documented fallback). Because the
    choice happens once in the core, the hook and channel transports carry the identical headline.
  - The source's own per-object text is not lost — it remains the event `summary`, and the full source
    identity remains on `objectKey` and in `payload` for debugging and querying.
  - Sources that interpolate a **configuration-identity** `objectKey` — `command-poll`'s joined argv
    and `api-poll`'s URL — now bound it with the new `displayObjectKey` helper (unchanged at or below
    60 code units, otherwise a prefix ending in `…`, cut at a grapheme-cluster boundary so truncation
    never emits a lone surrogate or splits a flag/ZWJ sequence). Keyed-collection change detection
    bounds only the monitor-scope half of a `<scope>#<key>` identity, so the informative per-item key
    is always rendered whole. Path-like keys (`file-fingerprint`, `incoming-changes`) are deliberately
    NOT bounded: a path's informative part is its tail, so head-truncation would destroy it; those need
    a path-aware ellipsis, tracked separately. A nameless monitor's fallback title is therefore
    headline-sized for the configuration-identity sources, not universally.
  - Both injecting transports' shared per-event block now renders TWO possible detail lines beneath
    the title: the source's deterministic per-object detail (`DeliveryEventSummary.objectDetail`,
    never digest-replaced — omitted when identical to the title or the body), and, on its own
    additional line, the recipient-visible digest (`DeliveryEventSummary.summary`, an Interpret digest
    when one was produced — omitted when identical to the title, the body, OR the object-detail line).
    This keeps a per-object source's delivery self-sufficient AND preserves a successful Interpret
    summarization: a named multi-object `prose` monitor's delivery names which object moved without
    silently discarding the digest.
  - `api-poll` now redacts the URL in its observation title/summary (userinfo, query, and fragment
    stripped — the same redaction its warning text already used) before bounding it, so a polled URL
    carrying a token cannot leak into durably persisted, agent-delivered text. The exact URL remains on
    `objectKey` and `payload.url`. The same redaction is threaded through `diffKeyedCollection`'s new
    optional `displayScope` parameter, so a keyed-collection observation from a URL-scoped source gets
    the identical protection as the non-collection branch.
  - An ephemeral monitor's explicit `--display-name` now reaches the authored-name signal, so a named
    ephemeral watch headlines with its display name exactly as a persistent monitor's `name:` does —
    including after a daemon restart reconstructs the definition from its durable record. Both this
    and a persistent monitor's frontmatter `name` now reject a whitespace-only value.
  - `events list --format text` passes every source-/author-controlled field (`monitorId`, `title`,
    the `summary` suffix) through a control-safe single-line transform before interpolation: CR/LF and
    Unicode line/paragraph separators collapse to a space, and every other C0/C1 control character
    (DEL and TAB included) is escaped to a visible `\uXXXX` form — a hostile payload can no longer
    forge an extra row or emit a raw terminal escape sequence.
  - `displayObjectKey` and `DeliveryEventSummary.objectDetail` are additive `@agentmonitors/core`
    public API surface (minor bump); `diffKeyedCollection` gains an additive optional sixth parameter,
    `displayScope`. Existing consumers are unaffected.

  See docs/specs/002-runtime-delivery.md §5.4, §9.1 and docs/specs/003-source-plugins.md §2.8.

- Updated dependencies [81ac973]
- Updated dependencies [b474d10]
- Updated dependencies [784e627]
- Updated dependencies [dea1510]
- Updated dependencies [fde6b6a]
- Updated dependencies [97b0673]
- Updated dependencies [8084b10]
- Updated dependencies [9e6cf2f]
- Updated dependencies [fde6b6a]
- Updated dependencies [518f610]
- Updated dependencies [c8d16cd]
- Updated dependencies [dea1510]
  - @agentmonitors/core@0.13.0

## 0.3.1

### Patch Changes

- Updated dependencies [2f0a9d3]
  - @agentmonitors/core@0.12.0

## 0.3.0

### Minor Changes

- 24e7685: Re-export `ChangeKind`, `JsonSchema`, `Observation`, `ObservationContext`, `ObservationResult`,
  `ObservationSource`, and `Urgency` (all from `@agentmonitors/core`) from each package's own entry
  point.

  Every bundled source's default export is typed `ObservationSource`, but that type — and the core
  types its interface shape transitively references — were previously reachable only via
  `@agentmonitors/core` directly, not from the source package itself. Enabling API Extractor's report
  generation (issue #285) surfaced this as `ae-forgotten-export` warnings embedded in each package's
  checked-in API report; re-exporting resolves it with a clean signature. No runtime behavior changes.

### Patch Changes

- Updated dependencies [24e7685]
- Updated dependencies [a7b5729]
- Updated dependencies [8638936]
- Updated dependencies [e201c48]
- Updated dependencies [89e705f]
- Updated dependencies [36a2e48]
- Updated dependencies [9f141bb]
- Updated dependencies [720d072]
- Updated dependencies [4e46c41]
  - @agentmonitors/core@0.11.0

## 0.2.5

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
- Updated dependencies [a4c642f]
- Updated dependencies [867f8b7]
- Updated dependencies [fd2aeff]
- Updated dependencies [697b525]
- Updated dependencies [77d9568]
- Updated dependencies [d4299cf]
- Updated dependencies [0504103]
- Updated dependencies [b7e2711]
  - @agentmonitors/core@0.10.0

## 0.2.4

### Patch Changes

- c81e868: Teach the inline pipeline idiom for `command-poll` (003 §11.1)

  `command` remains argv-only (spawned with `shell: false` — no injection surface), but the common
  mistake of writing a shell pipeline as a bare string is now self-correcting: `parseScopeConfig`
  rejects a string `command` with a message that names the supported inline form,
  `['sh', '-c', '<pipeline>']`, and the `init --type command-poll` scaffold documents it in a comment.
  No behavior change for existing argv monitors; this only improves the error and the template.

- Updated dependencies [8dbda37]
- Updated dependencies [dcb7ae9]
- Updated dependencies [0dd2223]
- Updated dependencies [33e2f0d]
- Updated dependencies [1836f04]
- Updated dependencies [19f2d8d]
- Updated dependencies [50db864]
- Updated dependencies [745b6fb]
- Updated dependencies [094fc2b]
- Updated dependencies [3ecc9bb]
- Updated dependencies [3e197fc]
- Updated dependencies [8a9388c]
- Updated dependencies [7ab21d3]
- Updated dependencies [e0b52bd]
- Updated dependencies [14c6b94]
  - @agentmonitors/core@0.9.0

## 0.2.3

### Patch Changes

- Updated dependencies [dfb124a]
- Updated dependencies [07f8cf7]
  - @agentmonitors/core@0.8.0

## 0.2.2

### Patch Changes

- Updated dependencies [5c748a4]
  - @agentmonitors/core@0.7.0

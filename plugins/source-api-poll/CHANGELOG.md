# @agentmonitors/source-api-poll

## 0.5.0

### Minor Changes

- fde6b6a: Bound `api-poll` request duration, response size, and composite fan-out so a stalled or huge
  endpoint can no longer wedge a tick, delay unrelated monitors, or exhaust daemon memory. Minor, not
  patch: the new `timeout` scope field is additive public authoring surface (precedent: the earlier
  `api-poll` composite option was likewise classified `minor — new authoring surface`).
  - A single request/body deadline (default `30s`, overridable per-monitor via the new `timeout`
    scope field) now bounds the entire exchange — connecting, headers, and streaming the body,
    including a stalled/trickling chunked body — not just the initial `fetch()` call. A declared-
    oversize `Content-Length` is rejected early and aborts the request instead of leaking the
    connection; a `change-detection.strategy: status-code` monitor skips reading the body entirely and
    is exempt from the byte cap.
  - Response bodies are capped at 10 MiB via a streamed running count (the real authority once
    `Content-Length` is absent or wrong, not just the early `Content-Length` check).
  - Composite mode (`change-detection.composite`) runs at most 5 parts concurrently instead of
    starting every part at once, with the same per-part deadline and byte cap as a single-URL
    monitor; a failing/timed-out part fails the whole batch immediately and cancels its siblings
    instead of waiting for every in-flight part to reach its own deadline.
  - The per-part cap alone didn't bound the _aggregate_: a composite is now also bounded on every
    other axis — a cumulative 10 MiB budget across the rendered (framed) artifact, `parts` capped at
    50 entries, and each part `id` capped at 256 Unicode code points — enforced identically in the
    JSON Schema (rejected at authoring time by `agentmonitors validate`) and the parser (defense in
    depth for a hand-edited `MONITOR.md`), which also bounds worst-case tick duration to
    `ceil(parts / 5) * timeout`.
  - Adopts core's hardened `parseOperationTimeoutMs`: a present non-string `timeout`, a leading-zero
    duration (`"01s"`), and a duration exceeding Node's `setTimeout` maximum (`"25d"`, now rejected by
    the JSON Schema `pattern` too — see the `@agentmonitors/core` changeset) are all rejected at parse
    time instead of silently defaulting, being accepted, or overflowing to a near-instant timer.
  - A timeout, oversize response, or over-budget composite errors the observation cleanly (no
    `nextState` advance, no partial body baselined or persisted) — the same semantics as an existing
    non-2xx or network-error failure.

### Patch Changes

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

## 0.4.1

### Patch Changes

- Updated dependencies [2f0a9d3]
  - @agentmonitors/core@0.12.0

## 0.4.0

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

## 0.3.1

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

## 0.3.0

### Minor Changes

- f6bc858: Add composite-observation mode to `api-poll` (003 §2.6)

  `api-poll` can now assemble **one** observation from **many** sub-resource calls under a single `objectKey`. A monitor configures `change-detection.composite` with an `object-key` and a list of `parts` (each an `id` + `url`); `observe()` fetches every part within one cycle and reduces them into one stable, deterministic composite `snapshotText` (parts rendered sorted by `id`, so call ordering never churns the snapshot). The runtime diffs that single composite snapshot against the consumer's baseline exactly as it would a single-call snapshot — the source returns a current-state snapshot, never a pre-diffed delta (003 §2.5).

  A failed underlying call fails the whole observation (the prior baseline is preserved); `change-detection.composite` and `change-detection.collection` are mutually exclusive. Backward compatible: the top-level `url` modes are unchanged, and a monitor with neither `url` nor `composite` is still rejected.

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

### Patch Changes

- 5e83550: Redact credentials, query strings, and fragments from URLs surfaced in diagnostics. This now covers both the `json-diff` non-JSON warning and the non-2xx HTTP error messages (single-URL and composite-part), which are persisted durably to observation history — so a credential-bearing URL no longer leaks on the common 401/403 failure path.
- 1836f04: DX polish (issue #153): validate output consistency, urgency error wording, api-poll feedback
  - **validate**: invalid monitors now display the monitor ID (matching valid-monitor output) instead of the full file path; passing a file path shows a `monitor test` pointer
  - **core**: inverted urgency range error no longer duplicates the field name (`urgency: range "high..normal" is inverted` instead of `urgency: urgency range …`)
  - **api-poll `monitor test`**: HTTP status and response body size are now printed after the baseline so authors can spot bad URLs immediately
  - **api-poll observe**: Node `fetch` errors now propagate the underlying network cause (ECONNREFUSED, ENOTFOUND, timeout) in the message, visible in `monitor explain` output

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

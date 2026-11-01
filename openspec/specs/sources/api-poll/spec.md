# sources/api-poll Specification

## Purpose

The bundled `api-poll` observation source (`@agentmonitors/source-api-poll`): polls an HTTP(S) URL,
detects change with a text, JSON, or status-code strategy, and enforces request-duration, response-size,
and composite fan-out bounds. Runtime timing, persistence, and diff rendering stay with the runtime per
the `sources/contract` capability (SP1).

## Requirements

### Requirement: api-poll source name and required url

The system SHALL register the bundled source under the name `api-poll`. Its scope SHALL require `url` (string). When `url` is absent or not a string, `observe()` SHALL throw `scope.url must be a string`.

#### Scenario: Missing url throws clearly

- **WHEN** an `api-poll` monitor's `watch:` block omits `url`
- **THEN** `observe()` throws `scope.url must be a string`

#### Scenario: Minimal web-page monitor needs no change-detection block

- **WHEN** a monitor declares `watch: { type: api-poll, url: 'https://example.com/page', interval: 5m }`
- **THEN** it is a complete, valid `api-poll` scope
- **AND** the strategy is inferred from the response `Content-Type`

### Requirement: api-poll optional scope fields

The `api-poll` scope SHALL accept the optional fields `method`, `headers`, `interval`, `auth`, `timeout`, and `change-detection`. `method` SHALL default to `GET` both in the schema and in the outgoing request when absent. `timeout` SHALL default to `30s`. `change-detection` SHALL be optional.

#### Scenario: Method defaults to GET

- **WHEN** a monitor omits `method`
- **THEN** the request is issued with method `GET`

#### Scenario: Headers are sent with the request

- **WHEN** a monitor declares `headers: { Accept: application/json }`
- **THEN** the request carries `Accept: application/json`

### Requirement: api-poll interval is a scheduling hint

The `api-poll` scope schema SHALL declare `interval` as a string with pattern `^\d+[smhd]$`. The plugin SHALL NOT read `interval` itself; it is consumed by the scheduling engine per the `runtime/tick-scheduling` capability.

#### Scenario: Interval is validated but not used by the plugin

- **WHEN** a monitor declares `interval: 5m`
- **THEN** the scope validates against `^\d+[smhd]$`
- **AND** the runtime, not the plugin, decides when `observe()` is next called

### Requirement: api-poll change-detection strategies

The system SHALL support three `change-detection.strategy` values: `text-diff` compares raw response body strings; `json-diff` parses both bodies as JSON, recursively sorts object keys, and compares the serialized strings (ignoring key order and whitespace); `status-code` compares only HTTP status codes and ignores body changes.

#### Scenario: text-diff detects response body changes

- **GIVEN** a baselined `text-diff` monitor whose prior body was `status: ok`
- **WHEN** the next poll returns body `status: degraded`
- **THEN** exactly one observation is emitted

#### Scenario: json-diff ignores whitespace and key-order differences

- **GIVEN** a baselined `json-diff` monitor whose prior body was `{"a":1,"b":2}`
- **WHEN** the next poll returns `{ "b": 2,  "a": 1 }`
- **THEN** no observation is emitted

#### Scenario: status-code detects a status change and ignores body changes

- **GIVEN** a baselined `status-code` monitor that last saw HTTP `200`
- **WHEN** the next poll returns HTTP `200` with a different body
- **THEN** no observation is emitted
- **AND WHEN** a later poll returns HTTP `503`
- **THEN** exactly one observation is emitted

### Requirement: api-poll strategy inference from Content-Type

When `change-detection.strategy` is omitted, the system SHALL infer it from the response `Content-Type` (issue #230): a JSON media type (`application/json` or any RFC 6838 structured-syntax `+json` suffix such as `application/ld+json`) SHALL infer `json-diff`; every other type, including `text/html`, `text/plain`, and a missing or unknown `Content-Type`, SHALL infer `text-diff`.

#### Scenario: HTML page infers text-diff

- **WHEN** a monitor omits `change-detection` and the response is `Content-Type: text/html`
- **THEN** the effective strategy is `text-diff`

#### Scenario: Structured-syntax JSON suffix infers json-diff

- **WHEN** a monitor omits `change-detection` and the response is `Content-Type: application/ld+json`
- **THEN** the effective strategy is `json-diff`

#### Scenario: Missing Content-Type infers text-diff

- **WHEN** a monitor omits `change-detection` and the response carries no `Content-Type`
- **THEN** the effective strategy is `text-diff`

### Requirement: Explicit api-poll strategy always wins

When the author specifies `change-detection.strategy`, the system SHALL use it verbatim, with no inference and no `Content-Type` override.

#### Scenario: Explicit json-diff against an HTML page stays json-diff

- **WHEN** a monitor sets `strategy: json-diff` and the response is `Content-Type: text/html`
- **THEN** the effective strategy is `json-diff` (and the non-JSON warning applies)

#### Scenario: Explicit text-diff against a JSON body stays text-diff

- **WHEN** a monitor sets `strategy: text-diff` and the response is `Content-Type: application/json`
- **THEN** the effective strategy is `text-diff`

### Requirement: json-diff falls back to text comparison on parse failure

When `json-diff` parsing fails for either the previous or the current body, the system SHALL fall back to raw text comparison of the two bodies.

#### Scenario: Unparseable body compared as text

- **GIVEN** a baselined `json-diff` monitor whose prior body was `<html>a</html>`
- **WHEN** the next poll returns `<html>b</html>`
- **THEN** the bodies are compared as raw text and one observation is emitted

### Requirement: Warning for explicit json-diff on a non-JSON body

When an explicit `strategy: json-diff` is configured and the fetched body does not parse as JSON, the source SHALL attach a non-fatal warning to `ObservationResult.warnings` (issues #219, #230) and SHALL NOT change the observation outcome. An inferred strategy SHALL never produce this warning. The URL in the warning SHALL be redacted (userinfo, query, fragment stripped).

#### Scenario: Explicit json-diff on HTML warns

- **WHEN** a monitor with explicit `strategy: json-diff` fetches a body that is not JSON
- **THEN** `warnings` contains `api-poll: change-detection.strategy is json-diff but the response from <redacted-url> does not parse as JSON; falling back to text comparison. Use strategy: text-diff for HTML/plain-text pages.`
- **AND** the baseline/diff still proceeds via the text fallback

#### Scenario: Warning URL is redacted

- **WHEN** the warning fires for `https://user:pw@example.com/p?token=abc#frag`
- **THEN** the warning text contains neither `user:pw`, `token=abc`, nor `#frag`

#### Scenario: monitor test surfaces the warning

- **WHEN** `agentmonitors monitor test` runs such a monitor
- **THEN** it prints the warning prefixed `Warning:` during the dry run

#### Scenario: Inferred json-diff never warns

- **WHEN** a monitor omits `change-detection` and the response is `application/json`
- **THEN** no non-JSON warning is attached

### Requirement: api-poll records its strategy on the snapshot

The `api-poll` source SHALL set `snapshot.strategy` to its effective strategy, so that `json-diff` selects the runtime's structural `diffText` renderer (issue #437) per the `runtime/event-materialization` capability. This is a bundled-source convention, not a `sources/contract` requirement: a third-party source MAY opt in the same way; a source that omits it renders via the line-level text diff.

#### Scenario: json-diff monitor gets a structural diff

- **WHEN** a `json-diff` `api-poll` monitor detects a change in one element of a compact single-line JSON array
- **THEN** `snapshot.strategy` is `json-diff`
- **AND** the delivered `diffText` names the added/removed/changed elements rather than a whole-line remove-all/add-all

### Requirement: api-poll bearer authentication

When `auth.type` is `bearer`, the system SHALL resolve the token from `auth.token` first, then from the environment variable named by `auth['token-env']`, and send `Authorization: Bearer <token>`. When neither yields a value, it SHALL throw `Bearer auth requires a token. Set the <VAR> environment variable or add auth.token to your monitor's scope config.` (or, with no `token-env`, `… Add auth.token or auth.token-env to your monitor's scope config.`).

#### Scenario: Token resolved from the environment

- **WHEN** a monitor declares `auth: { type: bearer, token-env: API_TOKEN }` and `API_TOKEN=abc` is set in the daemon environment
- **THEN** the request carries `Authorization: Bearer abc`

#### Scenario: Missing bearer token throws an actionable error

- **WHEN** `auth: { type: bearer, token-env: API_TOKEN }` and `API_TOKEN` is unset with no `auth.token`
- **THEN** `observe()` throws `Bearer auth requires a token. Set the API_TOKEN environment variable or add auth.token to your monitor's scope config.`

### Requirement: api-poll basic authentication

When `auth.type` is not `bearer`, the system SHALL use `auth.username` and `auth.password` (each defaulting to the empty string when absent), Base64-encode `username:password`, and send `Authorization: Basic <encoded>`.

#### Scenario: Basic credentials are encoded

- **WHEN** a monitor declares `auth: { type: basic, username: u, password: p }`
- **THEN** the request carries `Authorization: Basic dTpw`

### Requirement: api-poll observation identity

When a change is detected, the source SHALL emit one observation with `title` and `summary` `API response changed: <url>`, `payload` `{ url, status, strategy, body }`, `snapshotText` set to the response body (always, with no binary check), `objectKey` `<url>`, `queryScope` `{ url: <url> }`, and `snapshot` `{ url, status, bodyLength, strategy }`. The polled URL is the source-defined object identity (SP3).

#### Scenario: Changed response produces the documented observation shape

- **WHEN** `https://api.example.com/status` changes from `200 "a"` to `200 "b"` under `text-diff`
- **THEN** the observation has `objectKey` `https://api.example.com/status`, `queryScope` `{ url: "https://api.example.com/status" }`, `payload.body` `"b"`, `snapshotText` `"b"`
- **AND** `snapshot` records `bodyLength` and `strategy` rather than the full body

### Requirement: api-poll redacts the URL in human-readable text

The URL embedded in an observation's `title` and `summary` SHALL be redacted (userinfo, query, and fragment stripped) and then bounded per the `sources/contract` objectKey-as-identity rule; the exact authored URL SHALL remain on `objectKey` and `payload.url`. Rationale: title/summary are durably persisted and delivered to agents, and polled URLs routinely carry tokens.

#### Scenario: Token in query string never reaches the title

- **WHEN** a change is detected on `https://api.example.com/s?token=secret`
- **THEN** `title` and `summary` are `API response changed: https://api.example.com/s`
- **AND** `objectKey` and `payload.url` are `https://api.example.com/s?token=secret`

#### Scenario: Authored name overrides the source title

- **WHEN** the monitor declares a `name`
- **THEN** that name replaces `title` at materialization per the `runtime/event-materialization` capability, and `summary` keeps the redacted source text

### Requirement: api-poll stateful baseline

The `api-poll` source SHALL declare `stateful: true`. The first successful (2xx) call SHALL store `{ body, status }` as `nextState` and return an empty `observations` array. Subsequent calls SHALL compare against `context.previousState` and emit an observation only when the configured strategy reports a change.

#### Scenario: First poll establishes a baseline with no observations

- **WHEN** an `api-poll` monitor is observed for the first time and the endpoint returns `200`
- **THEN** `observations` is empty and `nextState` is `{ body, status }`

#### Scenario: Unchanged response emits nothing

- **GIVEN** a baselined monitor
- **WHEN** the next poll returns an identical response
- **THEN** no observation is emitted

### Requirement: Non-2xx responses error for body-diffing strategies

For `text-diff` and `json-diff` (explicit or inferred), a non-2xx HTTP response SHALL NOT establish or advance a baseline; the source SHALL throw `api-poll received HTTP <status> from <redacted-url> — check auth/url; not establishing a baseline on an error response` (issue #220). The runtime then records an `errored` outcome with no `nextState` advance, preserving any prior baseline per the `runtime/monitor-state` capability.

#### Scenario: Bad token yields an errored observation, not a baseline

- **WHEN** a `text-diff` monitor's endpoint returns HTTP `401`
- **THEN** `observe()` throws `api-poll received HTTP 401 from <url> — check auth/url; not establishing a baseline on an error response`
- **AND** `monitor history` shows the tick as `errored` and `daemon once`/`daemon run` include it in their error reporting

#### Scenario: Prior baseline survives a 500

- **GIVEN** a `json-diff` monitor baselined on a `200` body
- **WHEN** the next poll returns HTTP `500`
- **THEN** the stored baseline is unchanged
- **AND** a later `200` with the original body emits no observation

#### Scenario: monitor test reports the failure

- **WHEN** `agentmonitors monitor test` runs a body-diffing monitor against an endpoint returning `404`
- **THEN** it reports `Observation failed: api-poll received HTTP 404 …`

#### Scenario: Real endpoint through the CLI

- **WHEN** an `api-poll` monitor targets a real local HTTP server returning `401` and is ticked through the CLI
- **THEN** the tick is reported as errored rather than as a successful baseline (#219, #220)

### Requirement: status-code treats non-2xx as an observed signal

For `change-detection.strategy: status-code`, a non-2xx response SHALL NOT throw; the status SHALL be the observed signal and SHALL baseline and diff like any other status.

#### Scenario: Endpoint going down fires under status-code

- **GIVEN** a `status-code` monitor baselined on HTTP `200`
- **WHEN** the next poll returns HTTP `503`
- **THEN** exactly one observation is emitted and no error is thrown

### Requirement: api-poll network error propagation

When the HTTP request fails at the network level (ECONNREFUSED, ENOTFOUND, timeout, …), the source SHALL throw a new `Error` whose message is `fetch failed: <cause.message>` and whose `cause` is the original fetch error, so `monitor explain` and observation-history audit rows show the real reason. Network failures throw before any status is known and produce no baseline.

#### Scenario: Connection refused names the real cause

- **WHEN** the polled URL is `http://127.0.0.1:9999/` and nothing is listening
- **THEN** the recorded error message is `fetch failed: connect ECONNREFUSED 127.0.0.1:9999`

### Requirement: monitor test prints the api-poll baseline status line

`agentmonitors monitor test` for an `api-poll` monitor SHALL print, after establishing a successful baseline and before the second observation, the HTTP status code and response body size in UTF-8 bytes as `HTTP <status> (<bytes> bytes)`. Network-level failures SHALL NOT produce this line. The command surface itself is owned by the `cli/monitor-commands` capability.

#### Scenario: Baseline status line

- **WHEN** `monitor test` runs an `api-poll` monitor named `api-health` whose endpoint returns a 1234-byte `200`
- **THEN** the output contains `Baseline established. The "api-poll" source requires a prior baseline before it can detect changes.` followed by `  HTTP 200 (1234 bytes)` and `Running a second observation to demonstrate change detection...`

#### Scenario: Empty 200 is visible

- **WHEN** a misconfigured endpoint returns an empty `200`
- **THEN** the status line reads `HTTP 200 (0 bytes)`

### Requirement: api-poll request/body deadline

A single abort timer started when the request is issued SHALL bound the entire exchange — connect, headers, and streaming the body to completion (issue #304). On expiry the source SHALL throw `api-poll request to <redacted-url> timed out after <timeoutMs>ms`, yielding an `errored` outcome with no `nextState` advance. A mid-body undici `TypeError: terminated` raised after the timer fired SHALL be classified as the same timeout error.

#### Scenario: Server that never sends headers is aborted

- **WHEN** `timeout: 1s` and the server accepts the connection but never responds
- **THEN** after ~1s `observe()` throws `api-poll request to <url> timed out after 1000ms`

#### Scenario: Trickling body is aborted at the same deadline

- **WHEN** `timeout: 1s` and the server sends headers promptly but streams the body slower than the deadline
- **THEN** the request is aborted at 1s with the same timeout error and the prior baseline is preserved

### Requirement: Operation timeout default and type

The `timeout` scope field SHALL default to `30s` (30000ms) only when it is absent (`undefined`). A present non-string value (a number, `null`, …) SHALL be rejected with `Invalid timeout: expected a string matching <OPERATION_TIMEOUT_PATTERN> (e.g. "30s"), got <type>.` A malformed string SHALL be rejected with `Invalid duration: "<value>". Expected format: <number><s|m|h|d>`. The same grammar SHALL apply to `command-poll`'s `timeout`.

#### Scenario: Omitted timeout defaults to 30s

- **WHEN** a monitor omits `timeout`
- **THEN** the effective deadline is 30000ms

#### Scenario: Numeric timeout is rejected, not defaulted

- **WHEN** a monitor declares `timeout: 30`
- **THEN** parsing throws `Invalid timeout: expected a string matching … (e.g. "30s"), got number.`

#### Scenario: Valid override

- **WHEN** a monitor declares `timeout: "1m"`
- **THEN** the effective deadline is 60000ms

### Requirement: Operation timeout value bounds

The system SHALL reject, in both the JSON Schema pattern (`OPERATION_TIMEOUT_PATTERN`) and the parser, a zero-length value (`"0s"`, `"0m"`, `"0h"`, `"0d"`), a leading-zero value (`"01s"`, `"007m"`), and any value above `2147483647`ms (~24.8 days, the largest `setTimeout` delay). The pattern SHALL bound each unit's digit run to `2147483`s, `35791`m, `596`h, `24`d.

#### Scenario: Zero-length timeout rejected

- **WHEN** a monitor declares `timeout: "0s"`
- **THEN** parsing throws `Invalid timeout: "0s". A zero-length timeout is not allowed; specify at least 1 unit (e.g. "1s").`

#### Scenario: Leading zero rejected

- **WHEN** a monitor declares `timeout: "01s"`
- **THEN** parsing throws an error beginning `Invalid timeout: "01s". A leading zero is not allowed; use "1s" instead of "01s"`
- **AND** the schema pattern rejects it at authoring time too

#### Scenario: Over-maximum deadline rejected at authoring time and parse time

- **WHEN** a monitor declares `timeout: "25d"`
- **THEN** `agentmonitors validate` rejects it against the schema pattern
- **AND** the parser throws an error beginning `Invalid timeout: "25d" (2160000000ms) exceeds the maximum supported deadline of 2147483647ms (~24.8 days)`

#### Scenario: Largest allowed day value accepted

- **WHEN** a monitor declares `timeout: "24d"`
- **THEN** it is accepted

### Requirement: api-poll rejects a declared oversize Content-Length early

For body-reading strategies the source SHALL cap each response body at 10 MiB (10485760 bytes), not configurable. When the response declares a `Content-Length` above the cap, the source SHALL abort the request and release the unread body back to the connection pool, then throw `api-poll response from <redacted-url> declares Content-Length <n> bytes, exceeding the 10485760-byte cap` before reading any body bytes.

#### Scenario: Declared oversize rejected before reading

- **WHEN** a `text-diff` response declares `Content-Length: 20000000`
- **THEN** no body bytes are read and `observe()` throws the `declares Content-Length 20000000 bytes` error

### Requirement: api-poll counts streamed body bytes against the cap

Regardless of what or whether `Content-Length` was declared (it is absent under chunked encoding and can be wrong), the source SHALL count every chunk read from the body stream as the authority and, once the running total exceeds 10485760 bytes, SHALL abort the in-flight request and throw `api-poll response from <redacted-url> streamed <n> bytes, exceeding the 10485760-byte cap`.

#### Scenario: Under-declared Content-Length does not bypass the cap

- **WHEN** a response declares `Content-Length: 100` but streams more than 10485760 bytes
- **THEN** the request is aborted and `observe()` throws the `streamed <n> bytes` error

#### Scenario: Chunked oversize body rejected by streamed count

- **WHEN** a chunked response with no `Content-Length` streams more than 10485760 bytes
- **THEN** the request is aborted and `observe()` throws the `streamed <n> bytes` error

### Requirement: Oversized bodies are never baselined

An oversize rejection SHALL be a thrown error, not a truncated result: the runtime records an `errored` outcome and `api-poll` SHALL NEVER baseline or persist a partial or oversized body. Rationale: unlike `command-poll`'s truncated-but-diffable stdout, an incomplete HTTP body as a baseline would silently corrupt future diffs.

#### Scenario: Oversize leaves the baseline intact

- **GIVEN** a baselined `json-diff` monitor
- **WHEN** the next response streams past the cap
- **THEN** the outcome is `errored` and `nextState` is not advanced

### Requirement: status-code is exempt from the body size cap

When `change-detection.strategy` is explicitly `status-code`, the source SHALL NOT read the response body at all: it SHALL release the response via `cancel()` without buffering or counting bytes, so the 10 MiB cap never applies. An omitted strategy SHALL always read the body, because inference resolves only to body-diffing strategies.

#### Scenario: Large artifact availability watched under status-code

- **WHEN** an explicit `status-code` monitor polls an endpoint whose body is 50 MiB
- **THEN** no size error is raised and a `200 → 503` transition is still observed

#### Scenario: Inferred strategy still reads and caps the body

- **WHEN** a monitor omits `change-detection` and the response streams 50 MiB
- **THEN** the cap applies and `observe()` throws the streamed-oversize error

### Requirement: api-poll composite mode

The bundled `api-poll` source SHALL realize composite observation (general contract per `sources/contract`) through a `change-detection.composite` block with one `object-key`, an optional `title`, and `parts` (each an `id` and a `url`). Each `observe()` SHALL fetch every part and render them sorted by `id` into one `snapshotText` under the one `object-key`; a failed part SHALL fail the whole observation without advancing state. `composite` and `collection` are mutually exclusive.

#### Scenario: Parts render sorted by id

- **GIVEN** `change-detection.composite` with `object-key: 'order-42'` and parts `line-2`, `header`, `line-1`
- **WHEN** the source observes
- **THEN** one observation with `objectKey: 'order-42'` is emitted whose snapshot renders parts in the order `header`, `line-1`, `line-2`

#### Scenario: Failed part fails the observation

- **WHEN** the fetch for part `line-1` fails
- **THEN** the observation fails, `nextState` does not advance, and the prior baseline is preserved

### Requirement: Composite parts get independent deadlines and caps

In composite mode (per "api-poll composite mode"), each part SHALL get the same request/body deadline and per-part byte cap as a single-URL monitor, applied independently per part.

#### Scenario: One slow part times out on its own deadline

- **WHEN** a composite has parts `a` and `b`, `timeout: 2s`, and only `b` stalls
- **THEN** `b` is aborted at its own 2s deadline and the composite fails

### Requirement: Composite concurrency is bounded at five

The source SHALL run at most 5 composite part-fetches concurrently, not configurable, as a bounded worker pool: each completed fetch's slot is immediately taken by the next queued part (not fixed batches of 5).

#### Scenario: Twelve parts never exceed five in flight

- **WHEN** a composite declares 12 parts
- **THEN** at no point are more than 5 requests in flight
- **AND** a 6th part starts as soon as any of the first 5 completes

### Requirement: Composite fails fast and aborts siblings

A failing composite part (non-2xx under a body-diffing strategy, timeout, oversize, or budget exhaustion) SHALL fail the whole composite observation immediately, without waiting for other in-flight parts to reach their deadlines, and SHALL abort every other in-flight part via a shared abort signal. `nextState` SHALL never advance and the prior baseline SHALL be preserved (all-or-nothing).

#### Scenario: First failure rejects immediately

- **WHEN** part `a` returns HTTP `500` while parts `b`–`e` are still in flight with a `30s` deadline
- **THEN** the composite rejects immediately with `api-poll received HTTP 500 from composite part "a" (<url>) — check auth/url; not establishing a baseline on an error response`
- **AND** parts `b`–`e` are aborted rather than run to completion

### Requirement: Composite cumulative rendered-artifact budget

The source SHALL track the running sum of every part's rendered section (`## <id>\n<body>`) across the composite and, once it exceeds 10485760 bytes (not configurable), SHALL fail the whole composite with `api-poll composite "<objectKey>" exceeded the 10485760-byte cumulative rendered-artifact budget after part "<partId>" (<n> bytes across the composite's framed parts fetched so far) — reduce the number/size of parts or split into multiple monitors`.

#### Scenario: Many small parts exceed the aggregate budget

- **WHEN** a composite has 12 parts of 1 MiB each, every part individually under the per-part cap
- **THEN** the composite fails with the cumulative-budget error, siblings are aborted, and `nextState` is not advanced

### Requirement: Composite part count and part id length caps

The source SHALL cap `change-detection.composite.parts` at 50 entries and each part `id` at 256 characters, both in the JSON Schema (`maxItems`, `maxLength`) and in the parser, rejecting before any request is issued with `change-detection.composite.parts must not exceed 50 entries (got <n>)` or `change-detection.composite.parts[<i>].id must not exceed 256 characters (got <n>)`.

#### Scenario: 100,000 empty-body parts rejected before the network

- **WHEN** a composite declares 100000 parts with empty bodies
- **THEN** `agentmonitors validate` rejects it and the parser throws `change-detection.composite.parts must not exceed 50 entries (got 100000)`
- **AND** no HTTP request is issued

#### Scenario: An 11 MiB part id rejected before the network

- **WHEN** a composite part declares an `id` 11534336 characters long
- **THEN** the parser throws `change-detection.composite.parts[0].id must not exceed 256 characters (got 11534336)` and no request is issued

#### Scenario: Worst-case composite tick duration is bounded

- **WHEN** a composite declares the maximum 50 parts with the default `30s` timeout
- **THEN** it resolves or fails within `ceil(50 / 5) * 30s = 300s`

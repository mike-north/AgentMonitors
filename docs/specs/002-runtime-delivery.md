# 002 — Runtime, Delivery & Persistence

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [001-monitor-definition.md](./001-monitor-definition.md)
> **Covers:** polling, source state, notify dispatch, event materialization, session projection, hook state, delivery lifecycle, daemon IPC, agent adapter contract, legacy inbox relationship, persistence schema

## 1. Overview

This document specifies how authored monitors become delivered work signals. It defines the runtime tick loop, monitor scheduling, event persistence, session-aware projection, hook state materialization, delivery claims, the daemon and IPC layer, the agent adapter contract, and the relationship between the runtime event model and the older inbox item model.

### Why a dedicated runtime spec?

The repository's most important behavior lives here: not merely detecting change, but deciding when a detected signal becomes durable, whom it is projected to, and how it is surfaced to an active agent (PP1, PP4, AP1, AP3).

### Principles Satisfied

| Section                           | Principles              |
| --------------------------------- | ----------------------- |
| Tick loop and due scheduling      | PP1, PP4, PP6, AP3, BP1 |
| Notify dispatch                   | PP5, PP7, SP4           |
| Event persistence and snapshots   | SP3, SP5                |
| Session projection and hook state | PP4, AP1, BP2           |
| Daemon and IPC                    | PP4, AP3                |
| Agent integration (adapters)      | AP1, AP3                |
| Legacy inbox split                | AP2                     |

## 2. Runtime Tick Model

For each runtime tick, the implementation **MUST**:

1. scan the supplied monitors directory for `**/MONITOR.md`
2. parse valid monitor definitions and collect parse errors separately
3. resolve each parsed monitor's `source` name against the source registry
4. fail the tick if a parsed monitor references an unknown source
5. determine whether the monitor is due to run
6. call the source's `observe()` method with: the monitor's `scope`, the monitor's previously persisted source state if any, the runtime-supplied `now` timestamp
7. route returned observations through notify dispatch
8. persist updated source state and notify state
9. materialize emitted observations as durable events
10. refresh hook state for sessions in the affected workspace

Verified: `libs/core/src/runtime/service.ts` — `AgentMonitorRuntime.tick()` (lines 358–420).

### 2.1 Due scheduling

Default due intervals are:

| Source class  | Default                                  |
| ------------- | ---------------------------------------- |
| `schedule`    | evaluated once per minute                |
| `api-poll`    | 5 minutes if `scope.interval` is absent  |
| other sources | 30 seconds if `scope.interval` is absent |

Verified: `libs/core/src/runtime/service.ts` — constants `DEFAULT_FILE_FINGERPRINT_POLL_MS = 30_000`, `DEFAULT_API_POLL_MS = 300_000` (lines 30–31); `scheduleForMonitor()` (lines 449–488).

If a non-schedule monitor provides a string `scope.interval`, the runtime **MUST** parse it as a duration using `parseDuration` and use the result as the due interval. Verified: `libs/core/src/runtime/service.ts` lines 478–483 (generic interval path).

### 2.2 Schedule matching

For schedule monitors: `scope.cron` is interpreted as a five-field cron expression; `scope.timezone` defaults to `UTC` if omitted; malformed cron fields are treated as non-matching (the entire `cronMatchesDate` call returns `false`); a schedule monitor cannot fire more than once in the same minute because the elapsed guard `elapsed >= 60_000` is required in addition to cron-field matching; missed cron windows are not backfilled (BP1). The schedule source itself does not decide whether it is due. The runtime does.

Verified: `libs/core/src/runtime/service.ts` — `cronMatchesDate()` (lines 118–132), `scheduleForMonitor()` schedule branch (lines 456–467).

### 2.3 Watch-mode execution

In addition to the one-shot `observe()` tick loop, the runtime drives continuous `watch()` for sources that implement it (NP4). `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)` scans the tree and, for each monitor whose source exposes `watch()`, consumes its `AsyncIterable<Observation>`, funnelling each yielded observation through the **same** notify dispatch → event materialization → session projection pipeline as `observe()` (the shared `ingest()` path). It returns a `WatchHandle` whose `stop()` aborts (via `context.signal`) and awaits every watcher. `daemon run` starts watchers at startup and stops them on shutdown.

While a monitor has an active watcher, the tick loop **MUST** skip its `observe()`, so it is never driven twice. A watcher that throws (other than from the runtime's own abort) is reported via the `onError` callback and released, after which the tick loop resumes driving that monitor via `observe()`. A `watch()` source owns its change-detection state in memory; the runtime does not persist it, so watchers re-establish fresh on restart.

> **Example:** a source that opens an OS file-system watcher yields a `modified` observation the instant a file changes, rather than waiting for the next poll interval; `stop()` closes the OS watcher via the aborted signal.
>
> **Test implication:** a `watch()`-based source whose iterator yields one observation then idles until aborted produces exactly one materialized, session-projected event, and `stop()` resolves with the source's abort handler having fired (`libs/core/src/runtime/service.test.ts`).

Verified: `libs/core/src/runtime/service.ts` — `watchMonitors()`, `consumeWatch()`, the `activeWatchers` skip in `tick()`, and the shared `ingest()` helper; `apps/cli/src/commands/daemon.ts` — watcher start/stop in `runLoop()`.

### 2.4 Tick result

`tick()` returns a `RuntimeTickResult` summarizing the tick:

- `evaluatedMonitors` — the ids of every monitor whose `observe()` was attempted this tick (including monitors whose outcome was `errored`).
- `emittedEventIds` — the ids of the durable events materialized this tick.
- `erroredObservations` — one `{ monitorId, message }` entry per monitor whose observation failed this tick (its `observe()` threw/rejected, or its `ingest()` failed). Each entry is pushed from the **same** code path that writes the `errored` row to `observation_history` (§15 `observation_history`), so the result is the single source of truth for tick-time failures — it is never recomputed by re-scanning history. A monitor that genuinely observed no change does **not** appear here.
- `skippedMonitors` — one `{ monitorId, nextDueAt }` entry per monitor found in the directory but skipped because its interval has not elapsed since the last observation. Populated from the **same** scheduling decision that gates evaluation, so it is never recomputed. A monitor with an active continuous watcher does **not** appear here (it is driven by the watcher, not by the tick).

The runtime **MUST** surface `erroredObservations` so a caller (e.g. the CLI tick output, §10.1/§10.2) can report a failed observation rather than print a clean `emitted 0` that an author cannot distinguish from a genuine no-change.

The runtime **MUST** surface `skippedMonitors` so a caller can distinguish "monitors exist but are not yet due" from "no monitors found" — two situations that previously produced identical CLI output (issue #152).

Verified: `libs/core/src/runtime/types.ts` — `RuntimeTickResult`, `ErroredObservation`, `SkippedMonitor`; `libs/core/src/runtime/service.ts` — `tick()` populates `erroredObservations` in both the `observe()` and `ingest()` error branches alongside the `recordObservationHistory({ result: 'errored' })` write; populates `skippedMonitors` in the `!schedule.due` branch from the same scheduling decision.

## 3. Persisted Monitor State

Each monitor has persisted runtime state containing: `lastObservationAt`, `sourceState`, `notifyState`. `sourceState` is owned by the source plugin and returned via `nextState`. `notifyState` is owned by the runtime and records delivery timing state such as active suppression windows for throttle and pending observation batches for debounce.

This split is important: source plugins own change-detection state, while the runtime owns notification timing behavior.

**Restart-safety / upgrade backfill (issue #109):** When a persisted `notifyState.pendingDebounce` batch is hydrated on daemon restart, envelopes written before the range-urgency upgrade may lack an `effectiveUrgency` field. The runtime **MUST** backfill it on hydration using `effectiveObservationUrgency(monitor, observation)` so that the materialized `monitor_events.urgency` row is never written with an undefined value. `effectiveObservationUrgency` degrades cleanly when the hydrated monitor snapshot itself lacks `urgencyMax` (old monitor): the `URGENCY_BY_RANK[NaN] ?? lo` fallback returns the monitor's base urgency.

Verified: `libs/core/src/runtime/types.ts` — `MonitorRuntimeState` (lines 131–135); `libs/core/src/inbox/schema.ts` — `monitorState` table (lines 98–105).

## 4. Notify Dispatch

Notify dispatch converts observations returned by a source into emitted observations that should become durable events.

### 4.1 Default notify behavior

If a monitor omits `notify`: `high` urgency **MUST** default to `debounce` with `settle-for: 15s`; `normal` urgency **MUST** emit immediately (no notify config applied); `low` urgency **MUST** emit immediately.

This default is part of the runtime contract and explains why high-urgency signals are not delivered the instant a single source observation appears.

#### Effective urgency (source salience within the authored band)

A monitor's `urgency` frontmatter is an authored **band** `lo..hi` (see
[001 §3.2](./001-monitor-definition.md)); a bare scalar is the degenerate band `x..x`. A source
observation **MAY** carry an optional `salience` (see [003 §2.3](./003-source-plugins.md)) — the
source's domain judgment of how interrupt-worthy _this_ observation is (PP3 — a domain observation,
not runtime reasoning). It is named `salience`, not `urgency`, because `urgency` stays the
monitor-level policy knob.

For each observation, the runtime **MUST** resolve the **effective urgency** as:

```
effective_urgency = clamp(salience ?? band.lo, band.lo, band.hi)
```

- No `salience` → the band's low bound (the authored base / default urgency).
- `salience` inside the band → it escalates (or de-escalates) within it.
- `salience` outside the band → it is clamped to the nearest bound (above → `band.hi`, below →
  `band.lo`).

Notify dispatch **MUST** evaluate the default notify behavior against the **effective** urgency, and
event materialization ([§5.1](#51-derived-defaults)) **MUST** persist the effective urgency.

Because a degenerate band (`lo === hi`) clamps every salience back to the single authored level, a
monitor authored with a bare scalar `urgency` can **never** be escalated by a source — preserving PP5
(urgency stays user-controlled) and full backward compatibility. Escalation is therefore always an
explicit, visible authorial grant: the runtime only ever escalates within a band the author wrote.

##### Debounce interaction: escalation flushes the whole held batch early

When an **escalated** observation (its effective urgency exceeds the band's low bound) arrives while a
debounce batch is **held**, the runtime **MUST** flush the _entire_ held batch — the already-held
observations plus the escalated one — immediately, rather than waiting for the batch's `dueAt`. The
runtime **MUST NOT** split the batch (emit only the escalated observation and keep the rest held):
splitting risks ordering confusion across the durable event stream. Held-first ordering is preserved.

Verified: `libs/core/src/runtime/types.ts` — `defaultNotifyConfigForUrgency()`: returns `{ strategy: 'debounce', 'settle-for': '15s' }` for `high` urgency, `undefined` (immediate) for all other urgencies. `libs/core/src/runtime/service.ts` — `effectiveObservationUrgency()` resolves the clamp; `dispatchNotify()` evaluates notify against the effective urgency and performs the whole-batch early flush on an escalated observation.

### 4.2 Throttle semantics

For `throttle`: the first observation after any suppression window emits immediately; further observations inside the suppression window are dropped; `suppressedUntil` is updated from the emitted observation time.

Verified: `libs/core/src/runtime/service.ts` — `dispatchNotify()` throttle branch (lines 523–536).

### 4.3 Debounce semantics

For `debounce`: incoming observations are accumulated in a pending batch; each new observation resets the batch's `dueAt` time to `observedAt + settle-for`; a later runtime tick at or after that due time flushes the full pending batch. This means debounce delivery is bounded by both the configured settle interval and the daemon's tick cadence.

Verified: `libs/core/src/runtime/service.ts` — `dispatchNotify()` debounce flush path (lines 499–508) and accumulation paths (lines 540–561).

The pending debounce state uses the `PendingDebounceState` shape: `{ observations: StoredObservationEnvelope[]; dueAt: string }`.

Verified: `libs/core/src/runtime/types.ts` — `PendingDebounceState` (lines 137–140).

## 5. Event Materialization

Each emitted observation becomes one row in the `monitor_events` table. The runtime **MUST** persist at least: `id`, `workspacePath`, `monitorId`, `sourceName`, `urgency`, `title`, `body`, `summary`, `payload`, `snapshotMetadata`, `snapshotText`, `diffText`, `objectKey`, `queryScope`, `tags`, `createdAt`.

Verified: `libs/core/src/runtime/service.ts` — `processObservation()` (lines 566–617); `libs/core/src/runtime/store.ts` — `insertEvent()` (lines 260–299).

### 5.1 Derived defaults

If an emitted observation omits fields, the runtime **MUST** derive them as follows:

- `body`: observation body, otherwise monitor instructions
- `urgency`: the **effective urgency** = `clamp(observation.salience ?? band.lo, band.lo, band.hi)`
  (see [§4.1](#41-default-notify-behavior)). With no `salience`, this is the band's low bound (the
  monitor's authored base urgency). The persisted `monitor_events.urgency` is the same effective value
  notify timing used, so a held batch and its event rows agree.
- `summary`: observation summary, otherwise observation body, otherwise title
- `objectKey`: observation `objectKey`, otherwise the monitor ID
- `queryScope`: observation `queryScope`, otherwise `{}` — and if the observation sets `changeKind`
  (see [003 §2.3](./003-source-plugins.md)), the runtime adds `changeKind` to the stored
  `queryScope` so the source-agnostic lifecycle is filterable without each source duplicating it.
- `snapshotMetadata`: observation `snapshot`, otherwise `{}`

Verified: `libs/core/src/runtime/service.ts` — `processObservation()`.

### 5.2 Snapshots and diffs

If an emitted observation includes `snapshotText`, the runtime **MUST**:

1. look up the latest stored snapshot for the same `(workspacePath, monitorId, objectKey)` triple
2. compute a textual diff if a previous snapshot exists
3. store the new snapshot after persisting the event

The diff format is a line-level unified-style representation capped at 20 changed lines, produced by `buildTextDiff`. If previous and current text are identical, `buildTextDiff` returns the empty string.

Verified: `libs/core/src/runtime/service.ts` — `processObservation()` lines 566–616; `libs/core/src/runtime/diff.ts` — `buildTextDiff()` (lines 7–26, cap at 20 lines visible at line 21).

This makes snapshot history an object-level concern rather than a monitor-level or session-level concern (SP5).

## 6. Session Projection

Persisted events are not directly tied to one session. They are projected into matching sessions via `session_event_state`. When an event is inserted, the runtime **MUST** project it into matching **lead** sessions only.

Current projection rules: an event in workspace `W` projects into lead sessions whose `workspacePath` matches `W` **and** into lead sessions whose `workspacePath` is `null`, representing global visibility. Subagent sessions are tracked but do not receive automatic event projection.

Verified: `libs/core/src/runtime/store.ts` — `insertEvent()` lines 285–298: filters `sessionsForWorkspace(event.workspacePath)` with `.filter(candidate => candidate.role === 'lead')`. `sessionsForWorkspace()` (lines 418–433) returns sessions matching the workspace path **or** sessions with a `null` workspace path.

### 6.1 Session identity

Opening a session with the same `(adapter, hostSessionId)` pair resumes the existing AgentMon session record instead of creating a duplicate. Closing a session marks it dormant (`status = 'dormant'`, `dormantAt` set) but preserves all history.

Verified: `libs/core/src/runtime/store.ts` — `openSession()` (lines 102–152): checks for an existing row by `(adapter, hostSessionId)`; if found, sets `status = 'active'` and clears `dormantAt`. `closeSession()` (lines 175–188) sets `status = 'dormant'`.

## 7. Unread, Claimed, and Acknowledged

For each projected event, the runtime tracks session-specific delivery state via `session_event_state`. These concepts are distinct (SP4):

- **Unread:** `acknowledgedAt IS NULL` in `session_event_state`. The session has not acknowledged the event.
- **Claimed (pending → notified):** `firstNotifiedAt IS NOT NULL`. The event has been surfaced at least once at a delivery lifecycle. Implemented as `pendingEventsForSession()` (events where `firstNotifiedAt IS NULL` and `acknowledgedAt IS NULL`).
- **Acknowledged:** `acknowledgedAt IS NOT NULL`. The session explicitly marked the event read.

This distinction matters because a claimed event may still need user or agent attention later.

Verified: `libs/core/src/runtime/store.ts` — `unreadEventsForSession()` (lines 435–452) and `pendingEventsForSession()` (lines 454–476); `libs/core/src/inbox/schema.ts` — `sessionEventState` columns (lines 86–96).

## 8. Hook State

Each session has a hook-state JSON file on disk. The file is written atomically (write to `.tmp`, then `rename`) to prevent partial reads.

Verified: `libs/core/src/runtime/service.ts` — `writeJsonAtomic()` (lines 45–50).

The hook state **MUST** include: `sessionId`, `updatedAt` (ISO 8601 string), unread counts for `low`, `normal`, `high`, and `total`, `hasPendingHigh`, `hasPendingNormal`, `hasPendingLow`, `latestHighTitles`.

`hasPendingHigh` becomes `true` only when at least one unread high-urgency event is still unclaimed (`firstNotifiedAt IS NULL`) **and** its age is at or above the 15-second high-urgency settle window (`DEFAULT_HIGH_URGENCY_SETTLE_MS = 15_000`). This threshold deliberately mirrors the delivery condition used by `claimDelivery` at `turn-interruptible`.

`latestHighTitles` contains the titles of up to the 5 most recent unclaimed high-urgency events.

Verified: `libs/core/src/runtime/service.ts` — `refreshHookState()` (lines 426–447): settle window check at line 430–432; `highUnread.slice(-5)` at line 441. `libs/core/src/runtime/types.ts` — `SessionHookState` (lines 121–129).

## 9. Delivery Lifecycles

The runtime supports three delivery lifecycles as the `DeliveryLifecycle` union type: `turn-interruptible`, `turn-idle`, `post-compact`.

Verified: `libs/core/src/runtime/types.ts` — `DeliveryLifecycle` (lines 18–22).

`AgentLifecycleEvent` is a broader union that also includes `session-opened`, `session-dormant`, `turn-ended`, and `pre-compact`. These additional events are used by the adapter hook map but do not correspond to delivery claim points.

Verified: `libs/core/src/runtime/types.ts` — `AgentLifecycleEvent` (lines 9–16).

### 9.1 High urgency

At `turn-interruptible`, the runtime **MUST** deliver all pending high-urgency events that have aged past the 15-second settle window (`DEFAULT_HIGH_URGENCY_SETTLE_MS`). The delivery payload **MUST** summarize the concrete events (titles and summaries), not just emit a generic reminder. The `DeliveryClaim` will have `mode: 'delivery'` and include a populated `events` array.

Each element of the `events` array is a `DeliveryEventSummary` which carries: `eventId`, `monitorId`, `title`, `summary`, `urgency`, `createdAt` (ISO-8601 string), and `body`. The `body` field is the raw monitor body-instructions (`MonitorEventRecord.body`, set from `observation.body ?? monitor.instructions`). It carries what the agent should **do** when the monitor fires, so a delivery transport (e.g. hook, MCP channel) can surface the instructions, not just the title/summary.

Verified: `libs/core/src/runtime/service.ts` — `claimDelivery()` turn-interruptible high branch: `settledHigh` filters by age, payload includes `summarizeEvents(...)` and a full `events` array with `body: event.body`.

### 9.2 Normal urgency

At `turn-interruptible`, normal-urgency events are delivered as a generic inbox reminder (`NORMAL_INBOX_PROMPT = 'AgentMon messages are available. Read the inbox.'`) only if all unread normal-urgency events are still unclaimed. This coalesces multiple normal events into one reminder until the session acknowledges them. The `events` array is empty in this case.

Verified: `libs/core/src/runtime/service.ts` — lines 267–291: `normalPending.length === unreadNormal.length` guard; `NORMAL_INBOX_PROMPT` constant (line 34).

### 9.3 Low urgency

At `turn-idle`, low-urgency events are delivered as a generic reminder (`IDLE_INBOX_PROMPT = 'AgentMon has inbox updates ready for review.'`) only if all unread low-urgency events are still unclaimed. The `events` array is empty.

Verified: `libs/core/src/runtime/service.ts` — lines 295–315: `shouldSendLow` guard; `IDLE_INBOX_PROMPT` constant (line 35).

### 9.4 Recap

At `post-compact`, if unread events remain, the runtime **MUST** emit a recap payload that:

- includes a summary of up to the 10 most recent unread events (`MAX_RECAP_EVENTS = 10`, using `.slice(-10)` so the 10 newest are included)
- appends two commands: one for full session history and one for unread details
- updates `lastRecapAt` on the session record

The `DeliveryClaim` in this case has `mode: 'recap'`. The `events` array contains up to 10 `DeliveryEventSummary` entries, each including `body` (the raw monitor instructions — see §9.1 for the `DeliveryEventSummary` shape). Claiming any delivery **MUST** mark the underlying session-event rows as claimed (`firstNotifiedAt` set). Claiming **MUST NOT** acknowledge them (`acknowledgedAt` remains null) (BP2).

Verified: `libs/core/src/runtime/service.ts` — `claimDelivery()` post-compact branch; `MAX_RECAP_EVENTS = 10`; `store.markClaimed()` does not set `acknowledgedAt` (see `libs/core/src/runtime/store.ts`: only sets `firstNotifiedAt`, `lastClaimAt`, `lastClaimLifecycle`). Each mapped event includes `body: event.body`.

## 10. Daemon and IPC

The CLI exposes two operational modes for the runtime:

### 10.1 `daemon once` — single tick

`agentmonitors daemon once [monitorsDir]` creates a local `AgentMonitorRuntime` in-process and calls `runtime.tick()` once without starting a socket server. It does not go through the daemon IPC socket.

In `text` format the command prints `Evaluated N monitor(s), emitted M event(s).`. When the tick has one or more errored observations (§2.4), the trailing period is replaced by `, K errored:` followed by one indented `  <monitorId>: <message>` line per errored monitor — so a broken source is visible without any verbose flag. When `K` is zero the output is unchanged (the genuine no-change case stays clean — the command must not "cry wolf"). In `json` format the full `RuntimeTickResult`, including `erroredObservations`, is printed verbatim.

Verified: `apps/cli/src/runtime-client.ts` — `daemonTickClient()`: constructs a `createRuntime()` directly and calls `runtime.tick()`; `apps/cli/src/commands/daemon.ts` — `once` subcommand and the `appendErroredLines()` helper; `apps/cli/src/commands/cli.integration.test.ts` — `describe('daemon once error visibility (issue #117)')`.

### 10.2 `daemon run` — continuous loop + Unix socket server

`agentmonitors daemon run [monitorsDir]` runs the full daemon mode:

1. Creates a local `AgentMonitorRuntime`
2. Starts a Unix domain socket server via `createDaemonServer()`
3. Enters a `while (!stopping)` tick loop, calling `runtime.tick()` on each iteration
4. Sleeps for `--poll-ms` milliseconds (default `30000`) between ticks using a cancellable timer
5. Handles `SIGINT` and `SIGTERM` to stop cleanly
6. Refuses to start if the socket is already in use (another daemon is running)

**Tick logging:** after each tick the loop logs a line when the tick emitted events **or** had one or more errored observations (§2.4); a clean no-change tick logs nothing. The line is `Emitted M event(s) from N monitor(s).`, and when errored it becomes `Emitted M event(s) from N monitor(s), K errored:` followed by one indented `  <monitorId>: <message>` line per errored monitor — the same surfacing as `daemon once` so a broken source is never hidden behind a silent loop.

**Idle reaping:** the daemon monitors active sessions for the workspace. After each tick it counts sessions with `status === 'active'` and `workspacePath === workspacePath`. If this count stays zero continuously for `--reap-after-ms` milliseconds (default `300000`; `0` disables), the daemon stops itself cleanly. This is the primary self-termination mechanism for daemons booted by `session start`.

**Per-workspace isolation:** socket and db paths are derived from the workspace path via `workspacePaths()` in `apps/cli/src/workspace-paths.ts`, which hashes `resolve(workspacePath)` (SHA-256, first 16 hex chars) under `XDG_DATA_HOME ?? ~/.local/share/agentmonitors/workspaces/<hash>/`. Two sessions in the same repo share one daemon; two distinct repos get isolated daemons.

**Lazy boot:** `session start` spawns `daemon run` as a detached background process when no daemon is already listening at the per-workspace socket path, waits up to 8 seconds for the socket to appear, then opens the session. The spawner unref's the child, so the parent (the hook process) can exit while the daemon continues running. The coordination file `.claude/agentmonitors.local.md` holds `enabled`, `socket`, `db`, and `reap-after-ms` fields so sibling hooks can locate the per-workspace daemon without re-deriving paths.

Verified: `apps/cli/src/commands/daemon.ts` — `runLoop()`; `run` subcommand; `apps/cli/src/detached-spawn.ts` — `spawnDetachedDaemon()`; `apps/cli/src/workspace-paths.ts` — `workspacePaths()`; `apps/cli/src/local-state.ts` — `readLocalState()`/`writeLocalState()`.

### 10.3 Socket path resolution

The socket path is resolved by `resolveSocketPath()`. Priority order:

1. Caller-supplied `overridePath`
2. `AGENTMONITORS_SOCKET` environment variable
3. `<dbDir>/agentmonitors.sock` (where `<dbDir>` is the directory containing the SQLite file, or `~/.local/share/agentmonitors` for `:memory:` databases)

If the resolved path exceeds 100 characters (the Unix socket path length limit in use), the path is hashed (SHA-256, first 16 hex chars) and placed under `/tmp/agentmonitors-<hash>.sock`.

Verified: `apps/cli/src/daemon-ipc.ts` — `resolveSocketPath()` (lines 124–139); `MAX_UNIX_SOCKET_PATH_LENGTH = 100` (line 17).

### 10.4 IPC wire protocol

Each request/response is a single newline-delimited JSON object. The server reads until it finds `\n`, parses the JSON, dispatches the method, and writes `{ id, result? }` or `{ id, error }` back before closing the connection.

Verified: `apps/cli/src/daemon-ipc.ts` — server `socket.on('data', ...)` handler (lines 244–278); `respond()` writes `JSON.stringify(payload) + '\n'` (line 241).

### 10.5 Exposed socket commands

The daemon socket exposes the following commands (the `DaemonMethod` enum):

| Method            | Description                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `ping`            | Health check; returns `{ ok: true }`                                                          |
| `status`          | Returns `RuntimeStatus` (session counts, event count)                                         |
| `stop`            | Requests graceful daemon shutdown                                                             |
| `session.open`    | Opens or resumes a session; returns `AgentSessionRecord`                                      |
| `session.close`   | Marks a session dormant; returns `AgentSessionRecord`                                         |
| `session.list`    | Returns all `AgentSessionRecord[]`                                                            |
| `events.list`     | Lists events, with optional filters; returns `MonitorEventRecord[]`                           |
| `events.ack`      | Acknowledges events for a session                                                             |
| `hook.claim`      | Claims a delivery payload for a session at a lifecycle point; returns `DeliveryClaim \| null` |
| `history.list`    | Lists recent observation-history rows, optionally filtered by monitor id                      |
| `monitor.explain` | Returns a read-only staged diagnosis for one monitor's current pipeline state                 |
| `daemon.tick`     | Runs one tick on the specified monitors directory                                             |

Verified: `apps/cli/src/daemon-ipc.ts` — `daemonMethodSchema` (lines 26–37); `handleRequest()` (lines 150–222).

### 10.6 CLI commands that round-trip through the socket

The `session`, `events`, and `hook` CLI subcommands call the daemon socket via the `runtime-client.ts` helpers rather than constructing a local runtime:

- `agentmonitors session open/close/list` → `session.open` / `session.close` / `session.list`
- `agentmonitors events list` / `events.ack` → `events.list` / `events.ack`
- `agentmonitors hook claim` → `hook.claim`
- `agentmonitors monitor history` → `history.list`
- `agentmonitors monitor explain` → `monitor.explain`

Verified: `apps/cli/src/runtime-client.ts` — `openSessionClient`, `closeSessionClient`, `listSessionsClient`, `listEventsClient`, `acknowledgeEventsClient`, `claimDeliveryClient` (lines 14–82); `apps/cli/src/commands/session.ts`, `hook.ts`.

### 10.7 Monitor pipeline diagnosis

`monitor.explain` is a read-only daemon IPC method used by
`agentmonitors monitor explain <monitorId>` ([005 §6](./005-cli-reference.md)). It walks one
monitor through the persisted pipeline state and returns stages for:

1. Definition: scanned `MONITOR.md`, source resolution, and source scope validation
2. Scheduling: persisted `monitor_state.last_observation_at`, due state, and next due time
3. Observation: recent `observation_history` rows and latest outcome
4. Notify state: active debounce or throttle state in `monitor_state.notify_state`
5. Materialization: recent `monitor_events`
6. Projection and delivery: `session_event_state` joined to `agent_sessions`, reported as
   `unread`, `claimed`, or `acknowledged`

Each stage carries a `status` of `ok`, `pending`, `healthy`, or `failure`:

- `ok` — the stage produced the signal the next stage needs.
- `pending` — the stage is intentionally holding (debounce/throttle) or has not run because an
  upstream stage has not produced its input.
- `healthy` — the stage ran successfully and the correct outcome was "no work to do": the watched
  target genuinely did not change. A `no-change` or `rebaselined` observation outcome is `healthy`,
  **not** a `failure` — an idle monitor is not a bug. When the latest observation is `healthy`, the
  downstream materialization and delivery stages report `healthy` rather than `failure` for the
  expected absence of events/projections. The verdict for a genuinely idle monitor is therefore an
  affirmative `healthy` at the observation stage (e.g. "Source ran, observed 0 changes — your watched
  target genuinely hasn't changed (not a bug).").
- `failure` — a real fault: invalid definition, errored observe, missing expected projection, or an
  unreachable daemon.

The method MUST NOT mutate runtime state. **It MUST scope to the requested workspace.** The inbox DB
is global (not per-workspace), so the same `monitorId` can exist in multiple workspaces; the
materialization stage filters `monitor_events` to `workspacePath` (plus workspace-agnostic events)
and the delivery stage filters projections to that workspace's sessions (plus global sessions), so
one workspace's report never counts another workspace's events or projections. If events exist but
there is no lead session matching the workspace (including global sessions), the delivery stage
reports that no lead session is registered. If the daemon socket is unavailable, the CLI fallback may
still validate the local definition and then report scheduling as failed because the daemon is not
running. The fallback fires **only** for a genuine connection failure (socket refused/absent or
request timeout); a daemon-side application error is surfaced verbatim rather than masked as "daemon
not running".

## 11. Agent Integration (Adapters)

### 11.1 The `AgentRuntimeAdapter` contract

Every agent integration is defined as an `AgentRuntimeAdapter` object with four members:

- `name: string` — unique identifier for the adapter
- `hookEventMap: Record<AgentLifecycleEvent, string>` — maps each `AgentLifecycleEvent` to the string hook name used by the target agent runtime
- `defaultHookStatePath(input): string` — computes the default path for the hook-state file
- `createSessionInput(input): OpenSessionInput` — builds the `OpenSessionInput` to pass to `runtime.openSession()`
- `materializeHookState(state): Record<string, unknown>` — serializes `SessionHookState` to a JSON-serializable object for writing to disk

Verified: `libs/core/src/adapter/types.ts` — `AgentRuntimeAdapter` interface (lines 7–22).

### 11.2 The `claudeCodeAdapter`

The only built-in adapter is `claudeCodeAdapter` (name: `'claude-code'`). It is registered by default in `AgentMonitorRuntime` and is the adapter used by all CLI commands.

The `hookEventMap` maps delivery and session lifecycle events to Claude Code hook names:

| `AgentLifecycleEvent` | Claude Code hook name |
| --------------------- | --------------------- |
| `session-opened`      | `SessionStart`        |
| `session-dormant`     | `SessionEnd`          |
| `turn-interruptible`  | `PreToolUse`          |
| `turn-ended`          | `Stop`                |
| `turn-idle`           | `TeammateIdle`        |
| `pre-compact`         | `PreCompact`          |
| `post-compact`        | `PostCompact`         |

Verified: `libs/core/src/adapter/claude.ts` — `claudeCodeAdapter.hookEventMap` (lines 31–39).

The delivery lifecycles (`turn-interruptible` → `PreToolUse`, `turn-idle` → `TeammateIdle`, `post-compact` → `PostCompact`) are the events at which Claude Code will invoke the corresponding hooks, causing the CLI to call `hook.claim`.

### 11.3 Hook-state path derivation

The default hook-state path is derived by `defaultHookStatePath()`:

```text
<workspace-or-cwd>/.agentmonitors/sessions/<encoded-host-session-id>/hook-state.json
```

`<workspace-or-cwd>` is `input.workspacePath` if provided, otherwise `process.cwd()`.

`<encoded-host-session-id>` is the `hostSessionId` with each character that is not in `[A-Za-z0-9_-]` replaced by `~<hex-codepoint>` (zero-padded to 2 digits). The strings `.` and `..` are additionally escaped to prevent path traversal. An empty encoded result becomes `_empty`.

Verified: `libs/core/src/adapter/claude.ts` — `safeSessionPathSegment()` (lines 4–27); `defaultHookStatePath()` (lines 40–49).

### 11.4 Hook-state materialization

`materializeHookState()` passes through all `SessionHookState` fields unchanged. The on-disk JSON object therefore contains: `sessionId`, `updatedAt`, `unread` (with `low`, `normal`, `high`, `total`), `hasPendingHigh`, `hasPendingNormal`, `hasPendingLow`, `latestHighTitles`.

Verified: `libs/core/src/adapter/claude.ts` — `materializeHookState()` (lines 71–81).

## 12. Relationship to the Legacy Inbox Model

The repository still implements an inbox item state machine:

```text
queued → acked → in-progress → completed|failed → archived
```

That model remains useful and publicly exposed through `agentmonitors inbox ...` commands, but it is **not** the authoritative runtime delivery path (AP2). The important split is: runtime/session delivery uses `monitor_events` and `session_event_state`; inbox lifecycle commands operate on `inbox_items`. The system therefore has two durable work models in the repo today. This spec is explicit that the runtime/session pipeline is primary for monitor-triggered delivery.

Verified: `libs/core/src/inbox/inbox-service.ts` — `VALID_TRANSITIONS` (lines 37–44); `libs/core/src/inbox/schema.ts` — `inboxItems` table (lines 16–31).

Note: the `inbox_items` table does not share rows with `monitor_events`. They are independent storage paths. The `inbox_items` table has its own `state` column driving the lifecycle machine, whereas `monitor_events` rows are immutable once written; delivery state lives in `session_event_state`.

## 13. Example Flows

### 13.1 Debounced high-urgency burst

1. a high-urgency monitor emits two observations on a tick
2. notify dispatch stores them in pending debounce state (`notifyState.pendingDebounce`); no `monitor_events` rows are created yet
3. a later tick arrives at or after `dueAt` (15s later); the flush path emits the accumulated batch
4. two events are persisted and projected into matching lead sessions via `session_event_state`
5. after the settle window has elapsed, `turn-interruptible` claims them as a concrete high-urgency delivery with a populated `events` array

**What this example proves:** high urgency is not necessarily immediate; debounce acts before event persistence; delivery timing and unread state are separate concerns; the 15-second settle window appears at two places — the default `notify` config for high urgency, and the `claimDelivery` age filter.

### 13.2 Low-urgency background reminder

1. a low-urgency event is persisted and projected into a session
2. `turn-interruptible` returns `null` (low urgency is not delivered here)
3. `turn-idle` evaluates `shouldSendLow`: `pendingEventsForSession(sessionId, 'low').length > 0` and all low-urgency unread events are still unclaimed → returns a `DeliveryClaim` with `message: IDLE_INBOX_PROMPT`
4. the event remains unread until explicitly acknowledged

**What this example proves:** `low` urgency is real runtime behavior, not schema-only metadata; idle-time delivery differs intentionally from interruptible delivery.

## 14. Validation Implications

Runtime and persistence tests should be able to prove:

- stateful source state survives runtime restarts (persisted via `monitor_state.source_state`)
- schedule matching respects configured timezone via `Intl.DateTimeFormat`
- high-urgency delivery waits for the 15-second settle window before `claimDelivery` returns a payload
- normal reminders coalesce until unread events are acknowledged (guard: `normalPending.length === unreadNormal.length`)
- low-urgency delivery happens only at `turn-idle` lifecycle points
- events project only into matching lead sessions (role filter in `insertEvent`)
- scope filters query `queryScope` rather than source payload internals (post-query filter in `listEvents`)
- snapshot diffs are keyed by `(workspacePath, monitorId, objectKey)`
- claimed events remain unread until acknowledged (`markClaimed` does not set `acknowledgedAt`)
- `daemon once` does not start a socket server; `daemon run` refuses to start if the socket is already in use

## 15. Persistence Schema (Appendix)

This section is normative. Column names use the SQLite snake_case form as defined in `libs/core/src/inbox/schema.ts`. All IDs are ULIDs. All timestamps are SQLite `INTEGER` columns stored as Unix epoch seconds (via Drizzle's `{ mode: 'timestamp' }`).

Verified: `libs/core/src/inbox/schema.ts` (entire file); `libs/core/src/inbox/db.ts` (DDL, lines 50–156).

### `monitor_events`

Corresponds to the `monitorEvents` Drizzle table. One row per materialized observation. Rows are immutable after insertion.

| Column              | Type             | Notes                                           |
| ------------------- | ---------------- | ----------------------------------------------- |
| `id`                | TEXT PK          | ULID                                            |
| `workspace_path`    | TEXT nullable    | Path to the workspace; `NULL` for global events |
| `monitor_id`        | TEXT NOT NULL    | Stable monitor identifier                       |
| `source_name`       | TEXT NOT NULL    | Source plugin name                              |
| `urgency`           | TEXT NOT NULL    | `low \| normal \| high`                         |
| `title`             | TEXT NOT NULL    |                                                 |
| `body`              | TEXT NOT NULL    | Defaults to `''`                                |
| `summary`           | TEXT NOT NULL    | Defaults to `''`                                |
| `payload`           | TEXT NOT NULL    | JSON; defaults to `{}`                          |
| `snapshot_metadata` | TEXT NOT NULL    | JSON; defaults to `{}`                          |
| `snapshot_text`     | TEXT nullable    | Full snapshot content if provided               |
| `diff_text`         | TEXT nullable    | Line-level diff vs. previous snapshot           |
| `object_key`        | TEXT nullable    | Snapshot and diff keying                        |
| `query_scope`       | TEXT NOT NULL    | JSON; defaults to `{}`                          |
| `tags`              | TEXT NOT NULL    | JSON array; defaults to `[]`                    |
| `created_at`        | INTEGER NOT NULL | Observation timestamp                           |

### `monitor_snapshots`

Stores the full text content of each snapshot for diff computation. Keyed by `(workspace_path, monitor_id, object_key)`.

| Column           | Type             | Notes                     |
| ---------------- | ---------------- | ------------------------- |
| `id`             | TEXT PK          | ULID                      |
| `workspace_path` | TEXT nullable    |                           |
| `monitor_id`     | TEXT NOT NULL    |                           |
| `object_key`     | TEXT NOT NULL    |                           |
| `event_id`       | TEXT NOT NULL    | FK to `monitor_events.id` |
| `content`        | TEXT NOT NULL    | Full snapshot text        |
| `created_at`     | INTEGER NOT NULL |                           |

The draft omitted this table. It is required for snapshot diff computation (§5.2) and is populated by `RuntimeStore.saveSnapshot()`. Verified: `libs/core/src/runtime/store.ts` — `saveSnapshot()` (lines 375–394); `latestSnapshot()` (lines 396–416).

### `session_event_state`

Per-session delivery tracking for each projected event. Drives the unread/claimed/acknowledged state machine (§7).

| Column                 | Type             | Notes                                             |
| ---------------------- | ---------------- | ------------------------------------------------- |
| `id`                   | TEXT PK          | ULID                                              |
| `session_id`           | TEXT NOT NULL    | FK to `agent_sessions.id`                         |
| `event_id`             | TEXT NOT NULL    | FK to `monitor_events.id`                         |
| `first_notified_at`    | INTEGER nullable | Set when event is first claimed; `NULL` = pending |
| `acknowledged_at`      | INTEGER nullable | Set by explicit ack; `NULL` = unread              |
| `last_claim_at`        | INTEGER nullable | Time of most recent claim                         |
| `last_claim_lifecycle` | TEXT nullable    | Lifecycle at most recent claim                    |
| `created_at`           | INTEGER NOT NULL |                                                   |
| `updated_at`           | INTEGER NOT NULL |                                                   |

### `agent_sessions`

One row per known agent session. Upserted on open (via `hostSessionId` + `adapter` uniqueness).

| Column            | Type             | Notes                                                |
| ----------------- | ---------------- | ---------------------------------------------------- |
| `id`              | TEXT PK          | ULID                                                 |
| `adapter`         | TEXT NOT NULL    | e.g. `claude-code`                                   |
| `host_session_id` | TEXT NOT NULL    | Session ID from the integrating runtime              |
| `agent_identity`  | TEXT NOT NULL    | Human-readable agent identifier                      |
| `role`            | TEXT NOT NULL    | `lead \| subagent`; default `lead`                   |
| `workspace_path`  | TEXT nullable    | `NULL` = global session                              |
| `hook_state_path` | TEXT NOT NULL    | Absolute path to the hook-state JSON file            |
| `status`          | TEXT NOT NULL    | `active \| dormant`                                  |
| `baseline_at`     | INTEGER NOT NULL | Session open time; used for event baseline filtering |
| `last_active_at`  | INTEGER NOT NULL | Updated on each `touchSession()`                     |
| `last_recap_at`   | INTEGER nullable | Set by `updateSessionRecap()`                        |
| `dormant_at`      | INTEGER nullable | Set when session is closed                           |
| `created_at`      | INTEGER NOT NULL |                                                      |
| `updated_at`      | INTEGER NOT NULL |                                                      |

### `monitor_state`

Stores the per-monitor polling and notification state. One row per monitor ID.

| Column                | Type             | Notes                                          |
| --------------------- | ---------------- | ---------------------------------------------- |
| `monitor_id`          | TEXT PK          |                                                |
| `last_observation_at` | INTEGER nullable | Used for due-interval computation              |
| `last_fingerprint`    | TEXT nullable    | Reserved; not currently written by the runtime |
| `source_state`        | TEXT NOT NULL    | JSON; owned by the source plugin               |
| `notify_state`        | TEXT NOT NULL    | JSON; `NotifyRuntimeState` shape               |
| `updated_at`          | INTEGER NOT NULL |                                                |

### `observation_history`

An audit trail of each due monitor's outcome per tick. For every evaluated monitor the runtime writes a row with `monitorId`, `sourceName`, `observationData`, and `result`. The `result` values are:

- `triggered` — ≥1 event was emitted (including a tick that flushes a previously-held debounce batch even when it returned no new observations). `observationData` is `{ observed, emitted }`.
- `suppressed` — observations were returned but none emitted this tick (throttled or held in a debounce batch). `observationData` is `{ observed, emitted }`.
- `no-change` — the source returned no observations and signalled no special outcome. `observationData` is `{ observed: 0, emitted: 0 }`.
- `errored` — a failure occurred and was **isolated** so the tick (or watcher) continued. Two sub-cases:
  - `observe()` threw or rejected in the tick loop: `ingest()` was never called, so the monitor's persisted `sourceState` is left exactly as it was and no subsequent delta is dropped.
  - A single dispatched observation failed to materialize inside `ingest()` (tick or watch path, e.g. a DB insert error): the batch's other observations are unaffected and `emittedEventIds` reflects only what was durably written. Note: `insertEvent` and `saveSnapshot` are two separate writes; a `saveSnapshot` failure after a successful `insertEvent` is best-effort — the event row exists but has no snapshot (see TODO in `service.ts processObservation`).

  In both cases `observationData` is `{ error: "<message>" }`. The audit write itself is best-effort: a `recordObservationHistory` failure is swallowed so a failing audit row can never re-abort the tick.

- `rebaselined` — the source advanced its persisted baseline to the current point but could not compute a delta (e.g. a force-pushed or gc'd prior ref). The source returned zero observations and set `ObservationResult.outcome: 'rebaselined'`; the runtime maps this to `rebaselined` rather than `no-change`. The runtime enforces the zero-observation invariant: `rebaselined` is recorded **only** when the tick emitted nothing **and** returned zero observations — if a source sets the diagnostic while also returning observations (which are then held/suppressed), the tick is recorded as `suppressed`, not `rebaselined`. This outcome is distinct from `no-change` (genuinely nothing changed) and from `errored` (the source threw). `observationData` is `{ observed: 0, emitted: 0 }`.

_current_. Per-monitor isolation and the `errored` outcome are guaranteed by the runtime for both the tick loop and the watch path (issue #46). The `rebaselined` outcome is supported via the optional `ObservationResult.outcome` diagnostic field (issue #56). Verified: `RuntimeStore.recordObservationHistory` / `listObservationHistory`, written from `service.ts` `tick()` (observe-error and ingest-error catches), `ingest()` per-observation materialization catch, `ingest()` `sourceOutcome` classification, and `consumeWatch()` inner catch. Read via `agentmonitors monitor history` ([005 §6](./005-cli-reference.md)).

| Column             | Type             | Notes                                                            |
| ------------------ | ---------------- | ---------------------------------------------------------------- |
| `id`               | TEXT PK          | ULID                                                             |
| `monitor_id`       | TEXT NOT NULL    |                                                                  |
| `source_name`      | TEXT NOT NULL    |                                                                  |
| `observation_data` | TEXT NOT NULL    | JSON                                                             |
| `result`           | TEXT NOT NULL    | `triggered \| suppressed \| no-change \| errored \| rebaselined` |
| `created_at`       | INTEGER NOT NULL |                                                                  |

Verified: `libs/core/src/inbox/schema.ts` lines 104–113; `libs/core/src/inbox/db.ts` lines 98–107; `libs/core/src/runtime/service.ts` `tick()` catch blocks, `ingest()` per-observation catch, `ingest()` result classification, and `consumeWatch()` inner catch block.

### `inbox_items`

Legacy inbox table. Driven by `InboxService`, not by the runtime tick loop (§12).

| Column         | Type             | Notes                                                               |
| -------------- | ---------------- | ------------------------------------------------------------------- |
| `id`           | TEXT PK          | ULID                                                                |
| `session_id`   | TEXT nullable    |                                                                     |
| `monitor_id`   | TEXT NOT NULL    |                                                                     |
| `state`        | TEXT NOT NULL    | `queued \| acked \| in-progress \| completed \| failed \| archived` |
| `urgency`      | TEXT NOT NULL    | `low \| normal \| high`                                             |
| `title`        | TEXT NOT NULL    |                                                                     |
| `body`         | TEXT NOT NULL    |                                                                     |
| `snapshot`     | TEXT NOT NULL    | JSON                                                                |
| `tags`         | TEXT NOT NULL    | JSON array                                                          |
| `created_at`   | INTEGER NOT NULL |                                                                     |
| `updated_at`   | INTEGER NOT NULL |                                                                     |
| `acked_at`     | INTEGER nullable |                                                                     |
| `completed_at` | INTEGER nullable |                                                                     |

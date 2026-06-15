# 005 — CLI Reference

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [003-source-plugins.md](./003-source-plugins.md)
> **Covers:** the `agentmonitors` command surface — purpose, arguments, flags, output shape, and current-vs-target status of every command

---

## §1 Overview

The binary is named **`agentmonitors`** and is described as _"Durable observation and inbox delivery for AI agents"_ (version `0.0.0` in the current codebase).

Per AP6, all public CLI behaviour must be derivable from core contracts. The CLI wraps `@agentmonitors/core` and four bundled source packages (`@agentmonitors/source-file-fingerprint`, `@agentmonitors/source-api-poll`, `@agentmonitors/source-schedule`, `@agentmonitors/source-incoming-changes`).

### In-process vs. socket commands

Commands divide into two transport modes:

| Mode                                   | Commands                                                                                                                                                       | Mechanism                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **In-process** (no socket)             | `init`, `validate`, `scan`, `monitor test`, `source list`, `schema generate`, `inbox *`, `daemon once`                                                         | Operates directly on the filesystem and/or SQLite database. No daemon socket required.         |
| **Daemon socket** (Unix domain socket) | `daemon run`, `daemon status`, `daemon stop`, `session open/close/list`, `events list/ack`, `hook claim`, `hook deliver`, `monitor history`, `monitor explain` | Sends JSON-RPC-style messages over a Unix domain socket via `callDaemon()` in `daemon-ipc.ts`. |

**`daemon once` is notable:** although it lives under the `daemon` command group, its implementation in `runtime-client.ts` (`daemonTickClient`) calls `createRuntime()` and `runtime.tick()` directly without using the socket. It is a single-tick in-process run, not a socket call. This is consistent with [002-runtime-delivery.md](./002-runtime-delivery.md).

**`monitor history` and `monitor explain` are socket-first but degrade gracefully:** both round-trip the daemon socket when one is reachable, but on a genuine connection failure they fall back to reading the persisted SQLite store **in-process** (via `daemonStatus`-style `createRuntime()` calls — `listObservationHistoryInProcess` / `explainMonitorInProcess` in `runtime-client.ts`). This keeps read-only diagnosis working after `daemon once` with no daemon running (#150). See their sections in §6 for the banner and remediation semantics.

### Socket path resolution

The daemon socket path is resolved in this priority order (implemented in `daemon-ipc.ts`):

1. `--socket <path>` CLI flag (where present)
2. `AGENTMONITORS_SOCKET` environment variable
3. `<dbDir>/agentmonitors.sock` (defaults to `~/.local/share/agentmonitors/agentmonitors.sock`)

If the resolved path exceeds 100 characters (Unix socket limit), it falls back to `/tmp/agentmonitors-<sha256-prefix>.sock`.

### Database path resolution

The SQLite inbox database is resolved in this priority order (implemented in `db-path.ts`):

1. `AGENTMONITORS_DB` environment variable
2. Default: `~/.local/share/agentmonitors/inbox.db`

> Note: no `--db` flag is exposed at the top-level program; `resolveDbPath()` accepts an optional override argument but it is not wired to a commander option in the current codebase.

---

## §2 `init` — Scaffold a monitor

**Source:** `apps/cli/src/commands/init.ts`
**Status:** Fully implemented

### Purpose

Creates a new monitor directory under a base directory and writes a template `MONITOR.md` file for the chosen observation source.

### Usage

```
agentmonitors init <name> [options]
```

| Argument / Flag     | Type                  | Default            | Description                                                                        |
| ------------------- | --------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `<name>`            | positional (required) | —                  | Monitor name, becomes the subdirectory name                                        |
| `--dir <dir>`       | option                | `.claude/monitors` | Base directory for monitors                                                        |
| `--source <source>` | option (choices)      | `file-fingerprint` | Observation source: `file-fingerprint`, `api-poll`, `schedule`, `incoming-changes` |

### Output

Human-readable only (no `--format` flag).

- **Success:** prints `Created monitor: <dir>/<name>/MONITOR.md` followed by a hint to run `agentmonitors validate <dir>`.
- **Failure:** prints to stderr `Monitor already exists: <dir>/<name>/MONITOR.md`; exits with code 1.

### Templates

Each source produces a distinct starter frontmatter block:

| Source             | Key config fields in template                                                |
| ------------------ | ---------------------------------------------------------------------------- |
| `file-fingerprint` | `globs: ['**/*.ts']`                                                         |
| `api-poll`         | `url`, `method: GET`, `interval: 5m`, `change-detection.strategy: json-diff` |
| `schedule`         | `cron: '0 9 * * 1-5'`, `timezone: UTC`                                       |
| `incoming-changes` | `paths: ['docs/specs/**']`, `branch: main`                                   |

---

## §3 `validate` — Validate monitor files

**Source:** `apps/cli/src/commands/validate.ts`
**Status:** Fully implemented — validates each monitor's watch config (the `watch` block minus `type`) against the source's full JSON Schema (via the core `validateScope` helper). See [004-validation-testing.md](./004-validation-testing.md) §2.2.

### Purpose

Validates all `MONITOR.md` files found in a directory: checks that each monitor references a known source and that the source config inside `watch:` is fully valid against the source's `scopeSchema` (types, enums, `required`, `items`, …), and that monitor IDs are unique within the tree.

### Usage

```
agentmonitors validate [path] [options]
```

| Argument / Flag     | Type                  | Default            | Description                   |
| ------------------- | --------------------- | ------------------ | ----------------------------- |
| `[path]`            | positional (optional) | `.claude/monitors` | Path to monitors directory    |
| `--format <format>` | option (choices)      | `text`             | Output format: `text`, `json` |

### Output

**Text format:**

```
Valid monitors: <n>
  <id>: <name>
...

Invalid monitors: <n>
  <filePath>: <error message>
...
```

If no monitors are found: prints `No monitors found.`

**JSON format (`--format json`):**

```json
{
  "valid": <number>,
  "invalid": <number>,
  "monitors": [
    { "id": "<string>", "name": "<string>", "source": "<string>" }
  ],
  "errors": [
    { "filePath": "<string>", "error": "<string>" }
  ]
}
```

### Validation logic (current)

1. Parses all `MONITOR.md` files via `scanMonitors()` from `@agentmonitors/core` (parse errors are included in `errors`).
2. Checks each monitor's `watch.type` field against the built-in `SourceRegistry`; unknown sources produce an error listing available sources.
3. Validates each monitor's `watch` config (minus `type`) against the source's full `scopeSchema` (draft-07) via the exported core `validateScope` helper — types, enums, `required`, `items`, and other keywords, not just field presence.
4. Rejects duplicate monitor IDs within the scanned tree (see [001 §4](./001-monitor-definition.md)).
5. If a parse failure appears to use the pre-migration top-level `source:` + `scope:` shape, appends a hint to rewrite it as `watch: { type, ... }`.

### Exit codes

Exits with code 1 if any monitor is invalid. Exits 0 if all monitors pass (or if no monitors are found).

---

## §4 `scan` — Discover and summarise monitors

**Source:** `apps/cli/src/commands/scan.ts`
**Status:** Fully implemented

### Purpose

Finds and lists all `MONITOR.md` files in a directory without performing validation.

### Usage

```
agentmonitors scan [dir] [options]
```

| Argument / Flag     | Type                  | Default            | Description                   |
| ------------------- | --------------------- | ------------------ | ----------------------------- |
| `[dir]`             | positional (optional) | `.claude/monitors` | Directory to scan             |
| `--format <format>` | option (choices)      | `text`             | Output format: `text`, `json` |

### Output

**Text format:** a columnar table with headers `ID`, `Name`, `Source`, `Urgency` (column widths 30, 40, 20, open). If parse errors occurred, appends `<n> file(s) failed to parse.`

If no monitors and no errors: prints `No monitors found.`

**JSON format (`--format json`):**

```json
{
  "monitors": [
    {
      "id": "<string>",
      "name": "<string>",
      "source": "<string>",
      "urgency": "<string>",
      "tags": ["<string>"],
      "notify": "<string | null>"
    }
  ],
  "errors": [{ "filePath": "<string>", "error": "<string>" }]
}
```

Note: `tags` defaults to `[]` when absent; `notify` defaults to `null` when absent.

### Exit codes

Always exits 0 (parse errors are reported informatively, not as failures).

---

## §5 `inbox` — Manage inbox items

**Source:** `apps/cli/src/commands/inbox.ts`
**Status:** Fully implemented

### Purpose

Query and transition inbox items in the local SQLite database. All subcommands operate in-process (no daemon socket required).

### §5.1 `inbox list`

```
agentmonitors inbox list [options]
```

| Flag                  | Type     | Default | Description                                                                 |
| --------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `--state <state>`     | choices  | —       | Filter: `queued`, `acked`, `in-progress`, `completed`, `failed`, `archived` |
| `--urgency <urgency>` | choices  | —       | Filter: `low`, `normal`, `high`                                             |
| `--tags <tags>`       | string   | —       | Comma-separated tag filter                                                  |
| `--monitor <id>`      | string   | —       | Filter by monitor ID                                                        |
| `--since <date>`      | ISO 8601 | —       | Items created after this date                                               |
| `--until <date>`      | ISO 8601 | —       | Items created before this date                                              |
| `--format <format>`   | choices  | `text`  | `text`, `json`                                                              |

**Text output:** one line per item: `[<state>] <id>  <title>  (<urgency>)`

**JSON output:** raw `InboxItem[]` array serialised via `JSON.stringify`.

**Validation:** `--since` and `--until` are validated with `new Date()`; invalid dates call `reportError` and return without querying.

### §5.2 `inbox ack`

```
agentmonitors inbox ack <id>
```

Transitions item from `queued` → `acked`. Prints `Acknowledged: <id>` on success. On error prints to stderr and exits 1.

### §5.3 `inbox start`

```
agentmonitors inbox start <id>
```

Transitions item to `in-progress`. Prints `Started: <id>` on success.

### §5.4 `inbox complete`

```
agentmonitors inbox complete <id>
```

Transitions item to `completed`. Prints `Completed: <id>` on success.

### §5.5 `inbox fail`

```
agentmonitors inbox fail <id> [--error <message>]
```

| Flag                | Type   | Default | Description                               |
| ------------------- | ------ | ------- | ----------------------------------------- |
| `--error <message>` | string | —       | Optional error message stored on the item |

Transitions item to `failed`. Prints `Failed: <id>` on success.

### §5.6 `inbox archive`

```
agentmonitors inbox archive <id>
```

Transitions a `completed` or `failed` item to `archived`. Prints `Archived: <id>` on success.

### Exit codes for inbox transitions

All transition subcommands (`ack`, `start`, `complete`, `fail`, `archive`) print to stderr and set exit code 1 when the transition fails (e.g., invalid state machine transition or item not found).

---

## §6 `monitor test` — Dry-run an observation source

**Source:** `apps/cli/src/commands/monitor-test.ts`
**Status:** Fully implemented

### Purpose

Reads a single `MONITOR.md` file, resolves its source, and runs a live observation cycle to verify configuration without writing to the database. For stateful sources (`source.stateful === true`), automatically runs a second observation after 100 ms to demonstrate change detection.

### Usage

```
agentmonitors monitor test <path> [options]
```

| Argument / Flag     | Type                  | Default | Description                        |
| ------------------- | --------------------- | ------- | ---------------------------------- |
| `<path>`            | positional (required) | —       | Path to a single `MONITOR.md` file |
| `--format <format>` | choices               | `text`  | Output format: `text`, `json`      |

### Output

**Text format:**

- Prints `Testing monitor "<name>" (source: <sourceName>)...`
- For stateful sources with no first-run observations: prints baseline message, runs second observation, then either prints observations or explains no changes were detected.
- Prints observation titles and snapshots.

**JSON format (`--format json`):**

```json
{
  "monitor": "<name>",
  "source": "<sourceName>",
  "baseline": <boolean>,
  "observations": [
    { "title": "<string>", "snapshot": <any> }
  ]
}
```

`baseline: true` indicates the JSON result is from the second (post-baseline) observation.

**Error output:** Uses `reportError()` — JSON `{ "error": "<message>" }` to stdout when `--format json`; `Error: <message>` to stderr otherwise. Exits 1.

### Exit codes

Exits 1 on: file not found, parse error, unknown source, observation exception. Exits 0 on successful dry-run (even with zero observations).

### `monitor history` — Observation audit trail

**Status:** Fully implemented (socket with a no-daemon in-process DB fallback).

Lists the per-tick outcomes the runtime records for each due monitor
([002 §"Persistence Schema"](./002-runtime-delivery.md)) — useful for answering "why didn't my
monitor fire?". Round-trips through the daemon socket (`history.list`) when a daemon is reachable.

**No-daemon fallback (#150):** observation history is read-only durable state, so if the daemon is
unreachable (a genuine connection failure — socket refused/absent or request timeout) the command
reads the persisted SQLite store **in-process** instead of erroring. When it returns rows, text
output is prefixed with the banner _"No daemon running — showing persisted state from the last
tick."_ (the `--format json` array is unchanged). When the daemon is down **and** there are no
persisted rows, it prints an actionable remediation line — _"No daemon running and no persisted
state to show. Start it with `agentmonitors daemon run`, or use `agentmonitors monitor test <path>`
for a one-shot check."_ — and exits 1, rather than a raw Node `connect ENOENT …`. A daemon-side
**application** error (the daemon answered with an error) is still surfaced verbatim as
`History failed: <message>`, never masked as "daemon not running" (the #94/#98 distinction holds).

```
agentmonitors monitor history [monitorId] [--socket <path>] [--limit <n>] [--format <text|json>]
```

| Argument / Flag | Default | Description                         |
| --------------- | ------- | ----------------------------------- |
| `[monitorId]`   | —       | Filter to a single monitor id       |
| `--limit <n>`   | `50`    | Maximum rows (newest first)         |
| `--format`      | `text`  | `text` (one row per line) or `json` |

Each row reports `result` — `triggered` (≥1 observation became an event), `suppressed` (observations
returned but none emitted this tick), `no-change` (the source returned nothing), `errored` (the
source's `observe()` or its `ingest()` threw; the failure was isolated so other monitors still ran — see
[002 §`observation_history`](./002-runtime-delivery.md)), or `rebaselined` (the source advanced its
baseline without computing a delta, e.g. after a force-pushed/gc'd ref; distinct from `no-change`) —
plus the monitor id, source name, and timestamp.

### `monitor explain` — Pipeline diagnosis

**Status:** Fully implemented (socket with a no-daemon in-process DB fallback).

Diagnoses where a single monitor's signal currently stops. The command asks the daemon for a
read-only staged report (`monitor.explain`) built from the monitor definition, scheduling state,
recent `observation_history`, `monitor_state.notify_state`, `monitor_events`, and
`session_event_state` projection rows.

```
agentmonitors monitor explain <monitorId> [--dir <path>] [--workspace <path>] [--socket <path>] [--history-limit <n>] [--event-limit <n>] [--format <text|json>]
```

| Argument / Flag       | Default             | Description                                    |
| --------------------- | ------------------- | ---------------------------------------------- |
| `<monitorId>`         | —                   | Monitor id to diagnose                         |
| `--dir <path>`        | `.claude/monitors`  | Directory containing monitor definitions       |
| `--workspace <path>`  | current working dir | Workspace path used for session projection     |
| `--socket <path>`     | resolved default    | Unix domain socket path for the daemon         |
| `--history-limit <n>` | `10`                | Observation history rows included in JSON      |
| `--event-limit <n>`   | `10`                | Materialized event rows included in JSON       |
| `--format`            | `text`              | `text` (stage summary) or `json` (full report) |

Text output prints one line per stage with a status glyph, followed by a verdict:

- `✓` — `ok` (stage produced its signal)
- `○` — `healthy` (the stage ran and the correct outcome was "nothing to do" — e.g. the watched
  target genuinely hasn't changed; an idle monitor is not a bug)
- `⏳` — `pending` (intentionally holding, e.g. debounce/throttle, or upstream hasn't produced input)
- `✗` — `failure` (a real fault: invalid definition, errored observe, missing projection, daemon
  down)

A genuinely idle monitor therefore renders `○` at the observation stage with an affirmative verdict
(e.g. "Source ran, observed 0 changes — your watched target genuinely hasn't changed (not a bug)."),
never `✗`. JSON output returns:

```json
{
  "monitorId": "<id>",
  "generatedAt": "<iso timestamp>",
  "monitor": {
    "id": "<id>",
    "displayName": "<name>",
    "filePath": "<path>",
    "sourceName": "<source>",
    "urgency": "low|normal|high"
  },
  "stages": [
    {
      "id": "definition|scheduling|observation|notify|materialization|delivery",
      "label": "<display label>",
      "status": "ok|pending|healthy|failure",
      "reason": "<one-line reason>",
      "details": {}
    }
  ],
  "verdict": {
    "status": "ok|pending|healthy|failure",
    "stage": "definition|scheduling|observation|notify|materialization|delivery",
    "reason": "<one-line reason>"
  },
  "observations": [],
  "events": [],
  "projections": [],
  "leadSessions": []
}
```

**Verdict severity ranking**: the verdict reflects the _highest-severity_ stage, not the first
non-`ok` stage. The severity order is `failure` > `pending` > `healthy` > `ok`. A `healthy` or
`ok` observation stage never masks a downstream `failure` or `pending` (#149). A fully idle
monitor (all stages `healthy`) reports a `healthy` verdict.

**No-daemon fallback (#150):** if the daemon is not reachable (a genuine connection failure — socket
refused/absent or request timeout), `monitor explain` runs the **same** `explainMonitor` in-process
against the persisted SQLite store, exactly as `daemon once` runs a tick in-process. A read-only
diagnosis tool must not require a live daemon: the data from the last tick is already in the DB.
**Crucially, a daemon connection failure is NOT itself reported as a stage `failure`** — unlike the
pre-#150 behaviour which fabricated a `✗ Scheduling: failure` verdict, the in-process path runs the
full pipeline read and produces real stage statuses from persisted state.

The report is rendered according to three cases:

- **Definition failure** (parse error, monitor not found, duplicate ID, unknown source): the report
  is shown as-is — no no-daemon banner, since there is no persisted state involved; the definition
  failure is the complete diagnosis. Exits 0.
- **Definition ok, persisted state exists** (`observation_history` or `monitor_events` rows present):
  the real per-stage diagnosis is shown, prefixed with the banner _"No daemon running — showing
  persisted state from the last tick."_ (text) or annotated with a `"notice"` field alongside the
  full report (JSON). Exits 0.
- **Definition ok, nothing persisted** (no history, no events — the daemon never ran): an actionable
  remediation line is printed — _"No daemon running and no persisted state to show. Start it with
  `agentmonitors daemon run`, or use `agentmonitors monitor test <path>` for a one-shot check."_ —
  rather than a raw Node `connect ENOENT …`. Exits 1.

A daemon-side **application** error (the daemon answered with an error) is **not** masked as "daemon
not running": it is surfaced verbatim as `Explain failed: <message>` with exit code 1. Malformed
command arguments remain normal CLI errors.

---

## §7 `source` — Manage observation source plugins

**Source:** `apps/cli/src/commands/source.ts`
**Status:** `list` is fully implemented; `search`, `install`, `update`, `remove` are **placeholders — not implemented** (NP3).

### §7.1 `source list`

```
agentmonitors source list [--format <format>]
```

| Flag                | Type    | Default | Description    |
| ------------------- | ------- | ------- | -------------- |
| `--format <format>` | choices | `text`  | `text`, `json` |

Lists all sources registered via `registerCoreSources()` (currently: `file-fingerprint`, `api-poll`, `schedule`, `incoming-changes`).

**Text output:**

```
Installed sources:

  <name>
    Config fields: <field1>, <field2>, ...
    Required: <field1>, ... (or "(none)")
```

**JSON output:**

```json
[
  {
    "name": "<string>",
    "configFields": ["<string>"],
    "scopeFields": ["<string>"],
    "required": ["<string>"]
  }
]
```

`scopeFields` remains as a backwards-compatible JSON alias for existing consumers. New users should read `configFields`; these are fields written flat inside `watch:` alongside `type`, not under a `scope:` key.

### §7.2 `source search` — placeholder

```
agentmonitors source search [query]
```

Prints to stderr:

```
Plugin search is not yet implemented. (query: "<query>")
Install plugins manually: pnpm add --prefix ~/.config/agentmonitors <package-name>
```

Exits 1.

### §7.3 `source install` — placeholder

```
agentmonitors source install <name>
```

Prints to stderr:

```
Plugin installation is not yet implemented: <name>
Install manually: pnpm add --prefix ~/.config/agentmonitors <name>
```

Exits 1.

### §7.4 `source update` — placeholder

```
agentmonitors source update [name]
```

Prints to stderr:

```
Plugin update is not yet implemented. (package: <name>)
```

Exits 1.

### §7.5 `source remove` — placeholder

```
agentmonitors source remove <name>
```

Prints to stderr:

```
Plugin removal is not yet implemented: <name>
```

Exits 1.

---

## §8 `schema` — JSON Schema management

**Source:** `apps/cli/src/commands/schema.ts`
**Status:** Fully implemented

### §8.1 `schema generate`

```
agentmonitors schema generate [-o <file>]
```

| Flag                  | Type   | Default | Description                                   |
| --------------------- | ------ | ------- | --------------------------------------------- |
| `-o, --output <file>` | string | —       | Write schema to file; omit to print to stdout |

Calls `generateMonitorSchema(registry.list())` from `@agentmonitors/core` and outputs the resulting JSON schema (pretty-printed with 2-space indent).

- **Without `--output`:** prints schema JSON to stdout.
- **With `--output <file>`:** writes to file and prints `Schema written to <file>`.

### Exit codes

Exits 0 on success. No explicit error handling; filesystem errors propagate as uncaught exceptions.

---

## §9 `daemon` — Runtime loop management

**Source:** `apps/cli/src/commands/daemon.ts`
**Status:** Fully implemented

### §9.1 `daemon once` — Single in-process tick

```
agentmonitors daemon once [monitorsDir] [options]
```

| Argument / Flag      | Type                  | Default            | Description                             |
| -------------------- | --------------------- | ------------------ | --------------------------------------- |
| `[monitorsDir]`      | positional (optional) | `.claude/monitors` | Directory containing `MONITOR.md` files |
| `--workspace <path>` | string                | `process.cwd()`    | Workspace path for session projection   |
| `--format <format>`  | choices               | `text`             | `text`, `json`                          |

**Transport: in-process.** `daemonTickClient` calls `createRuntime().tick()` directly — no daemon socket is contacted.

**Text output:** `Evaluated <n> monitor(s), emitted <n> event(s).` — when one or more monitors'
`observe()` errored on the tick, the summary instead ends with `, <k> errored:` followed by one
indented `  <monitorId>: <message>` line per errored monitor (so a silently-swallowed source error
is not hidden behind a clean `emitted 0`). When nothing errored the line is unchanged, ending with
`.`, so a genuine no-change tick stays clean.

**JSON output (`--format json`):** the raw `RuntimeTickResult` object:

```json
{
  "evaluatedMonitors": ["<monitorId>", ...],
  "emittedEventIds": ["<eventId>", ...],
  "erroredObservations": [{ "monitorId": "<monitorId>", "message": "<error>" }, ...]
}
```

### §9.2 `daemon run` — Continuous loop

```
agentmonitors daemon run [monitorsDir] [options]
```

| Argument / Flag        | Type                  | Default            | Description                                                                |
| ---------------------- | --------------------- | ------------------ | -------------------------------------------------------------------------- |
| `[monitorsDir]`        | positional (optional) | `.claude/monitors` | Directory containing `MONITOR.md` files                                    |
| `--workspace <path>`   | string                | `process.cwd()`    | Workspace path for session projection                                      |
| `--poll-ms <ms>`       | number (string)       | `30000`            | Polling interval in milliseconds                                           |
| `--socket <path>`      | string                | resolved default   | Unix domain socket path for the daemon                                     |
| `--reap-after-ms <ms>` | number (string)       | `300000`           | Stop after this many ms with no active sessions; `0` disables idle reaping |

Starts the daemon loop: creates a Unix domain socket server, listens for IPC commands, then polls `runtime.tick()` at `--poll-ms` intervals.

**Startup check:** refuses to start if another daemon is already listening at the resolved socket path (exits with error message and code 1).

**Signal handling:** `SIGINT` and `SIGTERM` trigger a graceful stop (closes the socket, exits the loop).

**Idle reaping:** after each tick, counts active sessions for the workspace. If none have been active continuously for `--reap-after-ms` ms, the daemon stops itself. Disabled when `--reap-after-ms 0`.

**Stdout per tick (when events emitted _or_ one or more monitors errored):**
`Emitted <n> event(s) from <n> monitor(s).` — when one or more monitors' `observe()` errored, the
line ends with `, <k> errored:` followed by one indented `  <monitorId>: <message>` line per errored
monitor. A tick that neither emits nor errors logs nothing (no per-tick noise), but an errored
monitor is never silent.

**Tick errors** that fail the whole tick (not a single monitor's `observe()`) are logged to stderr as `AgentMon runtime tick failed: <message>` but do not stop the loop.

### §9.3 `daemon status`

```
agentmonitors daemon status [options]
```

| Flag                | Type    | Default          | Description                            |
| ------------------- | ------- | ---------------- | -------------------------------------- |
| `--socket <path>`   | string  | resolved default | Unix domain socket path for the daemon |
| `--format <format>` | choices | `text`           | `text`, `json`                         |

If the daemon is reachable (socket `ping` succeeds), queries status via the socket. Otherwise falls back to calling `createRuntime().status()` in-process against the local database.

**Text output:**

```
Daemon running: yes|no
Socket: <path>
Sessions: <n>
Active sessions: <n>
Dormant sessions: <n>
Events: <n>
```

**JSON output:**

```json
{
  "running": <boolean>,
  "socketPath": "<string>",
  "sessions": <number>,
  "activeSessions": <number>,
  "dormantSessions": <number>,
  "events": <number>
}
```

### §9.4 `daemon stop`

```
agentmonitors daemon stop [--socket <path>]
```

| Flag              | Type   | Default          | Description                            |
| ----------------- | ------ | ---------------- | -------------------------------------- |
| `--socket <path>` | string | resolved default | Unix domain socket path for the daemon |

Sends a `stop` message to the daemon over the socket. Prints `AgentMon daemon stopping.` on success. On error, calls `reportError` to stderr and exits 1.

---

## §10 `session` — Manage agent sessions

**Source:** `apps/cli/src/commands/session.ts`
**Status:** Fully implemented. All subcommands route through the daemon socket.

### §10.1 `session open`

```
agentmonitors session open --host-session-id <id> [options]
```

| Flag                       | Type              | Default          | Description                                  |
| -------------------------- | ----------------- | ---------------- | -------------------------------------------- |
| `--host-session-id <id>`   | string (required) | —                | Host session id from the integrating runtime |
| `--workspace <path>`       | string            | `process.cwd()`  | Workspace path for the session               |
| `--socket <path>`          | string            | resolved default | Unix domain socket path                      |
| `--agent-identity <id>`    | string            | —                | Explicit AgentMon agent identity             |
| `--hook-state-path <path>` | string            | —                | Override hook-state file path                |
| `--role <role>`            | choices           | `lead`           | `lead`, `subagent`                           |
| `--format <format>`        | choices           | `text`           | `text`, `json`                               |

Calls `claudeCodeAdapter.createSessionInput()` before sending to the daemon (`session.open` IPC method).

**Text output:**

```
Opened session: <session.id>
Agent identity: <session.agentIdentity>
Hook state: <session.hookStatePath>
```

**JSON output:** full `AgentSessionRecord` object.

### §10.2 `session close`

```
agentmonitors session close <sessionId> [options]
```

| Argument / Flag     | Type                  | Default          | Description             |
| ------------------- | --------------------- | ---------------- | ----------------------- |
| `<sessionId>`       | positional (required) | —                | AgentMon session id     |
| `--socket <path>`   | string                | resolved default | Unix domain socket path |
| `--format <format>` | choices               | `text`           | `text`, `json`          |

Marks the session dormant (`session.close` IPC method).

**Text output:** `Closed session: <session.id>`

**JSON output:** full `AgentSessionRecord` object.

### §10.3 `session list`

```
agentmonitors session list [options]
```

| Flag                | Type    | Default          | Description             |
| ------------------- | ------- | ---------------- | ----------------------- |
| `--socket <path>`   | string  | resolved default | Unix domain socket path |
| `--format <format>` | choices | `text`           | `text`, `json`          |

**Text output:** one line per session: `<id>  <status>  <agentIdentity>  <workspacePath | "(global)">`

**JSON output:** `AgentSessionRecord[]` array.

### §10.4 `session start` — Lazy-boot daemon and register session

```
agentmonitors session start
```

No flags. Like `hook deliver`, this command is hook-invoked and reads its context from the **Claude
Code hook payload on stdin** (a JSON object — there is **no `CLAUDE_CODE_SESSION_ID` env var**; see
006 §5.0). If stdin is a TTY or empty/unparseable, the payload is `{}`.

| Payload field | Description                                                               |
| ------------- | ------------------------------------------------------------------------- |
| `session_id`  | Host session id (required; quiet no-op if absent — not a Claude session)  |
| `cwd`         | Workspace path (falls back to `CLAUDE_PROJECT_DIR`, then `process.cwd()`) |

**Behavior:**

0. Reads the hook payload from stdin. `hostSessionId = session_id`; if absent, exits silently (not a Claude session).
1. Reads `.claude/agentmonitors.local.md` in the workspace. If absent or `enabled: false`, exits silently (quick-exit).
2. Derives per-workspace socket/db paths via `workspacePaths()` (overridden by `socket`/`db` fields in the local state file if present).
3. If no daemon is listening at the socket, spawns `daemon run` as a **detached background process** (`stdio: 'ignore'`, `.unref()`), passing the derived socket/db paths, the monitors dir, and `reap-after-ms` from the local state. Waits up to 8 seconds for the socket to appear.
4. Persists the resolved socket/db paths back to `.claude/agentmonitors.local.md` (so sibling hooks can use them without re-deriving).
5. Opens a session via the `session.open` IPC method (`claudeCodeAdapter.createSessionInput()` with `hostSessionId` and `workspacePath`).
6. **Surfaces the post-compact recap in the same process.** `SessionStart` is a context event, and a Claude Code hook invocation provides only **one** stdin stream — so the recap cannot be a separately chained `hook deliver` (it would see an already-consumed stdin and no-op; see 006 §5.6). Reusing the payload it already read, `session start` claims `post-compact` for the session and, if there are unread events, prints the rendered `SessionStart` hook JSON (`{ "continue": true, "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }`) to stdout.

**Output:**

- **Nothing pending** (a fresh start with no unread events) → **no output**.
- **Compact-resume with unread events** → the `SessionStart` recap JSON on stdout (the `additionalContext` carries the unread events' bodies). This is the only `session …` subcommand that emits hook-wire JSON, so its stdout MUST stay clean (wire JSON only).

**Exit code (two layers):**

- The **CLI command** exits **0** on a quick-exit (no `session_id`, or monitoring not enabled) and on success (with or without recap output). A genuine failure — the daemon not starting within the boot timeout, or a `session.open`/`claimDelivery` error — is reported to **stderr** and exits **non-zero** (`reportError(…, false)` sets `process.exitCode = 1`).
- The **plugin hook wrapper** (`agent-plugins/agentmonitors/hooks/hooks.json`) runs the command as `agentmonitors session start || true`, so the **hook invocation** is best-effort from Claude Code's perspective — a CLI failure never disrupts the session. The best-effort property is the wrapper's, not the command's.

**Designed for use as a `SessionStart` hook** (see 006 §5.6). Claude Code does not need the daemon to be pre-started.

### §10.5 `session end` — Deregister session

```
agentmonitors session end
```

No flags. Reads the same stdin hook payload as `session start` (`session_id` + `cwd`; **not** env
vars).

**Behavior:**

0. Reads the hook payload from stdin. `hostSessionId = session_id`; if absent, exits silently.
1. Reads `.claude/agentmonitors.local.md`. If absent, `enabled: false`, or no `socket` field, exits silently.
2. If the daemon is unreachable, exits silently.
3. Calls `session.list` to find the runtime session whose `hostSessionId` matches the payload's `session_id`, then calls `session.close` on it.

After all sessions for a workspace are closed, the daemon's idle reaper will stop it within `reap-after-ms`.

**Designed for use as a `Stop` hook** in Claude Code.

---

## §11 `events` — Query or acknowledge runtime events

**Source:** `apps/cli/src/commands/events.ts`
**Status:** Fully implemented. All subcommands route through the daemon socket.

### §11.1 `events list`

```
agentmonitors events list --session <id> [options]
```

| Flag                  | Type                | Default          | Description                                    |
| --------------------- | ------------------- | ---------------- | ---------------------------------------------- |
| `--session <id>`      | string (required)   | —                | AgentMon session id                            |
| `--socket <path>`     | string              | resolved default | Unix domain socket path                        |
| `--monitor <id>`      | string              | —                | Filter by monitor id                           |
| `--urgency <urgency>` | choices             | —                | `low`, `normal`, `high`                        |
| `--tag <tag>`         | string (repeatable) | `[]`             | Filter by tag; may be specified multiple times |
| `--scope <pairs>`     | string              | —                | Scope filters as `key=value,key2=value2`       |
| `--unread`            | boolean flag        | —                | Only unread events                             |
| `--since-baseline`    | boolean flag        | —                | Only events since the session baseline         |
| `--format <format>`   | choices             | `text`           | `text`, `json`                                 |

**Text output:** one line per event: `<id>  <monitorId>  <urgency>  <title>`

**JSON output:** `MonitorEventRecord[]` array.

**Scope parsing:** the `--scope` value is split on `,`, then each segment is split on `=` to build a `Record<string, string>`. Segments that cannot be parsed as `key=value` are silently dropped.

**Note on `--tag`:** this flag is repeatable (using a custom `collectTag` accumulator). Example: `--tag foo --tag bar` filters for events tagged with both `foo` and `bar`.

### §11.2 `events ack`

```
agentmonitors events ack --session <id> [options]
```

| Flag                | Type              | Default          | Description                                       |
| ------------------- | ----------------- | ---------------- | ------------------------------------------------- |
| `--session <id>`    | string (required) | —                | AgentMon session id                               |
| `--socket <path>`   | string            | resolved default | Unix domain socket path                           |
| `--event-ids <ids>` | string            | —                | Comma-separated event ids; omit to ack all unread |

Prints `Acknowledged events.` on success. No `--format` flag; error output goes to stderr.

---

## §12 `hook` — Claim hook-delivery payloads

**Source:** `apps/cli/src/commands/hook.ts`
**Status:** Fully implemented. Routes through the daemon socket.

### §12.1 `hook claim`

```
agentmonitors hook claim --session <id> --lifecycle <lifecycle> [options]
```

| Flag                      | Type               | Default          | Description                                                    |
| ------------------------- | ------------------ | ---------------- | -------------------------------------------------------------- |
| `--session <id>`          | string (required)  | —                | AgentMon session id                                            |
| `--socket <path>`         | string             | resolved default | Unix domain socket path                                        |
| `--lifecycle <lifecycle>` | choices (required) | —                | `turn-interruptible`, `turn-idle`, `post-compact`              |
| `--format <format>`       | choices            | `json`           | `text`, `json` — **default is `json`** (unique among commands) |

Claims a pending delivery payload for a session at the specified lifecycle point (`hook.claim` IPC method). Returns `null` if no delivery is pending.

**JSON output (default):**

```json
<DeliveryClaim object | null>
```

**Text output (`--format text`):**

- If no pending delivery: `No pending delivery.`
- If delivery present: prints `claim.message`.

---

### §12.2 `hook deliver`

```
agentmonitors hook deliver [--lifecycle <lifecycle>] [--socket <path>]
```

| Flag                      | Type    | Default          | Description                                                                                                   |
| ------------------------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `--lifecycle <lifecycle>` | choices | derived          | Optional override (`turn-interruptible`, `turn-idle`, `post-compact`); normally derived from the firing event |
| `--socket <path>`         | string  | from `.local.md` | Override daemon socket path                                                                                   |

**Designed to run as a Claude Code lifecycle hook.** Reads the hook payload as **JSON on stdin**
(Claude Code delivers hook input via stdin, **not** env vars — there is no `CLAUDE_CODE_SESSION_ID`
env var). It uses `session_id`, `hook_event_name`, and `cwd` from the payload, claims pending
deliveries for that session, and emits them as **advisory, non-blocking `additionalContext`** at the
turn boundary. The lifecycle is derived from `hook_event_name`; the same command line works on every
event.

**Behavior:**

1. Read stdin as a JSON hook payload (TTY/empty/unparseable → `{}`; never hangs). If `session_id` is absent → exit 0, print nothing.
2. Derive the lifecycle from `hook_event_name` (unless `--lifecycle` is passed). Non-context events (`PreToolUse`, `Stop`) → exit 0, print nothing.
3. Read `.claude/agentmonitors.local.md` via `payload.cwd ?? CLAUDE_PROJECT_DIR ?? cwd`. If `!enabled` or no explicit socket → exit 0, print nothing.
4. Check daemon availability. If unreachable → exit 0, print nothing.
5. List sessions, find the one matching `session_id`. If not found → exit 0, print nothing.
6. Call `claimDelivery(sessionId, lifecycle)`. If null → exit 0, print nothing.
7. Render via `renderHookDelivery(claim, hookEventName)`. If null (empty events) → exit 0, print nothing.
8. Print the wire JSON to stdout and exit 0.

**ALWAYS exits 0.** Any internal error is swallowed to avoid interrupting the user's session. A hook
that exits non-zero can block tool calls.

**Wire output (when there is something pending):**

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "AgentMon: monitored changes are pending — consider handling them before continuing.\n\n### watch-src (high)\n..."
  }
}
```

**No output** when nothing is pending (empty stdout + exit 0).

Note: for a derived `turn-interruptible` lifecycle, `normal` urgency produces `events: []` (reminder
only — no body injection). Body text is surfaced for **high-urgency settled events** and
**`post-compact`** (`SessionStart`) recap. Over-cap context is truncated at a code-point boundary
with an explicit `[truncated …]` marker; the truncated-away events stay unread (claiming ≠ acking)
and are re-discoverable via `events list --unread`.

See [006 §5](./006-agent-integration.md) for the full transport spec and hook registration examples.

---

## §13 `channel` — Claude Code channel server

**Source:** `apps/cli/src/commands/channel.ts`
**Status:** Two-way (push + `agentmon_ack` tool) implemented. Plugin packaging is the remaining
target work; see [006 §4](./006-agent-integration.md).

### `channel serve`

Runs AgentMon as a Claude Code **channel**: an MCP server (stdio) that pushes pending
turn-interruptible deliveries (settled high-urgency events, and coalesced normal reminders) into the
session as `<channel source="agentmonitors" …>` events. Intended to be spawned by Claude Code via a
channel plugin, not run by hand.

**Usage:** `agentmonitors channel serve [--socket <path>] [--poll-ms <ms>] [--host-session-id <id>] [--workspace <path>]`

- `--socket` — daemon Unix socket path (default: `$AGENTMONITORS_SOCKET` or the standard path).
- `--poll-ms` — delivery poll interval in milliseconds (default: `3000`).
- `--host-session-id` — host session id (default: `$CLAUDE_CODE_SESSION_ID`).
- `--workspace` — workspace path (default: `$CLAUDE_PROJECT_DIR`).

**Behavior:** declares the `claude/channel` capability **and `tools`**, and connects over stdio. If a
host session id is available, it resolves the AgentMon session via `session.open` (idempotent) and,
every `--poll-ms`, calls `claimDelivery('turn-interruptible')`; each returned `DeliveryClaim` is
rendered into a `<channel>` event (006 §4.2). It also exposes the **`agentmon_ack`** tool: the agent
calls it with `event_ids` (or none, to ack all unread) and it routes through `events.ack` for the
bound session (006 §4.3). It reuses the claim path, so claimed-state and cross-transport dedup with
the hook-state surface are automatic. A missing/unreachable daemon is handled quietly (the hook-state
path still delivers durably); the server shuts down when stdin closes (MCP disconnect). With no host
session id it stays connected (the ack tool reports an error if called) but does not poll.

**Output:** none on stdout (the stdio channel is the MCP transport). Errors are quiet by design.

---

## §14 Exit codes & diagnostics

### General conventions

| Condition                           | Exit code                        | Output target                                       |
| ----------------------------------- | -------------------------------- | --------------------------------------------------- |
| Success                             | `0`                              | —                                                   |
| Validation/argument error           | `1` (via `process.exitCode = 1`) | stderr (text) or stdout (JSON `{ "error": "..." }`) |
| Daemon socket unavailable / timeout | `1`                              | stderr                                              |
| Unknown source / parse failure      | `1`                              | stderr or JSON error                                |
| Placeholder command invoked         | `1`                              | stderr                                              |

### Error output routing

All commands that support `--format json` use `reportError()` (`apps/cli/src/output.ts`) for errors:

- **JSON mode:** writes `{ "error": "<message>" }` to **stdout** (so JSON consumers get a consistent channel) and sets `process.exitCode = 1`.
- **Text mode:** writes `Error: <message>` to **stderr** and sets `process.exitCode = 1`.

### Commands that use `process.exitCode` (not `process.exit`)

All commands set `process.exitCode = 1` rather than calling `process.exit(1)`. This allows in-flight async operations and Node.js cleanup handlers to complete before the process terminates.

### Daemon socket timeout

`callDaemon()` defaults to a **2 000 ms timeout**. The `daemonAvailable()` ping uses a **500 ms timeout**. On timeout, the error message is: `Timed out waiting for AgentMon daemon at <socketPath>`.

### Commands with no error handling on `--format json`

`inbox ack/start/complete/fail/archive` and `events ack` do not accept `--format json`; their errors always go to stderr.

---

## Appendix A — Command inventory

| Command    | Subcommand | Transport                         | Status                                      |
| ---------- | ---------- | --------------------------------- | ------------------------------------------- |
| `init`     | —          | in-process                        | Fully implemented                           |
| `validate` | —          | in-process                        | Fully implemented (full schema)             |
| `scan`     | —          | in-process                        | Fully implemented                           |
| `inbox`    | `list`     | in-process                        | Fully implemented                           |
| `inbox`    | `ack`      | in-process                        | Fully implemented                           |
| `inbox`    | `start`    | in-process                        | Fully implemented                           |
| `inbox`    | `complete` | in-process                        | Fully implemented                           |
| `inbox`    | `fail`     | in-process                        | Fully implemented                           |
| `inbox`    | `archive`  | in-process                        | Fully implemented                           |
| `monitor`  | `test`     | in-process                        | Fully implemented                           |
| `monitor`  | `history`  | socket                            | Fully implemented                           |
| `source`   | `list`     | in-process                        | Fully implemented                           |
| `source`   | `search`   | —                                 | Placeholder / not implemented (NP3)         |
| `source`   | `install`  | —                                 | Placeholder / not implemented (NP3)         |
| `source`   | `update`   | —                                 | Placeholder / not implemented (NP3)         |
| `source`   | `remove`   | —                                 | Placeholder / not implemented (NP3)         |
| `schema`   | `generate` | in-process                        | Fully implemented                           |
| `daemon`   | `once`     | in-process                        | Fully implemented                           |
| `daemon`   | `run`      | creates socket server             | Fully implemented (`--reap-after-ms` added) |
| `daemon`   | `status`   | socket (with in-process fallback) | Fully implemented                           |
| `daemon`   | `stop`     | socket                            | Fully implemented                           |
| `session`  | `open`     | socket                            | Fully implemented                           |
| `session`  | `close`    | socket                            | Fully implemented                           |
| `session`  | `list`     | socket                            | Fully implemented                           |
| `session`  | `start`    | in-process + socket (lazy boot)   | Fully implemented                           |
| `session`  | `end`      | socket                            | Fully implemented                           |
| `events`   | `list`     | socket                            | Fully implemented                           |
| `events`   | `ack`      | socket                            | Fully implemented                           |
| `hook`     | `claim`    | socket                            | Fully implemented                           |
| `hook`     | `deliver`  | socket (always exits 0)           | Fully implemented                           |
| `channel`  | `serve`    | stdio MCP server + socket         | Two-way (push + `agentmon_ack`)             |

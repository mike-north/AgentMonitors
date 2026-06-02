# 005 — CLI Reference

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [003-source-plugins.md](./003-source-plugins.md)
> **Covers:** the `agentmonitors` command surface — purpose, arguments, flags, output shape, and current-vs-target status of every command

---

## §1 Overview

The binary is named **`agentmonitors`** and is described as _"Durable observation and inbox delivery for AI agents"_ (version `0.0.0` in the current codebase).

Per AP6, all public CLI behaviour must be derivable from core contracts. The CLI wraps `@mike-north/core` and three bundled source packages (`@mike-north/source-file-fingerprint`, `@mike-north/source-api-poll`, `@mike-north/source-schedule`).

### In-process vs. socket commands

Commands divide into two transport modes:

| Mode                                   | Commands                                                                                                 | Mechanism                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **In-process** (no socket)             | `init`, `validate`, `scan`, `monitor test`, `source list`, `schema generate`, `inbox *`, `daemon once`   | Operates directly on the filesystem and/or SQLite database. No daemon socket required.         |
| **Daemon socket** (Unix domain socket) | `daemon run`, `daemon status`, `daemon stop`, `session open/close/list`, `events list/ack`, `hook claim` | Sends JSON-RPC-style messages over a Unix domain socket via `callDaemon()` in `daemon-ipc.ts`. |

**`daemon once` is notable:** although it lives under the `daemon` command group, its implementation in `runtime-client.ts` (`daemonTickClient`) calls `createRuntime()` and `runtime.tick()` directly without using the socket. It is a single-tick in-process run, not a socket call. This is consistent with [002-runtime-delivery.md](./002-runtime-delivery.md).

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

| Argument / Flag     | Type                  | Default            | Description                                                    |
| ------------------- | --------------------- | ------------------ | -------------------------------------------------------------- |
| `<name>`            | positional (required) | —                  | Monitor name, becomes the subdirectory name                    |
| `--dir <dir>`       | option                | `.claude/monitors` | Base directory for monitors                                    |
| `--source <source>` | option (choices)      | `file-fingerprint` | Observation source: `file-fingerprint`, `api-poll`, `schedule` |

### Output

Human-readable only (no `--format` flag).

- **Success:** prints `Created monitor: <dir>/<name>/MONITOR.md` followed by a hint to run `agentmonitors validate <dir>`.
- **Failure:** prints to stderr `Monitor already exists: <dir>/<name>/MONITOR.md`; exits with code 1.

### Templates

Each source produces a distinct starter frontmatter block:

| Source             | Key scope fields in template                                                 |
| ------------------ | ---------------------------------------------------------------------------- |
| `file-fingerprint` | `globs: ['**/*.ts']`                                                         |
| `api-poll`         | `url`, `method: GET`, `interval: 5m`, `change-detection.strategy: json-diff` |
| `schedule`         | `cron: '0 9 * * 1-5'`, `timezone: UTC`                                       |

---

## §3 `validate` — Validate monitor files

**Source:** `apps/cli/src/commands/validate.ts`
**Status:** Partial — validates required scope fields only; full JSON Schema validation is not yet implemented. See [004-validation-testing.md](./004-validation-testing.md) for the target validation contract.

### Purpose

Validates all `MONITOR.md` files found in a directory: checks that each monitor references a known source and that the `scope` block contains all fields declared `required` in the source's `scopeSchema`.

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

1. Parses all `MONITOR.md` files via `scanMonitors()` from `@mike-north/core` (parse errors are included in `errors`).
2. Checks each monitor's `source` field against the built-in `SourceRegistry`; unknown sources produce an error listing available sources.
3. Checks that every field listed in `source.scopeSchema.required[]` is present in the monitor's `scope` block.

**What is NOT validated:** field types, additional constraints from the JSON Schema (minimum, maximum, enum values, etc.).

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
      "event-kind": "<string>",
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
| `--event-kind <kind>` | choices  | —       | Filter: `mutation`, `notification`, `alert`                                 |
| `--tags <tags>`       | string   | —       | Comma-separated tag filter                                                  |
| `--monitor <id>`      | string   | —       | Filter by monitor ID                                                        |
| `--since <date>`      | ISO 8601 | —       | Items created after this date                                               |
| `--until <date>`      | ISO 8601 | —       | Items created before this date                                              |
| `--format <format>`   | choices  | `text`  | `text`, `json`                                                              |

**Text output:** one line per item: `[<state>] <id>  <title>  (<urgency>, <eventKind>)`

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

Lists all sources registered via `registerCoreSources()` (currently: `file-fingerprint`, `api-poll`, `schedule`).

**Text output:**

```
Installed sources:

  <name>
    Scope fields: <field1>, <field2>, ...
    Required: <field1>, ... (or "(none)")
```

**JSON output:**

```json
[
  {
    "name": "<string>",
    "scopeFields": ["<string>"],
    "required": ["<string>"]
  }
]
```

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

Calls `generateMonitorSchema(registry.list())` from `@mike-north/core` and outputs the resulting JSON schema (pretty-printed with 2-space indent).

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

**Text output:** `Evaluated <n> monitor(s), emitted <n> event(s).`

**JSON output (`--format json`):** the raw `RuntimeTickResult` object:

```json
{
  "evaluatedMonitors": ["<monitorId>", ...],
  "emittedEventIds": ["<eventId>", ...]
}
```

### §9.2 `daemon run` — Continuous loop

```
agentmonitors daemon run [monitorsDir] [options]
```

| Argument / Flag      | Type                  | Default            | Description                             |
| -------------------- | --------------------- | ------------------ | --------------------------------------- |
| `[monitorsDir]`      | positional (optional) | `.claude/monitors` | Directory containing `MONITOR.md` files |
| `--workspace <path>` | string                | `process.cwd()`    | Workspace path for session projection   |
| `--poll-ms <ms>`     | number (string)       | `30000`            | Polling interval in milliseconds        |
| `--socket <path>`    | string                | resolved default   | Unix domain socket path for the daemon  |

Starts the daemon loop: creates a Unix domain socket server, listens for IPC commands, then polls `runtime.tick()` at `--poll-ms` intervals.

**Startup check:** refuses to start if another daemon is already listening at the resolved socket path (exits with error message and code 1).

**Signal handling:** `SIGINT` and `SIGTERM` trigger a graceful stop (closes the socket, exits the loop).

**Stdout per tick (when events emitted):** `Emitted <n> event(s) from <n> monitor(s).`

**Tick errors** are logged to stderr as `AgentMon runtime tick failed: <message>` but do not stop the loop.

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
| `--event-kind <kind>` | choices             | —                | `mutation`, `notification`, `alert`            |
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

| Command    | Subcommand | Transport                         | Status                              |
| ---------- | ---------- | --------------------------------- | ----------------------------------- |
| `init`     | —          | in-process                        | Fully implemented                   |
| `validate` | —          | in-process                        | Fully implemented (full schema)     |
| `scan`     | —          | in-process                        | Fully implemented                   |
| `inbox`    | `list`     | in-process                        | Fully implemented                   |
| `inbox`    | `ack`      | in-process                        | Fully implemented                   |
| `inbox`    | `start`    | in-process                        | Fully implemented                   |
| `inbox`    | `complete` | in-process                        | Fully implemented                   |
| `inbox`    | `fail`     | in-process                        | Fully implemented                   |
| `inbox`    | `archive`  | in-process                        | Fully implemented                   |
| `monitor`  | `test`     | in-process                        | Fully implemented                   |
| `source`   | `list`     | in-process                        | Fully implemented                   |
| `source`   | `search`   | —                                 | Placeholder / not implemented (NP3) |
| `source`   | `install`  | —                                 | Placeholder / not implemented (NP3) |
| `source`   | `update`   | —                                 | Placeholder / not implemented (NP3) |
| `source`   | `remove`   | —                                 | Placeholder / not implemented (NP3) |
| `schema`   | `generate` | in-process                        | Fully implemented                   |
| `daemon`   | `once`     | in-process                        | Fully implemented                   |
| `daemon`   | `run`      | creates socket server             | Fully implemented                   |
| `daemon`   | `status`   | socket (with in-process fallback) | Fully implemented                   |
| `daemon`   | `stop`     | socket                            | Fully implemented                   |
| `session`  | `open`     | socket                            | Fully implemented                   |
| `session`  | `close`    | socket                            | Fully implemented                   |
| `session`  | `list`     | socket                            | Fully implemented                   |
| `events`   | `list`     | socket                            | Fully implemented                   |
| `events`   | `ack`      | socket                            | Fully implemented                   |
| `hook`     | `claim`    | socket                            | Fully implemented                   |
| `channel`  | `serve`    | stdio MCP server + socket         | Two-way (push + `agentmon_ack`)     |

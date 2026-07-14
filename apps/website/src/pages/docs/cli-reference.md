---
title: CLI Reference
description: Every agentmonitors command — synopsis, key flags, an example, and output-format notes. Verified against the built CLI's --help output.
---

# CLI Reference

The binary is `agentmonitors` ("Durable observation and inbox delivery for AI agents"). This page
is a quick-scan reference card — synopsis, key flags, and a runnable example per command. It is
not the contract: for full behavior, exit codes, and JSON shapes see
[spec 005 — CLI Reference](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/005-cli-reference.md)
(this page was built from that spec's current revision). New to the CLI? Start with
[Getting Started](/docs/getting-started).

Every command also has its own `--help`, which always reflects the installed version:

```bash
agentmonitors <command> --help
```

## Output formats (`--format`)

Structured-output commands (`events list`, `scan`, `monitor history`, `monitor explain`, and
`source list`) support three values:

| Value  | Description                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------ |
| `toon` | Compact TOON encoding, optimized for agent context windows.                                      |
| `json` | `JSON.stringify(value, null, 2)` — stable, byte-for-byte unchanged for existing JSON consumers.   |
| `text` | Human-readable columnar/plain text for interactive terminal use.                                 |

When `--format` is omitted on those commands, the CLI auto-detects: an agentic TUI (Claude Code,
Cursor, Gemini CLI, etc.) gets `toon`; an interactive human terminal gets `text`. An explicit
`--format` always wins. Commands with a fixed `text`/`json` pair (no `toon`) default to `text`
unless noted otherwise below.

## Transport: in-process vs. daemon socket

Some commands run entirely in-process against the filesystem and/or local SQLite database
(`init`, `validate`, `scan`, `monitor test`, `source list`, `schema generate`, `inbox *`,
`daemon once`, `doctor`). Others round-trip the daemon over a Unix domain socket
(`daemon run/status/stop`, `session *`, `events *`, `hook *`). `monitor history` and
`monitor explain` are socket-first but fall back to reading persisted state in-process when no
daemon is reachable. Socket resolution for every `--socket`-accepting command is:
`--socket` flag → `AGENTMONITORS_SOCKET` env var → the global default
(`~/.local/share/agentmonitors/agentmonitors.sock`). The session-lifecycle commands
(`session start`/`end`) additionally use the enabled workspace's persisted socket from
`.claude/agentmonitors.local.md` as their effective override, so hook-driven sessions and manual
commands can target the same daemon. See
[Troubleshooting](/docs/troubleshooting) ("Which session ID do I use") for the related
session-id distinction.

---

## `init` — bootstrap the project, or scaffold a monitor

```bash
agentmonitors init [name] [options]
```

With no `[name]`, `init` runs the **bootstrap** form: enables the project, fixes `.gitignore`,
optionally scaffolds a first monitor, validates it, and prints next steps. With `[name]`, it runs
the **scaffold** form: creates one `MONITOR.md`.

| Flag             | Default            | Description                                                              |
| ----------------- | ------------------ | ------------------------------------------------------------------------ |
| `[name]`          | —                   | Monitor name (kebab-case). Omit to bootstrap the whole project instead.  |
| `--dir <dir>`     | `.claude/monitors` | Base directory for monitors                                              |
| `--type <type>`   | `file-fingerprint` | `file-fingerprint`, `api-poll`, `command-poll`, `schedule`, `incoming-changes` |
| `--enable-only`   | —                   | Bootstrap only: enable the project and fix `.gitignore`, then stop       |
| `--yes`           | —                   | Bootstrap non-interactively: accept defaults, scaffold a starter monitor |

No `--format` flag — output is always human-readable text.

```bash
agentmonitors init --yes           # one-shot project bootstrap, no prompts
agentmonitors init my-monitor      # scaffold a single file-fingerprint monitor
```

## `validate` — validate `MONITOR.md` files

```bash
agentmonitors validate [path] [options]
```

| Flag                 | Default            | Description                          |
| --------------------- | ------------------ | ------------------------------------- |
| `[path]`               | `.claude/monitors` | Directory to validate                 |
| `--format <format>`   | `text`              | `text`, `json`                        |

```bash
agentmonitors validate .claude/monitors --format json
```

Checks every monitor's `watch` config against its source's full JSON Schema and rejects duplicate
monitor IDs. Exits `1` if any monitor is invalid.

## `scan` — discover and summarize monitors

```bash
agentmonitors scan [dir] [options]
```

| Flag                 | Default            | Description                          |
| --------------------- | ------------------ | ------------------------------------- |
| `[dir]`                | `.claude/monitors` | Directory to scan                     |
| `--format <format>`   | auto-detect         | `toon`, `json`, `text`                |

```bash
agentmonitors scan .claude/monitors
```

Discovery only — never validates. Exits `0` on any scan result (including zero monitors);
argument errors (missing directory, path is a file) exit non-zero.

---

## `inbox` — manage inbox items

The legacy inbox state machine (`queued → acked → in-progress → completed|failed → archived`).
All subcommands are in-process. See
[002-runtime-delivery.md](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/002-runtime-delivery.md)
§12 for how this relates to the primary monitor-events pipeline.

### `inbox list`

```bash
agentmonitors inbox list [options]
```

| Flag                  | Default | Description                                                                  |
| ---------------------- | ------- | ------------------------------------------------------------------------------ |
| `--state <state>`     | —        | `queued`, `acked`, `in-progress`, `completed`, `failed`, `archived`           |
| `--urgency <urgency>` | —        | `low`, `normal`, `high`                                                       |
| `--tags <tags>`       | —        | Comma-separated tag filter                                                    |
| `--monitor <id>`      | —        | Filter by monitor ID                                                          |
| `--since <date>`      | —        | ISO 8601; items created after this date                                       |
| `--until <date>`      | —        | ISO 8601; items created before this date                                      |
| `--format <format>`   | `text`   | `text`, `json`                                                                 |

```bash
agentmonitors inbox list --state queued --format json
```

### `inbox ack` / `start` / `complete` / `fail` / `archive`

```bash
agentmonitors inbox ack <id>
agentmonitors inbox start <id>
agentmonitors inbox complete <id>
agentmonitors inbox fail <id> [--error <message>]
agentmonitors inbox archive <id>
```

State-transition commands. No `--format` flag — always plain text (`Acknowledged: <id>`, etc.);
errors go to stderr and exit `1`.

```bash
agentmonitors inbox ack itm_01hz3k9x2p
```

---

## `monitor` — test and diagnose a single monitor

### `monitor test` — dry-run an observation source

```bash
agentmonitors monitor test <path> [options]
```

| Flag                 | Default | Description                        |
| --------------------- | ------- | ------------------------------------ |
| `<path>`               | —        | Path to a single `MONITOR.md` file  |
| `--format <format>`   | `text`   | `text`, `json`                      |

```bash
agentmonitors monitor test .claude/monitors/watch-src/MONITOR.md
```

Runs a live observation cycle without writing to the database. For stateful sources, automatically
runs a second observation after 100 ms to demonstrate change detection. In-process, no daemon
required.

### `monitor history` — observation audit trail

```bash
agentmonitors monitor history [monitorId] [--socket <path>] [--limit <n>] [--format <toon|text|json>]
```

| Flag              | Default        | Description                    |
| ------------------ | -------------- | -------------------------------- |
| `[monitorId]`       | —               | Filter to a single monitor id  |
| `--limit <n>`      | `50`            | Maximum rows (newest first)     |
| `--format`         | auto-detect     | `toon`, `text`, `json`          |

```bash
agentmonitors monitor history watch-src --limit 10
```

Each row reports one of `triggered`, `suppressed`, `no-change`, `no-files-matched`, `errored`, or
`rebaselined`. Socket-first with an in-process fallback to persisted state when no daemon is
reachable — the text output is prefixed with a "No daemon running" banner in that case.

### `monitor explain` — pipeline diagnosis

```bash
agentmonitors monitor explain <monitorId> [--dir <path>] [--workspace <path>] [--socket <path>] [--history-limit <n>] [--event-limit <n>] [--format <toon|text|json>]
```

| Flag                  | Default             | Description                              |
| ----------------------- | ------------------- | ------------------------------------------ |
| `<monitorId>`            | —                    | Monitor id to diagnose                    |
| `--dir <path>`          | `.claude/monitors`   | Directory containing monitor definitions  |
| `--workspace <path>`    | current working dir | Workspace path used for session projection |
| `--history-limit <n>`   | `10`                 | Observation history rows included         |
| `--event-limit <n>`     | `10`                 | Materialized event rows included          |
| `--format`              | auto-detect          | `toon`, `text`, `json`                    |

```bash
agentmonitors monitor explain watch-src --format text
```

Answers "why didn't my monitor fire?" by walking six pipeline stages (definition → scheduling →
observation → notify → materialization → delivery) and naming the one where the signal actually
stopped. See [Troubleshooting](/docs/troubleshooting) ("My monitor never fires") for a worked
example. Socket-first with the same no-daemon in-process fallback as `monitor history`.

---

## `source` — manage observation source plugins

### `source list`

```bash
agentmonitors source list [--format <format>]
```

| Flag                 | Default     | Description             |
| --------------------- | ----------- | -------------------------- |
| `--format <format>`  | auto-detect | `toon`, `json`, `text`   |

```bash
agentmonitors source list --format json
```

Lists the sources registered by `registerCoreSources()`: `file-fingerprint`, `api-poll`,
`command-poll`, `schedule`, `incoming-changes`.

### `source search` / `install` / `update` / `remove` — not yet implemented

```bash
agentmonitors source search [query]
agentmonitors source install <name>
agentmonitors source update [name]
agentmonitors source remove <name>
```

These are placeholders: each prints a `[not yet implemented]` message to stderr and exits `1`.
`source search` and `source install` additionally name the manual workaround
(`pnpm add --prefix ~/.config/agentmonitors <package-name>`); `update` and `remove` do not.

---

## `schema` — JSON Schema management

### `schema generate`

```bash
agentmonitors schema generate [-o <file>]
```

| Flag                  | Default | Description                                    |
| ----------------------- | ------- | ------------------------------------------------- |
| `-o, --output <file>`  | —        | Write schema to file; omit to print to stdout    |

```bash
agentmonitors schema generate -o monitor.schema.json
```

Generates a combined JSON Schema from every registered source, pretty-printed. No `--format` flag.

---

## `daemon` — runtime loop management

### `daemon once` — single in-process tick

```bash
agentmonitors daemon once [monitorsDir] [options]
```

| Flag                  | Default            | Description                             |
| ----------------------- | ------------------- | ------------------------------------------ |
| `[monitorsDir]`          | `.claude/monitors`  | Directory containing `MONITOR.md` files  |
| `--workspace <path>`    | `process.cwd()`      | Workspace path for session projection    |
| `--format <format>`    | `text`               | `text`, `json`                           |

```bash
agentmonitors daemon once .claude/monitors
```

Runs `createRuntime().tick()` directly — **no socket is contacted**, even though it lives under
`daemon`. Useful in CI or scripts where a long-running daemon isn't wanted.

### `daemon run` — continuous loop

```bash
agentmonitors daemon run [monitorsDir] [options]
```

| Flag                    | Default            | Description                                                                |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `[monitorsDir]`            | `.claude/monitors`  | Directory containing `MONITOR.md` files                                    |
| `--workspace <path>`      | `process.cwd()`      | Workspace path for session projection                                        |
| `--poll-ms <ms>`          | `30000`              | Loop-wake cadence; per-monitor observation is still gated by its own schedule |
| `--socket <path>`         | resolved default     | Unix domain socket path                                                       |
| `--reap-after-ms <ms>`    | `300000`             | Stop after this many ms with no active sessions; `0` disables idle reaping   |

```bash
agentmonitors daemon run --poll-ms 5000
```

Starts a Unix socket server and polls `runtime.tick()`. Refuses to start if another daemon is
already listening on the resolved socket. `SIGINT`/`SIGTERM` trigger a graceful stop.

### `daemon status`

```bash
agentmonitors daemon status [options]
```

| Flag                  | Default          | Description                          |
| ----------------------- | ----------------- | ---------------------------------------- |
| `--socket <path>`      | resolved default   | Unix domain socket path                |
| `--format <format>`    | `text`             | `text`, `json`                        |

```bash
agentmonitors daemon status --format json
```

Queries via the socket when reachable; otherwise falls back to reading the local database
in-process.

### `daemon stop`

```bash
agentmonitors daemon stop [--socket <path>]
```

```bash
agentmonitors daemon stop
```

Sends a `stop` message over the socket. No `--format` flag.

---

## `doctor` — unified workspace health check

```bash
agentmonitors doctor [--dir <path>] [--workspace <path>] [--socket <path>] [--format <text|json>]
```

| Flag                  | Default                        | Description                                                |
| ----------------------- | ------------------------------- | ------------------------------------------------------------ |
| `--dir <path>`          | `<workspace>/.claude/monitors`  | Directory containing monitor definitions                    |
| `--workspace <path>`   | current working dir             | Workspace to diagnose                                       |
| `--socket <path>`      | resolved default                 | Only used for the `daemon-reachable` ping                    |
| `--format <format>`    | `text`                           | `text`, `json`                                               |

```bash
agentmonitors doctor --format json
```

Answers "is my monitoring working, and if not, where?" in one command: `project-enabled` →
`monitors-directory` → `monitors-valid` → `daemon-reachable` → `lead-session` → one
`monitor:<id>` rollup line per discovered monitor. Diagnoses only — never mutates state, and
never needs a running daemon (it reads the persisted store directly; the socket is used only for
the reachability ping). Exits `0` only when every check passes.

---

## `session` — manage agent sessions

All subcommands route through the daemon socket except `start`/`end`, which lazy-boot the daemon.

### `session open`

```bash
agentmonitors session open --host-session-id <id> [options]
```

| Flag                       | Default          | Description                          |
| ---------------------------- | ----------------- | ---------------------------------------- |
| `--host-session-id <id>`    | required           | Host session id from the integrating runtime |
| `--workspace <path>`        | `process.cwd()`    | Workspace path for the session          |
| `--socket <path>`           | resolved default    | Unix domain socket path                 |
| `--agent-identity <id>`     | —                   | Explicit AgentMon agent identity        |
| `--hook-state-path <path>`  | —                   | Override hook-state file path           |
| `--role <role>`             | `lead`              | `lead`, `subagent`                      |
| `--format <format>`         | `text`              | `text`, `json`, `id`                    |

```bash
agentmonitors session open --host-session-id claude-abc123
```

`--format id` prints just the bare session id — no JSON parsing needed to pull it out of a
verification script.

### `session close`

```bash
agentmonitors session close <sessionId> [options]
```

```bash
agentmonitors session close 01hz3k9x2pabcdefg
```

### `session list`

```bash
agentmonitors session list [options]
```

```bash
agentmonitors session list --format text
```

### `session start` — lazy-boot daemon and register session

```bash
agentmonitors session start
```

No flags. Designed to run as a Claude Code **`SessionStart`** hook: reads its context from the
**hook JSON payload on stdin** (`session_id`, `cwd`) — there is no `CLAUDE_CODE_SESSION_ID`
environment variable. Boots the daemon if none is listening, opens a session, and — on a
compact-resume with unread events — emits the recap `SessionStart` hook JSON.

```bash
printf '{"session_id":"claude-abc123","cwd":"%s","hook_event_name":"SessionStart"}' "$PWD" \
  | agentmonitors session start
```

### `session end` — deregister session

```bash
agentmonitors session end
```

No flags; same stdin hook payload as `session start`. Designed as a **`SessionEnd`** hook
(`hook_event_name: "SessionEnd"`).

```bash
printf '{"session_id":"claude-abc123","cwd":"%s"}' "$PWD" | agentmonitors session end
```

---

## `events` — query or acknowledge runtime events

### `events list`

```bash
agentmonitors events list --session <id> [options]
```

| Flag                    | Default      | Description                                    |
| -------------------------- | -------------- | -------------------------------------------------- |
| `--session <id>`          | required        | AgentMon session id                              |
| `--socket <path>`         | resolved default | Unix domain socket path                          |
| `--monitor <id>`          | —               | Filter by monitor id                             |
| `--urgency <urgency>`     | —               | `low`, `normal`, `high`                          |
| `--tag <tag>`             | `[]`             | Repeatable — `--tag foo --tag bar`                |
| `--scope <pairs>`         | —               | `key=value,key2=value2`                          |
| `--unread`                | —               | Only unread events                               |
| `--since-baseline`        | —               | Only events since the session baseline           |
| `--format <format>`       | auto-detect      | `toon`, `json`, `text`                           |

```bash
agentmonitors events list --session 01hz3k9x2pabcdefg --unread
```

### `events ack`

```bash
agentmonitors events ack --session <id> [options]
```

| Flag                  | Default          | Description                                       |
| ----------------------- | ----------------- | ---------------------------------------------------- |
| `--session <id>`       | required            | AgentMon session id                                |
| `--socket <path>`      | resolved default     | Unix domain socket path                             |
| `--event-ids <ids>`    | —                    | Comma-separated event ids; omit to ack all unread   |

```bash
agentmonitors events ack --session 01hz3k9x2pabcdefg
```

No `--format` flag — errors always go to stderr.

---

## `hook` — claim hook-delivery payloads

### `hook claim`

```bash
agentmonitors hook claim --session <id> --lifecycle <lifecycle> [options]
```

| Flag                       | Default          | Description                                                 |
| ------------------------------ | ----------------- | ----------------------------------------------------------------- |
| `--session <id>`              | required            | AgentMon session id                                              |
| `--lifecycle <lifecycle>`     | required            | `turn-interruptible`, `turn-idle`, `post-compact`               |
| `--socket <path>`             | resolved default     | Unix domain socket path                                          |
| `--format <format>`           | **`json`**           | `text`, `json` — the only command whose default is `json`       |

```bash
agentmonitors hook claim --session 01hz3k9x2pabcdefg --lifecycle turn-interruptible
```

### `hook deliver`

```bash
agentmonitors hook deliver [--lifecycle <lifecycle>] [--format <format>] [--socket <path>] [--debug]
```

| Flag                       | Default            | Description                                                                |
| ------------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| `--lifecycle <lifecycle>`     | derived from payload   | Optional override: `turn-interruptible`, `turn-idle`, `post-compact`            |
| `--format <format>`           | hook wire JSON         | `json` emits compact Claude Code hook JSON; `text` emits only `additionalContext` |
| `--socket <path>`             | from `.local.md`       | Override daemon socket path                                                     |
| `--debug`                     | `false`                | Write a step-by-step diagnosis to **stderr**; stdout is byte-identical to a non-`--debug` run |

```bash
printf '{"session_id":"claude-abc123","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver
```

Designed to run as a Claude Code lifecycle hook. Reads the hook payload as JSON on **stdin**
(never env vars). **Always exits 0** — an internal error is swallowed rather than blocking the
agent's turn. See [Troubleshooting](/docs/troubleshooting) ("It fired but my agent wasn't told")
for how to interpret its output.

**Diagnosing empty output:** run the same payload with `--debug` appended. Empty stdout + exit 0
means either nothing is pending or the invocation is misconfigured — indistinguishable without
`--debug`, which writes the difference to stderr (session resolution, workspace/socket state,
pending-event counts by urgency, and *why* anything isn't deliverable yet: `settle-window`,
`already-claimed`, `coalesced-until-ack`, or `deferred-by-cap`). Stdout never changes:

```bash
printf '{"session_id":"claude-abc123","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" \
  | agentmonitors hook deliver --debug
```

---

## `channel` — Claude Code channel server

### `channel serve`

```bash
agentmonitors channel serve [--socket <path>] [--poll-ms <ms>] [--host-session-id <id>] [--workspace <path>]
```

| Flag                       | Default                    | Description                                |
| ------------------------------ | ---------------------------- | ------------------------------------------------ |
| `--socket <path>`             | resolved default               | Daemon Unix domain socket path                   |
| `--poll-ms <ms>`              | `3000`                         | Delivery poll interval in milliseconds           |
| `--host-session-id <id>`      | `$CLAUDE_CODE_SESSION_ID`      | Host session id                                  |
| `--workspace <path>`          | `$CLAUDE_PROJECT_DIR`          | Workspace path                                   |

```bash
agentmonitors channel serve
```

Runs AgentMon as an MCP server over stdio, pushing pending turn-interruptible deliveries into the
session and exposing an `agentmon_ack` tool. No `--format` flag — the stdio channel is the
transport; stdout carries only the MCP JSON-RPC frames (no human-readable output). Intended to be spawned by Claude Code via a channel
plugin, not run by hand. See
[Agent integration & delivery](/docs/agent-integration) for the hooks-only vs. MCP tradeoffs.

---

## Planned: agent-facing verbs (not yet shipped)

Spec 005 §14 defines five read-only/declaration-only verbs — `snapshot`, `diff`, `summary`,
`watch`, `inspect` — that let an agent pull a stored snapshot, diff two points in time, get a
cheap orientation summary, declare an ephemeral session-scoped monitor, or inspect
received/pending/armed signal state, all without an extra source observation. **None of these
exist in the CLI today** — the commands above are the complete, currently-installed surface. See
[005-cli-reference.md](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/005-cli-reference.md)
§14 and [spec 007](https://github.com/mike-north/AgentMonitors/blob/main/docs/specs/007-agent-facing-interaction.md)
for the full target contract.

---

## Exit codes

| Condition                           | Exit code | Output target                                        |
| -------------------------------------- | ----------- | -------------------------------------------------------- |
| Success                               | `0`          | —                                                        |
| Validation/argument error             | `1`          | stderr (text) or stdout (`{ "error": "..." }` in JSON) |
| Daemon socket unavailable / timeout   | `1`          | stderr                                                   |
| Unknown source / parse failure        | `1`          | stderr or JSON error                                     |
| Placeholder command invoked           | `1`          | stderr                                                   |

`hook deliver` is the one exception — it **always** exits `0` so a delivery-check failure can
never block a Claude Code tool call. All other commands set `process.exitCode = 1` rather than
calling `process.exit(1)`, so in-flight async work and cleanup handlers still complete. The daemon
socket timeout is 2000 ms (`callDaemon()`); the reachability ping (`doctor`'s
`daemon-reachable` check, `daemon status`) uses 500 ms.

## Next steps

- [Getting Started](/docs/getting-started) — install, scaffold, validate, and run your first tick
- [Troubleshooting](/docs/troubleshooting) — symptom-first fixes when a monitor doesn't fire or
  doesn't notify
- [Agent integration & delivery](/docs/agent-integration) — how hooks and the optional MCP channel
  deliver into a session
- [Authoring monitors](/docs/authoring-monitors) — all sources, urgency levels, notify strategies

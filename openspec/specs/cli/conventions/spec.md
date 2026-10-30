# cli/conventions Specification

## Purpose

Cross-command conventions of the `agentmonitors` CLI: binary identity and version, output formats
and their auto-detection, in-process versus daemon-socket transport, socket and database path
resolution, error routing, exit codes, client-side daemon timeouts, and the command inventory.
Daemon socket protocol semantics live in the `daemon/ipc` capability; individual command surfaces
live in the other `cli/*` capabilities.

## Requirements

### Requirement: Binary identity and runtime-derived version

The CLI binary SHALL be named `agentmonitors` and described as "Durable observation and inbox delivery for AI agents". `--version` MUST report the version read at runtime from the CLI package's own `package.json`; it MUST NOT be a hardcoded literal.

#### Scenario: --version tracks the published package

- **WHEN** a user runs `agentmonitors --version`
- **THEN** the printed value equals the `version` field of the `@agentmonitors/cli` `package.json` that is installed
- **AND** no specific version literal is compiled into the command definition

### Requirement: CLI behavior derives from core contracts

Per AP6, all public CLI behavior SHALL be derivable from core contracts: the CLI wraps `@agentmonitors/core` and the five bundled source packages `@agentmonitors/source-file-fingerprint`, `@agentmonitors/source-api-poll`, `@agentmonitors/source-command-poll`, `@agentmonitors/source-schedule`, and `@agentmonitors/source-incoming-changes`, and MUST NOT invent behavior the core does not define.

#### Scenario: Bundled sources are the registered sources

- **WHEN** any command builds its source registry
- **THEN** it registers exactly `file-fingerprint`, `api-poll`, `command-poll`, `schedule`, and `incoming-changes` from the bundled packages

### Requirement: Structured-output commands accept three formats

Only the structured-output commands `events list`, `scan`, `monitor history`, `monitor explain`, and `source list` SHALL accept `--format <toon|json|text>`: `toon` is TOON (Token-Oriented Object Notation) via `@toon-format/toon` `encode()`, a compact encoding of the JSON data model for agent context windows; `json` is `JSON.stringify(value, null, 2)`; `text` is human-readable plain text (columnar tables, one record per line).

#### Scenario: Explicit toon

- **WHEN** a user runs `agentmonitors scan --format toon`
- **THEN** stdout is the TOON encoding of the same value `--format json` would print

#### Scenario: Unknown format value is rejected

- **WHEN** a user runs `agentmonitors scan --format yaml`
- **THEN** the command fails with a CLI argument error naming the allowed choices and exits non-zero

### Requirement: Other commands offer text and json only

Every other `--format` flag SHALL accept only `text` and `json` (no `toon`, no auto-detection): `validate`, `doctor`, `verify`, `monitor test`, `daemon once`, `daemon status`, `session close`/`list`, `inbox list`, `hook claim`, `hook deliver`, `watch declare`/`list`/`cancel`. Default is `text`, except `hook claim` (`json`) and `hook deliver` (hook wire JSON); `session open` adds `id`. Output shapes are per each command's capability.

#### Scenario: watch rejects toon

- **WHEN** a user runs `agentmonitors watch list --session s1 --format toon`
- **THEN** the command fails with a CLI argument error naming the allowed choices `text`, `json` and exits non-zero

#### Scenario: No agent auto-detection outside structured-output commands

- **GIVEN** `CLAUDECODE=1` is set
- **WHEN** a user runs `agentmonitors doctor` with no `--format`
- **THEN** the output is the text rendering, not TOON

### Requirement: Output format auto-detection

When `--format` is omitted on a structured-output command, the CLI SHALL select `toon` if an agentic TUI is detected (via `is-agentic-tui`, which inspects environment variables such as `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, `CURSOR_AGENT=1`, `GEMINI_CLI=1`) and `text` for an interactive human terminal. An explicit `--format` MUST always win and bypass detection.

#### Scenario: Agent environment defaults to toon

- **GIVEN** `CLAUDECODE=1` is set in the environment
- **WHEN** a user runs `agentmonitors source list` with no `--format`
- **THEN** the output is TOON

#### Scenario: Human terminal defaults to text

- **GIVEN** no agentic-TUI environment variable is set
- **WHEN** a user runs `agentmonitors source list` with no `--format`
- **THEN** the output is the human-readable text rendering

#### Scenario: Explicit flag wins over detection

- **GIVEN** `CLAUDECODE=1` is set
- **WHEN** a user runs `agentmonitors scan --format json`
- **THEN** the output is JSON, not TOON

### Requirement: JSON output is byte-for-byte stable

`--format json` output SHALL be byte-for-byte identical to the pre-TOON behavior for every command; TOON support MUST be purely additive from a JSON consumer's perspective.

#### Scenario: Existing JSON consumers are unaffected

- **WHEN** a script runs a structured-output command with `--format json`
- **THEN** it receives `JSON.stringify(value, null, 2)` of the command's data model, unchanged by the existence of the `toon` format

### Requirement: TOON is a terminal rendering transform only

TOON SHALL be used only to render command output to the terminal. Durable storage (SQLite `monitor_events`, snapshots, source state, hook-state files) and the daemon IPC wire MUST remain JSON.

#### Scenario: Persisted state stays JSON under an agent

- **GIVEN** a command runs with TOON auto-selected
- **WHEN** it reads or writes durable state or talks to the daemon
- **THEN** the stored rows and the IPC messages are JSON

### Requirement: TOON round-trips losslessly

For every structured-output command, decoding the TOON output SHALL yield a value equal to the command's JSON output value (`decode(encode(value))` equals the original JSON value), and tests MUST assert this property for each structured-output command.

#### Scenario: Round-trip equality

- **WHEN** a structured-output command's `--format toon` output is decoded with `@toon-format/toon`
- **THEN** the decoded value deep-equals the parsed `--format json` output for the same inputs

### Requirement: In-process commands need no daemon

The commands `init`, `validate`, `scan`, `monitor test`, `source list`, `schema generate`, `inbox *`, and `daemon once` SHALL operate directly on the filesystem and/or the SQLite database and MUST NOT require a daemon socket.

#### Scenario: validate with no daemon running

- **GIVEN** no daemon is running
- **WHEN** a user runs `agentmonitors validate`
- **THEN** the command completes without contacting any socket

### Requirement: Daemon-socket commands

The commands `daemon run` (which serves the socket), `daemon status`, `daemon stop`, `session open/close/list`, `events list/ack`, `hook claim`, `hook deliver`, `monitor history`, and `monitor explain` SHALL communicate with the daemon over its Unix domain socket using the request/response protocol defined by the `daemon/ipc` capability.

#### Scenario: daemon stop uses the socket

- **WHEN** a user runs `agentmonitors daemon stop`
- **THEN** the CLI sends a `stop` request over the resolved daemon socket

### Requirement: daemon once runs in-process

Although it lives under the `daemon` group, `daemon once` SHALL run a single runtime tick in-process against the resolved database and MUST NOT contact the daemon socket.

#### Scenario: daemon once with no daemon

- **GIVEN** no daemon is listening on any socket
- **WHEN** a user runs `agentmonitors daemon once`
- **THEN** one tick runs in-process and its result is printed

### Requirement: Read-only diagnosis falls back in-process

`monitor history` and `monitor explain` SHALL be socket-first, but on a genuine daemon connection failure (socket refused/absent or request timeout) they MUST fall back to reading the persisted SQLite store in-process (#150), as specified by the `cli/monitor-commands` capability.

#### Scenario: explain after daemon once with no daemon

- **GIVEN** `daemon once` has run and no daemon is running
- **WHEN** a user runs `agentmonitors monitor explain <id>`
- **THEN** the diagnosis is computed from the persisted store instead of failing on the missing socket

### Requirement: Base socket path resolution

The CLI SHALL resolve the base daemon socket path with the precedence defined by the `daemon/ipc` capability ("Socket path resolution precedence"), supplying the command's `--socket <path>` flag, where the command offers one, as the caller override; the default therefore lands at `~/.local/share/agentmonitors/agentmonitors.sock`.

#### Scenario: Environment override beats the default

- **GIVEN** `AGENTMONITORS_SOCKET=/tmp/am.sock` and no `--socket` flag
- **WHEN** a socket command resolves its socket outside an enabled workspace
- **THEN** it uses `/tmp/am.sock`

#### Scenario: Flag beats the environment

- **GIVEN** `AGENTMONITORS_SOCKET=/tmp/am.sock`
- **WHEN** a user passes `--socket /tmp/other.sock`
- **THEN** the command uses `/tmp/other.sock`

### Requirement: Over-long socket paths fall back to a short path

An over-long resolved socket path SHALL be replaced by the hashed fallback, with the length limit, per-uid directory, legacy probe, and which candidates are announced all defined by the `daemon/ipc` capability. When that capability calls for an announcement (a literal `--socket` value), the CLI MUST write it to stderr in exactly the form given in this requirement's scenario.

#### Scenario: Explicit long --socket warns

- **WHEN** a user passes a `--socket` value of 120 characters
- **THEN** stderr carries `Warning: --socket path "<path>" is 120 characters, which exceeds the 100-character AF_UNIX socket path limit. Falling back to <substitute>.`
- **AND** the command uses the substitute path

### Requirement: Manual daemon commands discover the workspace socket

The manual daemon commands `session open`, `session close`, `session list`, `events list`, `events ack`, `hook claim`, `doctor`, `daemon status`, `daemon stop`, `monitor history`, and `monitor explain` SHALL insert the enabled workspace's socket between base steps 2 and 3: with no `--socket` and no `AGENTMONITORS_SOCKET`, an enabled workspace's socket is used; outside an enabled workspace the global default (step 3) is unchanged.

#### Scenario: Flagless command reaches the workspace daemon

- **GIVEN** `.claude/agentmonitors.local.md` in the cwd has `enabled: true` and a daemon is listening on that workspace's socket
- **WHEN** a user runs `agentmonitors daemon status` with no flags
- **THEN** it reports that daemon as running

#### Scenario: Not-enabled workspace uses the global default

- **GIVEN** the cwd has no `.claude/agentmonitors.local.md`
- **WHEN** a user runs `agentmonitors session list`
- **THEN** it resolves the global default socket

### Requirement: Command workspace selection for socket discovery

For workspace socket discovery the command workspace SHALL be `--workspace` for `session open`, `doctor`, `monitor explain`, and `monitor history`; otherwise `CLAUDE_PROJECT_DIR` when set, then the process cwd. The command MUST read `.claude/agentmonitors.local.md` from that workspace.

#### Scenario: CLAUDE_PROJECT_DIR selects the workspace

- **GIVEN** `CLAUDE_PROJECT_DIR=/repo` and the process cwd is `/repo/sub`
- **WHEN** `agentmonitors events list` resolves its socket
- **THEN** it reads `/repo/.claude/agentmonitors.local.md`

### Requirement: Persisted or derived workspace socket

In an enabled workspace (`enabled: true`), the command SHALL use the persisted `socket:` value from `.claude/agentmonitors.local.md` when one has been written (e.g. by a lazily booted daemon), and otherwise the derived per-workspace socket `agentmonitors.sock` in the per-workspace data directory defined by the `daemon/ipc` capability ("Per-workspace daemon isolation") (#335).

#### Scenario: Nothing persisted yet

- **GIVEN** an enabled workspace whose local-state file has no `socket:` field
- **WHEN** `agentmonitors monitor history` resolves its socket
- **THEN** it uses the derived per-workspace socket for that workspace

#### Scenario: Persisted socket wins over derivation

- **GIVEN** an enabled workspace whose local-state file has `socket: /tmp/x.sock`
- **WHEN** `agentmonitors session list` resolves its socket
- **THEN** it uses `/tmp/x.sock`

### Requirement: daemon run and daemon once bind the workspace socket and db

With no `--socket`, `AGENTMONITORS_DB`, or `AGENTMONITORS_SOCKET` override, `daemon run` and `daemon once` SHALL resolve their socket and database exactly as the manual daemon commands and `doctor` do, so an enabled workspace binds its persisted-or-derived per-workspace socket and db rather than the global default (#335); the isolation guarantee this serves is owned by the `daemon/ipc` capability.

#### Scenario: Directly invoked daemon agrees with doctor

- **GIVEN** an enabled workspace with no persisted socket or db
- **WHEN** a user runs `agentmonitors daemon run` with no flags and then `agentmonitors doctor` from the same directory
- **THEN** both resolve the same per-workspace socket and db

### Requirement: Unreachable workspace daemon remediation

When `session open`, `session close`, `session list`, `events list`, `events ack`, or `hook claim` cannot reach the resolved socket (a connection failure), the CLI SHALL report the single actionable line `No daemon running for this workspace - start it with \`agentmonitors daemon run\` (or it starts automatically when a Claude Code session opens), then run \`agentmonitors doctor\` for the full workspace-health picture.` and exit non-zero, without a raw connection-error stack trace (#331).

#### Scenario: session list with no daemon

- **GIVEN** no daemon is listening on the resolved socket
- **WHEN** a user runs `agentmonitors session list`
- **THEN** the remediation line is reported and the exit code is 1
- **AND** no `DaemonConnectionError` stack trace is printed

#### Scenario: Daemon-side application errors are not masked

- **GIVEN** the daemon is reachable but answers a request with an error
- **WHEN** one of these commands receives that error
- **THEN** the daemon's error message is surfaced as a normal command error, using the command's JSON error shape where it supports `--format json`

### Requirement: Database path resolution

Workspace-aware commands (`doctor`, `daemon run`, `daemon once`, the `daemon status` in-process fallback, the `monitor history`/`monitor explain` fallbacks, and `session start`'s lazy boot) SHALL resolve the SQLite database as: (1) `AGENTMONITORS_DB`, which wins outright; (2) an enabled workspace's persisted `db:` value, else its derived per-workspace db; (3) for a not-enabled workspace, `~/.local/share/agentmonitors/inbox.db`.

#### Scenario: AGENTMONITORS_DB wins outright

- **GIVEN** `AGENTMONITORS_DB=/tmp/test.db` in an enabled workspace with a persisted `db:`
- **WHEN** `agentmonitors daemon once` runs
- **THEN** it uses `/tmp/test.db`

#### Scenario: Derived per-workspace db

- **GIVEN** an enabled workspace at `/repo` with no persisted `db:` and no `AGENTMONITORS_DB`
- **WHEN** `agentmonitors doctor` resolves its db
- **THEN** it uses `<XDG_DATA_HOME or ~/.local/share>/agentmonitors/workspaces/<hash>/inbox.db`, where `<hash>` is a SHA-256-derived hash of the resolved absolute workspace path

#### Scenario: Not-enabled workspace uses the shared default

- **GIVEN** a workspace with no `enabled: true` and no `AGENTMONITORS_DB`
- **WHEN** `agentmonitors daemon once` runs
- **THEN** it uses `~/.local/share/agentmonitors/inbox.db`

### Requirement: No top-level database flag

The top-level program SHALL NOT expose a `--db` flag; database selection MUST come from `AGENTMONITORS_DB` or workspace resolution only.

#### Scenario: --db is not an option

- **WHEN** a user runs `agentmonitors daemon once --db /tmp/x.db`
- **THEN** the CLI rejects `--db` as an unknown option

### Requirement: Exit code conventions

Commands SHALL exit `0` on success and `1` on: a validation or argument error (stderr in text mode, stdout `{ "error": "..." }` in JSON mode); an unavailable or timed-out daemon socket (stderr); an unknown source or parse failure (stderr or JSON error); and invoking a placeholder command (stderr).

#### Scenario: Placeholder command exits 1

- **WHEN** a user runs `agentmonitors source install some-plugin`
- **THEN** the exit code is 1 and the message is on stderr

#### Scenario: Successful command exits 0

- **WHEN** `agentmonitors validate` finds only valid monitors
- **THEN** the exit code is 0

### Requirement: Error output routing

Every command that supports `--format json` SHALL report errors in JSON mode by writing `{ "error": "<message>" }` to stdout (so JSON consumers read one channel) and in text mode by writing `Error: <message>` to stderr, setting exit code 1 in both cases.

#### Scenario: JSON-mode error goes to stdout

- **WHEN** a user runs `agentmonitors validate /nonexistent --format json`
- **THEN** stdout is `{"error":"path \"/nonexistent\" does not exist"}` and the exit code is 1

#### Scenario: Text-mode error goes to stderr

- **WHEN** a user runs `agentmonitors validate /nonexistent`
- **THEN** stderr carries `Error: path "/nonexistent" does not exist` and the exit code is 1

### Requirement: Failures set the exit code without forcing termination

Commands SHALL signal failure by setting `process.exitCode = 1` rather than calling `process.exit(1)`, so in-flight async operations and Node.js cleanup handlers complete before the process ends. An error escaping a command action MUST be reported as `Error: <message>` on stderr with exit code 1, never as an unhandled rejection.

#### Scenario: Escaping action error

- **WHEN** a command action throws an unexpected error
- **THEN** stderr carries `Error: <message>` and the exit code is 1

### Requirement: Client-side daemon timeouts

A CLI request to the daemon SHALL time out after 2000 ms by default, and the daemon availability ping SHALL time out after 500 ms. On timeout the error message MUST be `Timed out waiting for AgentMon daemon at <socketPath>`, classified as a connection failure (not a daemon-side application error).

#### Scenario: Unresponsive daemon

- **GIVEN** a socket accepts connections but never answers
- **WHEN** a CLI request is sent to it
- **THEN** after 2000 ms the request fails with `Timed out waiting for AgentMon daemon at <socketPath>`

### Requirement: Commands without a JSON error shape

`inbox ack`, `inbox start`, `inbox complete`, `inbox fail`, `inbox archive`, and `events ack` SHALL NOT accept `--format json`; their errors MUST always go to stderr.

#### Scenario: events ack error

- **WHEN** `agentmonitors events ack` fails
- **THEN** the error is written to stderr, never as a JSON object on stdout

### Requirement: Command inventory

The `agentmonitors` binary SHALL register the command groups `init`, `validate`, `scan`, `inbox`, `monitor`, `source`, `schema`, `daemon`, `doctor`, `verify`, `session`, `events`, `hook`, `channel`, and `watch`, with the subcommands and transports given in this requirement's scenarios. `watch` is specified by the `agent/ephemeral-monitors` capability.

#### Scenario: Authoring commands

- **WHEN** the inventory is listed
- **THEN** `init` (bootstrap + scaffold), `validate` (full schema), and `scan` are in-process

#### Scenario: Inbox commands

- **WHEN** the inventory is listed
- **THEN** `inbox list`, `inbox ack`, `inbox start`, `inbox complete`, `inbox fail`, and `inbox archive` are in-process

#### Scenario: Monitor commands

- **WHEN** the inventory is listed
- **THEN** `monitor test` is in-process, and `monitor history` and `monitor explain` use the socket with an in-process fallback

#### Scenario: Source and schema commands

- **WHEN** the inventory is listed
- **THEN** `source list` and `schema generate` are in-process
- **AND** `source search`, `source install`, `source update`, and `source remove` are placeholders (NP3)

#### Scenario: Daemon commands

- **WHEN** the inventory is listed
- **THEN** `daemon once` is in-process, `daemon run` creates the socket server, `daemon status` uses the socket with an in-process fallback, and `daemon stop` uses the socket

#### Scenario: Health and verification commands

- **WHEN** the inventory is listed
- **THEN** `doctor` uses the socket with an in-process fallback, and `verify` uses a supervised isolated daemon (or the workspace daemon under a flag)

#### Scenario: Session, events, hook, and channel commands

- **WHEN** the inventory is listed
- **THEN** `session open`, `session close`, `session list`, `session end`, `events list`, `events ack`, and `hook claim` use the socket; `session start` is in-process plus socket (lazy boot); `hook deliver` uses the socket and always exits 0; `channel serve` is a stdio MCP server plus socket, two-way (push plus `agentmon_ack`)

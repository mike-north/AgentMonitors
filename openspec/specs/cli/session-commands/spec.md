# cli/session-commands Specification

## Purpose

The command surface of `agentmonitors session` (`open`, `close`, `list`, `start`, `end`), `events`
(`list`, `ack`), `hook` (`claim`, `deliver`), and `channel serve`: arguments, flags, defaults, output
shapes, stdout/stderr routing, and exit codes. Delivery, claim/ack, and transport semantics are owned
by the `delivery/*` capabilities and are referenced, not restated, here.

## Requirements

### Requirement: Session commands reach the workspace daemon socket

`session open`, `session close`, `session list`, `events list`, `events ack`, and `hook claim` SHALL round-trip the daemon over its Unix socket and SHALL resolve that socket with the manual-daemon-command precedence (explicit `--socket`, then `AGENTMONITORS_SOCKET`, then an enabled workspace's persisted-or-derived socket, then the global default) and report an unreachable daemon with the single actionable stderr line and non-zero exit, both per the `cli/conventions` capability.

#### Scenario: Unreachable workspace daemon

- **GIVEN** an enabled workspace with no daemon listening on its socket
- **WHEN** the author runs `agentmonitors session list` with no `--socket`
- **THEN** the command writes the single "no daemon is running for this workspace" stderr line defined by `cli/conventions` (naming `agentmonitors daemon run` and `agentmonitors doctor`)
- **AND** exits non-zero without a raw `DaemonConnectionError` stack trace

### Requirement: session open flags

`agentmonitors session open` SHALL accept `--host-session-id <id>` (required), `--workspace <path>` (default: current working directory), `--socket <path>` (default: resolved), `--agent-identity <id>`, `--hook-state-path <path>`, `--role <role>` (choices `lead`, `subagent`; default `lead`), and `--format <format>` (choices `text`, `json`, `id`; default `text`). It SHALL open or resume the session via the `session.open` IPC method using the host adapter's session input.

#### Scenario: Default role is lead

- **WHEN** `agentmonitors session open --host-session-id h1` runs with no `--role`
- **THEN** the opened session record has role `lead`

#### Scenario: Missing host session id

- **WHEN** `agentmonitors session open` runs without `--host-session-id`
- **THEN** it fails with `error: required option '--host-session-id' not specified` and a non-zero exit

#### Scenario: Invalid role choice

- **WHEN** `agentmonitors session open --host-session-id h1 --role observer` runs
- **THEN** the command rejects the value as not one of `lead`, `subagent` and exits non-zero

### Requirement: session open resolves the workspace to an absolute path

`session open` SHALL resolve `--workspace` to an absolute path before sending it, the same way `doctor`, `daemon once`, and `daemon run` resolve theirs (#335), so a relative or trailing-slash value cannot fail `doctor`'s exact-string workspace match.

#### Scenario: Relative workspace value

- **GIVEN** the process cwd is `/repo`
- **WHEN** `agentmonitors session open --host-session-id h1 --workspace ./ --format json` runs
- **THEN** the returned record's `workspacePath` is `/repo`

### Requirement: session open output formats

`session open --format text` SHALL print exactly three lines: `Opened session: <session.id>`, `Agent identity: <session.agentIdentity>`, `Hook state: <session.hookStatePath>`. `--format json` SHALL print the full `AgentSessionRecord`. `--format id` SHALL print only `<session.id>` with no surrounding text and no JSON envelope (#338 item 4).

#### Scenario: Bare session id output

- **WHEN** `agentmonitors session open --host-session-id h1 --format id` runs
- **THEN** stdout is exactly the session id
- **AND** it equals the `id` field printed by `--format json` for the same host session

#### Scenario: Capturing the id in a recipe

- **WHEN** a script runs `AGENTMON_SESSION_ID=$(agentmonitors session open --host-session-id "$HOST_ID" --format id)`
- **THEN** the variable holds the AgentMon session id with no JSON parsing step

### Requirement: session close command

`agentmonitors session close <sessionId>` SHALL take the AgentMon session id as a required positional argument, accept `--socket <path>` and `--format <format>` (choices `text`, `json`; default `text`), and mark the session dormant via the `session.close` IPC method. Text output SHALL be `Closed session: <session.id>`; JSON output SHALL be the full `AgentSessionRecord`.

#### Scenario: Closing a session

- **GIVEN** an active session `s1`
- **WHEN** `agentmonitors session close s1 --format json` runs
- **THEN** stdout is the `AgentSessionRecord` for `s1` with status `dormant`
- **AND** a following `session list --format json` reports `s1` as `dormant`

### Requirement: session list command

`agentmonitors session list` SHALL accept `--socket <path>` and `--format <format>` (choices `text`, `json`; default `text`). Text output SHALL be one line per session, `<id>  <status>  <agentIdentity>  <workspacePath>`, with `(global)` in place of an absent workspace path. JSON output SHALL be an `AgentSessionRecord[]` array.

#### Scenario: Session without a workspace

- **GIVEN** a session record with no `workspacePath`
- **WHEN** `agentmonitors session list` runs in text format
- **THEN** that session's line ends with `(global)`

#### Scenario: Session records reflected

- **GIVEN** a session opened with `session open`
- **WHEN** `agentmonitors session list --format json` runs
- **THEN** the array contains that session's record with its id, status, agent identity, and workspace

### Requirement: session start reads the hook payload from stdin

`agentmonitors session start` SHALL take no flags and SHALL read its context only from the Claude Code hook JSON payload on stdin (never from a session-id environment variable). A TTY or empty/unparseable stdin SHALL be treated as `{}`. `session_id` is the host session id; the workspace SHALL be `cwd`, else `CLAUDE_PROJECT_DIR`, else the process cwd.

#### Scenario: No session_id is a quiet no-op

- **WHEN** `session start` receives `{}` on stdin
- **THEN** it writes nothing to stdout or stderr and exits 0

#### Scenario: Workspace falls back to CLAUDE_PROJECT_DIR

- **GIVEN** a payload `{"session_id":"h1"}` with no `cwd` and `CLAUDE_PROJECT_DIR=/repo`
- **WHEN** `session start` runs
- **THEN** it reads `/repo/.claude/agentmonitors.local.md`

### Requirement: session start quick-exits outside an enabled workspace

`session start` SHALL exit 0, without booting a daemon or opening a session (per the `daemon/ipc` capability), when `.claude/agentmonitors.local.md` is absent from the workspace or its `enabled` is unset or `false`. stderr SHALL stay empty; stdout SHALL be empty unless `.claude/monitors` holds monitor definitions, in which case it carries only the monitoring-disabled advisory defined by the `delivery/hook-transport` capability (#269).

#### Scenario: Disabled workspace

- **GIVEN** `.claude/agentmonitors.local.md` with `enabled: false` and no definitions under `.claude/monitors`
- **WHEN** `session start` receives `{"session_id":"h1","cwd":"<workspace>"}`
- **THEN** no daemon is spawned, no session is opened, both streams are empty, and the exit code is 0

#### Scenario: Disabled workspace with unwatched monitors

- **GIVEN** `.claude/agentmonitors.local.md` with `enabled: false` and one monitor definition under `.claude/monitors`
- **WHEN** `session start` receives `{"session_id":"h1","cwd":"<workspace>"}`
- **THEN** stdout is the `SessionStart` hook JSON carrying the monitoring-disabled advisory, stderr is empty, no daemon is spawned, and the exit code is 0

### Requirement: session start lazily boots the workspace daemon

`session start` SHALL derive the per-workspace socket and db paths (overridden by `socket`/`db` in the local state file) and, when no daemon is listening there, lazily boot `daemon run` with those paths, the monitors dir, and the local state's `reap-after-ms`, using the detached-spawn and boot-wait contract of the `daemon/ipc` capability ("Lazy daemon boot from session start").

#### Scenario: Daemon already running

- **GIVEN** a daemon already listening on the workspace socket
- **WHEN** `session start` runs for an enabled workspace
- **THEN** no new daemon process is spawned

#### Scenario: Boot timeout

- **GIVEN** the spawned daemon does not listen within the `daemon/ipc` boot wait (8 seconds)
- **WHEN** `session start` runs
- **THEN** it records `lastBootFailureAt` in `.claude/agentmonitors.local.md`, reports the failure on stderr, and exits non-zero

### Requirement: session start persists resolved paths

After the daemon is available, `session start` SHALL persist the resolved socket and db paths to `.claude/agentmonitors.local.md` so sibling hooks reuse them without re-deriving, and SHALL clear any `lastBootFailureAt` marker left by an earlier failed boot.

#### Scenario: Paths written back

- **GIVEN** an enabled workspace whose local state has no `socket:` entry
- **WHEN** `session start` boots the daemon successfully
- **THEN** `.claude/agentmonitors.local.md` contains the resolved `socket:` and `db:` values and no `lastBootFailureAt`

### Requirement: session start registers the session

`session start` SHALL open the session via the `session.open` IPC method, using the host adapter's session input with the payload's `session_id` as `hostSessionId` and the resolved workspace as `workspacePath`.

#### Scenario: Registration through the plugin hook

- **WHEN** `session start` receives `{"session_id":"h1","cwd":"/repo"}` for an enabled workspace
- **THEN** `agentmonitors session list` shows a session with `hostSessionId` `h1` and workspace `/repo`

### Requirement: session start surfaces the post-compact recap in-process

Because a hook invocation has one stdin stream, `session start` SHALL itself reserve the `post-compact` delivery for the session, render it, and, only if unread events exist, write the `SessionStart` hook JSON to stdout, using the same reserve → render → write → commit ordering as `hook deliver` per the `delivery/hook-transport` capability. Candidate rows SHALL come from the session's unread events, including already-claimed ones.

#### Scenario: Compact-resume with unread events

- **GIVEN** a registered session with unread events
- **WHEN** `session start` runs for that session
- **THEN** stdout is `{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` whose `additionalContext` carries the unread events' bodies

#### Scenario: Fresh start with nothing unread

- **WHEN** `session start` registers a session that has no unread events
- **THEN** stdout is empty

### Requirement: session start commits the recap only after the write completes

`session start` SHALL await the stdout write's actual completion before committing the recap reservation. A write failure, including an asynchronous `EPIPE` after a synchronous success signal, SHALL release the reservation: no new claim is applied and the recap cursor does not advance, but rows already claimed by an earlier delivery stay claimed, and every reserved row stays unread.

#### Scenario: Asynchronous EPIPE on the recap write

- **GIVEN** a reservation containing one previously claimed row and one never-claimed row
- **WHEN** the recap write fails asynchronously with `EPIPE`
- **THEN** the reservation is released, not committed
- **AND** the previously claimed row is still claimed, the never-claimed row is still pending, and both remain unread and eligible for a future recap

### Requirement: session start keeps stdout wire-clean and acknowledges on stderr

`session start` is the only `session` subcommand that emits hook-wire JSON, so its stdout SHALL contain only that JSON. On a successful registration it SHALL write the one-line ack `AgentMon: session <id> registered; daemon at <socket>` to stderr (#420 P3); it SHALL NOT write the ack on the quick-exit paths (no `session_id`, monitoring not enabled).

#### Scenario: Registration ack on stderr

- **WHEN** `session start` registers session `s1` against socket `/tmp/a.sock`
- **THEN** stderr contains `AgentMon: session s1 registered; daemon at /tmp/a.sock`
- **AND** stdout contains no non-JSON text

### Requirement: session start exit codes

The `session start` command SHALL exit 0 on a quick-exit and on success (with or without recap output). A genuine failure — the daemon not starting within the boot timeout, or a `session.open`/reserve/commit/write error — SHALL be reported to stderr with exit code 1.

#### Scenario: session.open failure

- **GIVEN** the daemon is reachable but rejects `session.open`
- **WHEN** `session start` runs for an enabled workspace
- **THEN** the error is written to stderr and the exit code is 1

### Requirement: session end deregisters the host session

`agentmonitors session end` SHALL take no flags and read the same stdin payload as `session start` (`session_id`, `cwd`; not environment variables). It SHALL find the session whose `hostSessionId` equals `session_id` via `session.list` and close it via `session.close`. It SHALL return silently when `session_id` is absent, the workspace is not enabled or has no `socket` field, the daemon is unreachable, or no session matches.

#### Scenario: Matching session closed

- **GIVEN** a registered session for host session `h1`
- **WHEN** `session end` receives `{"session_id":"h1","cwd":"<workspace>"}`
- **THEN** that session becomes `dormant`

#### Scenario: Unreachable daemon

- **WHEN** `session end` runs for an enabled workspace whose daemon is down
- **THEN** both streams are empty and the exit code is 0

### Requirement: session end output

`session end` SHALL never write to stdout. On a successful close it SHALL write `AgentMon: session <id> ended` to stderr (#420 P3); every quiet-return path SHALL be silent on both streams. Once all of a workspace's sessions are closed, the daemon's idle reaper stops it within `reap-after-ms` per the `cli/daemon-commands` capability.

#### Scenario: End ack on stderr

- **WHEN** `session end` closes session `s1`
- **THEN** stdout is empty and stderr is `AgentMon: session s1 ended`

### Requirement: events list flags

`agentmonitors events list` SHALL accept `--session <id>` (required), `--socket <path>`, `--monitor <id>`, `--urgency <urgency>` (choices `low`, `normal`, `high`), `--tag <tag>` (repeatable; default `[]`), `--scope <pairs>`, `--unread`, `--since-baseline`, and `--format <format>` (choices `toon`, `json`, `text`; default auto-detected per the `cli/conventions` capability).

#### Scenario: Invalid urgency filter

- **WHEN** `agentmonitors events list --session s1 --urgency urgent` runs
- **THEN** the command rejects the value and exits non-zero

#### Scenario: Since-baseline filter

- **WHEN** `agentmonitors events list --session s1 --since-baseline` runs
- **THEN** only events since that session's baseline are returned

### Requirement: events commands point at session discovery

`events list` and `events ack` SHALL keep `--session` required. When it is missing they SHALL keep the default `error: required option '--session <id>' not specified` line and non-zero exit and append a second stderr line `Run \`agentmonitors session list\` to find a session id.`(#420 P2); the same pointer SHALL appear in each subcommand's`--help` trailing text.

#### Scenario: Missing --session

- **WHEN** `agentmonitors events list` runs with no `--session`
- **THEN** stderr contains the commander `required option '--session <id>'` error followed by `Run \`agentmonitors session list\` to find a session id.`
- **AND** the exit code is non-zero

### Requirement: events help names the session requirement

`events --help` SHALL name the requirement in each subcommand summary — `List events for a session (requires --session <id>)` and `Acknowledge one or more events for a session (requires --session <id>)` — and the `--session` option description SHALL end with `(required)` (#389 P3).

#### Scenario: Help text

- **WHEN** `agentmonitors events --help` runs
- **THEN** both subcommand summaries contain `requires --session <id>`

### Requirement: events list --unread selects unacknowledged events

`--unread` SHALL return the session's unacknowledged events (`acknowledgedAt IS NULL`), which includes events already claimed at a delivery lifecycle but not yet acknowledged; it does not mean "never surfaced" (#338 item 1). Delivery-state semantics are per the `delivery/session-projection` capability.

#### Scenario: Claimed but unacknowledged event

- **GIVEN** an event claimed by `hook claim` but not acknowledged
- **WHEN** `events list --session s1 --unread --format json` runs
- **THEN** the event is returned with `deliveryState` `claimed`

### Requirement: events list reports per-session delivery state

JSON output SHALL be a `MonitorEventRecord[]` array whose elements carry `deliveryState` (`unread`, `claimed`, or `acknowledged`) for the requesting session. TOON output SHALL encode the same array with `@toon-format/toon` `encode()` and decode losslessly to the JSON value.

#### Scenario: Unread to claimed to acknowledged

- **GIVEN** a session with one materialized event
- **WHEN** `events list --format json` runs before any claim, after `hook claim`, and after `events ack`
- **THEN** that event's `deliveryState` reads `unread`, then `claimed`, then `acknowledged`

#### Scenario: TOON round-trip

- **WHEN** `events list --session s1 --format toon` runs
- **THEN** decoding its stdout yields a value equal to the `--format json` array

### Requirement: events list text rows

`--format text` SHALL print one line per event, `<id>  <monitorId>  <urgency>  <deliveryState>  <title>`, appending `  <summary>` only when the event's `summary` differs from its `title`. The suffix SHALL NOT be suppressed when `summary` equals `body`, because the text row never renders `body`.

#### Scenario: Multi-object rows stay distinguishable

- **GIVEN** two events from one file-fingerprint monitor with the same `title` and summaries naming different files
- **WHEN** `events list --format text` runs
- **THEN** each row ends with its own file summary

#### Scenario: Summary equal to title

- **GIVEN** an event whose `summary` equals its `title`
- **WHEN** `events list --format text` runs
- **THEN** the row has no summary suffix

#### Scenario: Summary equal to body

- **GIVEN** an event with only `title` and `body`, where `summary` equals `body` and differs from `title`
- **WHEN** `events list --format text` runs
- **THEN** the row still ends with the summary

### Requirement: events list text rows are control-safe

Every human-text field interpolated into a text row (`monitorId`, `title`, the summary suffix) SHALL pass through a single-line transform: CR, LF, U+2028, and U+2029 collapse to a single space; every other C0/C1 control character, DEL, and TAB is escaped to a visible `\uXXXX` form. `--format json` and `--format toon` SHALL NOT apply this transform.

#### Scenario: Hostile title cannot forge a row

- **GIVEN** an event whose `title` is `ok\nfake-row` and whose summary contains `\u001b[31m`
- **WHEN** `events list --format text` runs
- **THEN** the event renders on one physical line with `ok fake-row`
- **AND** the escape character appears as the visible text `\u001b`

### Requirement: events list scope and tag filters

`--scope` SHALL be split on `,`, each segment split on `=` into a `Record<string, string>`; segments that do not parse as `key=value` SHALL be silently dropped. `--tag` SHALL accumulate across repetitions, and multiple tags SHALL filter for events carrying all of them.

#### Scenario: Malformed scope segment dropped

- **WHEN** `events list --session s1 --scope repo=a,garbage,branch=main` runs
- **THEN** the scope filter is `{ "repo": "a", "branch": "main" }`

#### Scenario: Repeated tags

- **WHEN** `events list --session s1 --tag foo --tag bar` runs
- **THEN** only events tagged with both `foo` and `bar` are returned

### Requirement: events ack command

`agentmonitors events ack` SHALL accept `--session <id>` (required), `--socket <path>`, and `--event-ids <ids>` (comma-separated; values trimmed, empty entries ignored). It SHALL have no `--format` flag, print `Acknowledged events.` on success, and write errors to stderr.

#### Scenario: Acknowledge specific events

- **WHEN** `events ack --session s1 --event-ids e1,e2` runs
- **THEN** `e1` and `e2` become acknowledged for `s1` and stdout is `Acknowledged events.`

### Requirement: events ack without ids skips reserved rows

Omitting `--event-ids` SHALL acknowledge every unread row for the session except rows held by outstanding delivery reservations (#300), per the `delivery/session-projection` capability. Diagnostic surfaces (`monitor explain`, `hook deliver --debug`) SHALL report such rows as `reserved-in-flight`, never `already-claimed`, and SHALL NOT recommend `events ack` for them.

#### Scenario: Channel push in flight

- **GIVEN** event `e1` leased by an in-flight channel push and unread event `e2`
- **WHEN** `events ack --session s1` runs with no `--event-ids`
- **THEN** `e2` is acknowledged and `e1` stays unread
- **AND** `e1` becomes eligible for a later no-ids ack once its reservation resolves

### Requirement: hook claim command

`agentmonitors hook claim` SHALL accept `--session <id>` (required), `--socket <path>`, `--lifecycle <lifecycle>` (required; choices `turn-interruptible`, `turn-idle`, `post-compact`), and `--format <format>` (choices `text`, `json`; default `json`, unique among commands). It SHALL claim via the `hook.claim` IPC method per the `delivery/session-projection` capability.

#### Scenario: Lifecycle-appropriate payload

- **GIVEN** a settled high-urgency event for session `s1`
- **WHEN** `hook claim --session s1 --lifecycle turn-interruptible` runs
- **THEN** stdout is a JSON `DeliveryClaim` carrying that event

#### Scenario: Missing lifecycle

- **WHEN** `hook claim --session s1` runs without `--lifecycle`
- **THEN** the command fails with a required-option error and a non-zero exit

### Requirement: hook claim output

JSON output SHALL be the `DeliveryClaim` object, or `null` when nothing is pending. Text output SHALL be `No pending delivery.` when nothing is pending, else `claim.message` verbatim — the runtime's unattributed semantic body with no transport attribution, since `hook claim` is a diagnostic view, not a delivery surface.

#### Scenario: Nothing pending

- **WHEN** `hook claim --session s1 --lifecycle turn-idle` runs with nothing pending
- **THEN** stdout is `null`

#### Scenario: Text view is unattributed

- **GIVEN** a pending normal-urgency reminder claim
- **WHEN** `hook claim --session s1 --lifecycle turn-interruptible --format text` runs
- **THEN** stdout is the claim's `message` without an `AgentMon: ` prefix

### Requirement: hook deliver flags

`agentmonitors hook deliver` SHALL accept `--lifecycle <lifecycle>` (optional override; choices `turn-interruptible`, `turn-idle`, `post-compact`; otherwise derived from the payload's `hook_event_name`), `--format <format>` (choices `text`, `json`; default hook wire JSON), `--socket <path>` (default: the `socket:` in `.claude/agentmonitors.local.md`), and `--debug` (default off). It SHALL read its payload as JSON on stdin and run the delivery behavior of the `delivery/hook-transport` capability.

#### Scenario: Same command line on every event

- **GIVEN** the plugin wires `agentmonitors hook deliver` with no flags
- **WHEN** it fires on `UserPromptSubmit` and on `SessionStart`
- **THEN** the lifecycle is derived from each payload's `hook_event_name`

### Requirement: hook deliver output formats

When something is pending, the default format and `--format json` SHALL write the compact (`JSON.stringify`) hook wire object defined by the `delivery/hook-transport` capability; `--format text` SHALL write only `hookSpecificOutput.additionalContext`, for manual inspection. When nothing is pending, or the workspace/session is not configured, stdout SHALL be empty in every format.

#### Scenario: Text format for inspection

- **GIVEN** a pending high-urgency settled event
- **WHEN** `hook deliver --format text` runs with a matching payload
- **THEN** stdout is the rendered `additionalContext` with no JSON wrapper

#### Scenario: Reminder-only output is not silent

- **GIVEN** only a pending `normal`-urgency change at a derived `turn-interruptible` lifecycle
- **WHEN** `hook deliver` runs
- **THEN** stdout is hook JSON whose `additionalContext` is `AgentMon: ` followed by the claim's reminder `message` naming the `events list` and `events ack` commands

### Requirement: hook deliver always exits 0

`hook deliver` SHALL exit 0 in every case, swallowing internal errors on stdout, because a hook that exits non-zero can block tool calls.

#### Scenario: Daemon unreachable

- **WHEN** `hook deliver` runs (without `--debug`) for an enabled workspace whose persisted socket has no daemon listening
- **THEN** stdout and stderr are both empty and the exit code is 0

### Requirement: hook deliver always-on stderr diagnostics

Without `--debug`, `hook deliver` SHALL write exactly one stderr line on each of four branches that cannot resolve on their own, leaving stdout and the exit code unchanged: no `session_id` (#420 P1), an unmapped `hook_event_name` (#420 P1), an enabled workspace with no explicit socket (#389 P2), and no registered session for the `session_id` (#329). Every other quiet-return branch SHALL stay silent by default.

#### Scenario: Malformed payload

- **WHEN** `hook deliver` receives `{}` on stdin
- **THEN** stderr is `hook deliver: no session_id in the stdin payload — expected a Claude Code hook JSON payload on stdin; nothing delivered.`

#### Scenario: Unmapped lifecycle

- **WHEN** the payload's `hook_event_name` is `PreToolUse`
- **THEN** stderr is `hook deliver: hook_event_name "PreToolUse" does not map to a delivery lifecycle (only UserPromptSubmit, PostToolUse, and SessionStart do); nothing delivered.`

#### Scenario: Unresolvable session id

- **WHEN** the payload's `session_id` `h9` matches no tracked session
- **THEN** stderr is `hook deliver: no session registered for host session id "h9"`

#### Scenario: Disabled workspace stays silent

- **GIVEN** `.claude/agentmonitors.local.md` with `enabled: false`
- **WHEN** `hook deliver` runs
- **THEN** both stdout and stderr are empty

### Requirement: hook deliver no-socket diagnostic distinguishes a failed boot

For an enabled workspace with neither `--socket` nor a `socket:` entry, `hook deliver` SHALL refuse to fall back to a shared default socket and SHALL emit one of two stderr lines, chosen by whether `.claude/agentmonitors.local.md` carries `lastBootFailureAt` (written by `session start`'s boot-timeout guard).

#### Scenario: Never configured

- **GIVEN** an enabled workspace with no `socket:` and no `lastBootFailureAt`
- **WHEN** `hook deliver` runs
- **THEN** stderr is `hook deliver: no per-workspace socket configured (neither --socket nor a \`socket:\` entry in .claude/agentmonitors.local.md) — refusing to fall back to a shared default socket; nothing delivered. Start a daemon for this workspace with \`agentmonitors daemon run --detach\`, or pass --socket.`

#### Scenario: Lazy boot failed

- **GIVEN** an enabled workspace with no `socket:` and a `lastBootFailureAt` marker
- **WHEN** `hook deliver` runs
- **THEN** stderr is `hook deliver: no per-workspace socket configured — the last automatic daemon boot for this workspace (via the SessionStart hook) failed to come up in time; nothing delivered. It will retry automatically the next time a session starts here — run \`agentmonitors daemon run --detach\` yourself only if you need it available before then.`

### Requirement: hook deliver stderr renders untrusted values control-safe

Every untrusted stdin value interpolated into an always-on diagnostic or a `--debug` line (`session_id`, `hook_event_name`, `cwd`, and the workspace path derived from `cwd`) SHALL be JSON-string-escaped, including DEL, C1 controls U+0080–U+009F, and U+2028/U+2029, and truncated at 128 characters on a code-point boundary with a trailing `…` (#365).

#### Scenario: Hostile session id

- **GIVEN** a `session_id` of 300 characters containing a newline and U+2028
- **WHEN** `hook deliver` warns that no session is registered
- **THEN** the warning is one line, the newline and U+2028 appear escaped, and the id is cut at 128 characters followed by `…`

#### Scenario: Surrogate pair at the cut

- **GIVEN** a `session_id` whose 128th character is the first half of a surrogate pair
- **WHEN** the value is truncated
- **THEN** the pair is not split

### Requirement: hook deliver --debug writes a stderr-only diagnosis

`--debug` SHALL write a step-by-step diagnosis only to stderr, each line prefixed `agentmonitors hook deliver --debug:`; stdout SHALL be byte-identical to a non-`--debug` run of the same payload against the same daemon state in every format. Internal errors SHALL still be swallowed on stdout and SHALL additionally be named on stderr.

#### Scenario: Byte-identical stdout

- **GIVEN** one payload and one daemon state
- **WHEN** `hook deliver` runs with and without `--debug`
- **THEN** both runs produce identical stdout bytes and exit 0

### Requirement: hook deliver --debug diagnosis content

The `--debug` diagnosis SHALL report, in order: the payload's `session_id`/`hook_event_name`/`cwd` (or `(none)`); why resolution stopped, if it did; on resolution, the AgentMon session id, workspace, and status; unread (unacknowledged) counts by urgency (read-only); per-band hold reasons; the `claimDelivery` result (mode/urgency/event count, or `null`); and whether and in which format anything was written to stdout.

#### Scenario: Stopped at session resolution

- **GIVEN** a payload whose `session_id` matches no tracked session
- **WHEN** `hook deliver --debug` runs
- **THEN** the diagnosis names the workspace/session mismatch and the known-session count

#### Scenario: Settle-window hold

- **GIVEN** a high-urgency event younger than the 15s claim settle window
- **WHEN** `hook deliver --debug` runs
- **THEN** the diagnosis reports a `settle-window` hold for the high band and a `null` claim

### Requirement: hook deliver --debug hold-reason vocabulary

Per-band hold reasons SHALL use these names: `settle-window` (pending high events not yet past the 15s claim settle), `no-new-work` (no fresh pending normal/low work remains; same vocabulary as `monitor explain`, #333), `reserved-in-flight` (a same-band reservation holds the reminder, even beside older claimed rows), and `deferred-by-cap` (settled high events deferred by the 4000-char `additionalContext` cap; they redeliver at the next context event).

#### Scenario: Older claim does not hold a fresh reminder

- **GIVEN** a claimed but unacknowledged normal-urgency event and a newer unclaimed normal event, with no lease
- **WHEN** `hook deliver --debug` runs at `turn-interruptible`
- **THEN** no hold is reported for the normal band and the reminder is delivered

#### Scenario: Nothing new to remind about

- **GIVEN** every unread normal-urgency event of the session is already claimed
- **WHEN** `hook deliver --debug` runs at `turn-interruptible`
- **THEN** the normal band's hold reason is `no-new-work`

#### Scenario: Leased row is not an acknowledge prompt

- **GIVEN** a band with a row leased by an in-flight channel push, with or without older claimed rows
- **WHEN** `hook deliver --debug` runs
- **THEN** the band's hold reason is `reserved-in-flight` and no acknowledge instruction is printed

### Requirement: Legacy hold reasons are accepted but never emitted

`already-claimed` and `coalesced-until-ack` SHALL remain accepted hold-reason values for compatibility with older daemon responses, but current delivery decisions SHALL NOT emit them (#524).

#### Scenario: Current daemon never reports coalesced-until-ack

- **GIVEN** a band with both claimed-unacknowledged and fresh unclaimed events
- **WHEN** `hook deliver --debug` runs against a current daemon
- **THEN** no hold reason is `already-claimed` or `coalesced-until-ack`

### Requirement: hook deliver lifecycle surfacing

The payload `hook deliver` surfaces per lifecycle, the event→lifecycle mapping, and the 4000-character cap SHALL be exactly those of the `delivery/lifecycles` and `delivery/hook-transport` capabilities; `turn-idle` is reachable only through the `--lifecycle` override. Claimed rows are not acknowledged and stay listed by `events list --unread`.

#### Scenario: Claimed rows remain re-discoverable

- **GIVEN** `hook deliver` surfaced a settled high event body
- **WHEN** `events list --session s1 --unread` runs afterwards
- **THEN** the event is listed with `deliveryState` `claimed`

#### Scenario: Over-cap context truncated

- **GIVEN** pending high events whose bodies exceed the 4000-char cap
- **WHEN** `hook deliver` runs
- **THEN** the context is cut at a code-point boundary with a `[truncated …]` marker and the truncated-away events stay unread

### Requirement: channel serve flags

`agentmonitors channel serve` SHALL accept `--socket <path>`, `--poll-ms <ms>` (default `3000`), `--host-session-id <id>` (default `$CLAUDE_CODE_SESSION_ID`), and `--workspace <path>` (default `$CLAUDE_PROJECT_DIR`). It is spawned automatically (with no flags) by the plugin's `.mcp.json` and is not intended to be run by hand.

#### Scenario: Default poll interval

- **WHEN** `channel serve` runs with no `--poll-ms`
- **THEN** it polls for deliveries every 3000 ms

### Requirement: channel serve socket precedence

`channel serve` SHALL resolve its socket as: explicit `--socket`; else an enabled `--workspace`'s persisted-or-derived per-workspace socket (the one `session start` lazy-boots, #358); else `$AGENTMONITORS_SOCKET`; else the global default. Rationale: a stale environment value from another workspace must never cross-connect the channel to another workspace's daemon (session isolation, PP4; #335).

#### Scenario: Stale environment socket ignored for an enabled workspace

- **GIVEN** an enabled workspace whose derived socket is `/w/a.sock` and `AGENTMONITORS_SOCKET=/other/b.sock`
- **WHEN** `channel serve --workspace /w` starts with no `--socket`
- **THEN** it connects to `/w/a.sock`

#### Scenario: Not-enabled workspace uses the environment

- **GIVEN** a not-enabled workspace and `AGENTMONITORS_SOCKET=/other/b.sock`
- **WHEN** `channel serve` starts with no `--socket`
- **THEN** it connects to `/other/b.sock`

### Requirement: channel serve runs the channel transport over stdio

`channel serve` SHALL run the MCP stdio channel server, push, and `agentmon_ack` tool defined by the `delivery/channel-transport` capability. It SHALL write nothing to stdout other than the MCP transport, keep errors quiet, handle a missing daemon quietly, and shut down when stdin closes. With no host session id it SHALL stay connected without polling, and the ack tool SHALL report an error if called.

#### Scenario: No host session id

- **GIVEN** neither `--host-session-id` nor `CLAUDE_CODE_SESSION_ID` is set
- **WHEN** `channel serve` starts
- **THEN** it stays connected and never claims deliveries
- **AND** calling `agentmon_ack` returns an error

#### Scenario: MCP disconnect

- **WHEN** the host closes `channel serve`'s stdin
- **THEN** the server exits

# delivery/hook-transport Specification

## Purpose

Specifies the portable, always-available Claude Code hook transports: the per-session hook-state
transport and the `agentmonitors hook deliver` transport that injects deliveries as advisory
`additionalContext` — its stdin input contract, wire output, event→lifecycle mapping, rendering,
truncation markers, reserve→render→write→commit ordering, `--debug` diagnosis, and activation packaging
(the `agentmonitors` plugin). Command flags and exit codes are owned by `cli/session-commands`.

## Requirements

### Requirement: Hook-state transport is the per-session portable baseline

The hook-state transport SHALL refresh a per-session `hook-state.json` each tick (path and content per
`delivery/host-adapters` and `delivery/session-projection`) that Claude Code hooks read at lifecycle
points. It SHALL bind at session granularity, keyed by `(adapter, hostSessionId)`, so unread/claimed
accounting is exact per session, and needs nothing beyond the host's hook mechanism.

#### Scenario: Two sessions in one workspace

- **WHEN** sessions S1 and S2 are open in the same workspace and S1 claims event E
- **THEN** S1's hook state reflects E as claimed and S2's hook state is unaffected

### Requirement: Hook deliver injects advisory context without other dependencies

`agentmonitors hook deliver` SHALL run inside a Claude Code lifecycle hook, claim pending deliveries for
the session, and emit them as advisory, non-blocking `additionalContext` at the turn boundary. It SHALL
require no MCP server and no channel capability, working in any environment that can run Claude Code
hooks.

#### Scenario: No MCP available

- **WHEN** `hook deliver` runs in an environment with no MCP servers allowed
- **THEN** pending deliveries are still emitted as `additionalContext`

### Requirement: Hook payload is read from stdin

Hook-invoked commands SHALL read the hook payload as a JSON object from stdin and use `session_id` (the
host session id), `hook_event_name` (the firing event), and `cwd` (the workspace). There is no
`CLAUDE_CODE_SESSION_ID` variable in a hook invocation, so the host session id MUST NOT be read from the
environment. A TTY, empty, or unparseable stdin SHALL be treated as `{}` and never block.

#### Scenario: Interactive TTY stdin

- **WHEN** `hook deliver` runs with stdin attached to a TTY
- **THEN** it treats the payload as `{}`, does not wait for input, writes nothing to stdout, and exits 0
- **AND** stderr carries only the no-`session_id` diagnostic defined by the `cli/session-commands` capability

#### Scenario: Session id only in the environment

- **WHEN** stdin has no `session_id` but `CLAUDE_CODE_SESSION_ID` is set in the environment
- **THEN** `hook deliver` writes nothing to stdout and exits 0 (no environment fallback)
- **AND** stderr carries the no-`session_id` diagnostic per the `cli/session-commands` capability

### Requirement: Hook workspace resolution order

Hook-invoked commands SHALL resolve the workspace path from the payload's `cwd`, then the
`CLAUDE_PROJECT_DIR` environment variable, then the process cwd.

#### Scenario: Payload omits cwd

- **WHEN** the payload has no `cwd` and `CLAUDE_PROJECT_DIR=/repo`
- **THEN** the workspace is `/repo`

### Requirement: All hook-invoked commands share the stdin contract

`hook deliver`, `session start`, and `session end` SHALL all derive the host session id from the stdin
`session_id` and the workspace from `cwd` → `CLAUDE_PROJECT_DIR` → process cwd. None reads a session id
from the environment; `hook deliver` takes no `--hook-event-name` flag and `session start` / `session
end` take no `--host-session-id` flag.

#### Scenario: Session start from a real SessionStart payload

- **WHEN** `session start` receives `{"session_id":"abc","cwd":"/repo","hook_event_name":"SessionStart"}` on stdin
- **THEN** it registers host session `abc` for workspace `/repo`

### Requirement: Hook wire output shape

In its default and `--format json` modes `hook deliver` SHALL print one compact JSON object
`{"continue":true,"hookSpecificOutput":{"hookEventName":"<EventName>","additionalContext":"<rendered text>"}}`
and MUST exit 0; it SHALL NOT emit a `permissionDecision` field. `--format text` SHALL print only the
`additionalContext` text, for manual inspection; hook registration uses the default.

#### Scenario: Body delivery on UserPromptSubmit

- **WHEN** a settled `high` event is pending and the payload's `hook_event_name` is `UserPromptSubmit`
- **THEN** stdout is JSON with `continue: true`, `hookSpecificOutput.hookEventName: "UserPromptSubmit"`, and a non-empty `additionalContext`
- **AND** the exit code is 0 and no `permissionDecision` is present

### Requirement: hookEventName echoes the firing event

`hookSpecificOutput.hookEventName` SHALL echo the stdin payload's `hook_event_name`, because the host
ignores `additionalContext` whose event name does not match the firing event.

#### Scenario: PostToolUse firing

- **WHEN** the payload's `hook_event_name` is `PostToolUse` and a delivery is emitted
- **THEN** `hookSpecificOutput.hookEventName` is `PostToolUse`

### Requirement: Nothing pending prints nothing

When there is nothing to deliver, `hook deliver` MUST print nothing on stdout and exit 0 in every format;
empty stdout is the host's signal to proceed silently.

#### Scenario: Idle session

- **WHEN** the session has no claimable delivery
- **THEN** stdout is empty and the exit code is 0 for default, `--format json`, and `--format text`

### Requirement: Hook event to lifecycle mapping

`hook deliver` SHALL derive the delivery lifecycle from `hook_event_name` unless `--lifecycle` overrides
it: `UserPromptSubmit` and `PostToolUse` → `turn-interruptible`; `SessionStart` → `post-compact`.
`PreToolUse` (uses `permissionDecision`), `Stop` (uses a top-level `decision`), and any other event do
not honor `additionalContext`, so they map to no lifecycle and the command emits nothing.

#### Scenario: PreToolUse firing

- **WHEN** the payload's `hook_event_name` is `PreToolUse` and settled `high` work is pending
- **THEN** `hook deliver` writes nothing to stdout, exits 0, and claims nothing
- **AND** stderr carries the unmapped-event diagnostic per the `cli/session-commands` capability

#### Scenario: SessionStart recap

- **WHEN** the payload's `hook_event_name` is `SessionStart` and the session has unread events
- **THEN** the lifecycle is `post-compact` and all unread events surface as a recap with bodies

### Requirement: Hook body-injection rendering

For a body-injection claim (settled `high` events at `turn-interruptible`, or a `post-compact` recap),
`additionalContext` SHALL contain an attributed lead line, a one-line acknowledge instruction, then one
shared per-event block per event (per `delivery/transport-seam`) including the monitor's `body`.

#### Scenario: Header and block

- **WHEN** one settled `high` event of monitor `m1` is delivered to session S
- **THEN** `additionalContext` begins `AgentMon: monitored changes are pending — consider handling them before continuing.`
- **AND** the next line is the acknowledge instruction, followed by a block starting `### m1 (high)`

### Requirement: Hook acknowledge instruction is scoped to rendered events

The body-injection header MUST carry exactly one instruction per delivery,
`When handled, acknowledge: agentmonitors events ack --session <id> --socket <path> --event-ids <id1>,<id2>`,
with the recipient's real session id, the resolved socket path, and `--event-ids` naming exactly the
events this render included — never the full claimed or candidate set (a recap's set can be larger).

#### Scenario: Capped delivery defers events

- **WHEN** five settled `high` events are pending but only E1 and E2 fit under the cap
- **THEN** the instruction reads `... --event-ids E1,E2` and does not name E3–E5

#### Scenario: Instruction never acks everything

- **WHEN** any body-injection delivery is rendered
- **THEN** its acknowledge instruction always includes `--event-ids` and an explicit `--socket`

### Requirement: Header sizing converges by narrowing

Because the header's length depends on how many ids it names and on the socket path, every sizing path
SHALL resolve the fixed point by iterative narrowing: assume all candidates are included, pack whole
blocks, and if fewer fit, retry with the header naming only that many ids until it is self-consistent.

#### Scenario: Long socket path

- **WHEN** a long socket path makes the full-candidate header too large for the last block to fit
- **THEN** the rendered header names only the ids of the blocks actually rendered

### Requirement: Hook reminder-only rendering

For a `normal`/`low` claim with no event bodies, `additionalContext` SHALL be a single line: `AgentMon: `,
the runtime message, and the transport's action step, e.g. ``AgentMon: Monitored changes are pending.
Run `agentmonitors events list --session <id> --socket <path> --unread` to see them, then `agentmonitors
events ack --session <id> --socket <path>` once handled.`` — no header, no blocks, no `--event-ids`.

#### Scenario: Normal-urgency reminder is visible

- **WHEN** a `normal` event is pending at `UserPromptSubmit`
- **THEN** `additionalContext` contains the reminder line with the session id and `--socket`
- **AND** the underlying row is claimed but not acknowledged and remains listed by `events list --unread`

### Requirement: Hook content sanitization

`additionalContext` is a JSON string, not tag-delimited, so `hook deliver` SHALL preserve `<`, `>`, `[`,
`]`, `;`, and newlines verbatim (monitor bodies are trusted, user-authored markdown) and SHALL strip only
raw C0/C1 control characters other than tab and newline.

#### Scenario: Body with code and links

- **WHEN** a monitor body contains `[docs](https://x)` and `<T>`
- **THEN** both appear unchanged in `additionalContext`

### Requirement: Hook context is capped at 4000 characters

`additionalContext`, including any markers, SHALL be at most 4000 characters. When the assembled context
exceeds the cap it SHALL be truncated at a Unicode code-point boundary (never splitting a surrogate pair)
with an explicit marker appended.

#### Scenario: Surrogate pair at the cut point

- **WHEN** the 4000-character cut would fall inside an emoji's surrogate pair
- **THEN** the cut moves to the preceding code-point boundary and the output is valid JSON

### Requirement: Claimed set equals rendered set

A length-bounded transport MUST NOT claim an event it does not surface. `hook deliver` SHALL preview the
settled `high` delivery without mutating state, size how many whole event blocks fit (never a partial
block, reserving marker room), and reserve that many; unrendered events stay pending (`first_notified_at`
NULL) and re-deliver, in order, at the next context event.

#### Scenario: Cap-bounded redelivery

- **WHEN** three settled `high` events are pending and only two whole blocks fit
- **THEN** two are rendered and claimed, the third stays pending, and it is delivered at the next context event

### Requirement: Deferred-remainder marker

When whole event blocks were left unreserved (still pending), `hook deliver` SHALL append
``[truncated — more monitor updates are pending; run `agentmonitors events list --session <id> --socket <path> --unread` to see the rest]``.

#### Scenario: Whole block deferred

- **WHEN** a render omits a pending event because its whole block did not fit
- **THEN** `additionalContext` ends with the deferred-remainder marker naming the session id and socket

### Requirement: Claimed-unread truncation marker is outcome-neutral

When this claim's own content was cut (a single event's block exceeds the cap, or a truncated reminder
message), `hook deliver` SHALL append ``[truncated — this update was too large to show in full; the full
copy stays unread — run `agentmonitors events list --session <id> --socket <path> --unread` to see it now]``,
asserting neither claimed state nor redelivery, because it renders before commit.

#### Scenario: Single oversized event

- **WHEN** the only reserved event's block alone exceeds 4000 characters
- **THEN** it is mid-truncated at a code-point boundary and the claimed-unread marker is appended
- **AND** the marker does not claim the event will or will not redeliver

### Requirement: Truncation markers can co-occur

When the sole reserved event is mid-truncated AND further, different settled `high` work stays pending
beyond it, `hook deliver` SHALL render both the claimed-unread marker and the deferred-remainder marker,
sized together within the 4000-character cap.

#### Scenario: Oversized event plus deferred remainder

- **WHEN** the reserved event is oversized and another settled `high` event remains pending
- **THEN** both markers appear in the same `additionalContext`

### Requirement: Recap uses a recap-specific marker

For a `post-compact` claim, `hook deliver` SHALL use one recap marker in place of both ordinary markers:
``[truncated — not everything fit in this recap; the omitted content stays unread and will reappear on
future recaps until acknowledged — run `agentmonitors events list --session <id> --socket <path> --unread` to see it now]``,
because recap re-sources from unread state.

#### Scenario: Recap overflow

- **WHEN** a `SessionStart` recap's unread events do not all fit
- **THEN** the recap marker is appended and neither ordinary marker is used
- **AND** the omitted events reappear on the next recap until acknowledged

### Requirement: Recovery commands are session- and socket-scoped

Every marker and instruction SHALL name the exact runnable command with the claim's own sanitized session
id and an explicit `--socket <path>` — never the bare `events list --unread` form, which exits 1 — and
SHALL render the path shell-safely in bash/zsh ANSI-C quoting (`$'...'`, `\xNN` for unsafe bytes) so it
reconstructs exactly (issues #358, #420, #442).

#### Scenario: Socket path with a space

- **WHEN** the resolved socket path is `/tmp/my dir/agentmonitors.sock`
- **THEN** each rendered command carries a `--socket` value that, run in bash or zsh, passes exactly that path

#### Scenario: Stale environment socket

- **WHEN** `$AGENTMONITORS_SOCKET` points at another workspace's daemon and the agent copies a rendered command
- **THEN** the command's explicit `--socket` targets the daemon `hook deliver` actually claimed against

### Requirement: Hook deliver quiet-return gates

`hook deliver` SHALL write nothing to stdout, claim nothing, and exit 0 when: the payload has no
`session_id`; the event maps to no lifecycle; `.claude/agentmonitors.local.md` (read for the resolved
workspace) is not `enabled` or names no socket; or the daemon is unreachable. The socket SHALL come from
`--socket` then the `.local.md` socket, never the global default, so delivery cannot cross workspaces.
Which gates also write a stderr diagnostic is per the `cli/session-commands` capability.

#### Scenario: Disabled workspace

- **WHEN** the workspace's `.claude/agentmonitors.local.md` lacks `enabled: true`
- **THEN** `hook deliver` writes nothing to stdout or stderr and exits 0

#### Scenario: No per-workspace socket

- **WHEN** the workspace is enabled but no per-workspace socket is resolvable and a global-default daemon is running
- **THEN** `hook deliver` does not contact the global-default daemon and writes nothing to stdout
- **AND** it writes the no-socket stderr diagnostic (keyed on `lastBootFailureAt`) defined by the `cli/session-commands` capability

#### Scenario: Daemon unreachable

- **WHEN** the workspace is enabled with a persisted socket but no daemon listens there
- **THEN** `hook deliver` writes nothing to stdout or stderr (without `--debug`) and exits 0

### Requirement: Unknown host session is warned on stderr

When no tracked session's `hostSessionId` matches `session_id`, `hook deliver` SHALL write nothing on
stdout, claim nothing, exit 0, and always (regardless of `--debug`) emit the unknown-session stderr
diagnostic whose text and escaping are defined by the `cli/session-commands` capability (issue #329),
because this state never resolves on its own and is otherwise indistinguishable from the settle window.

#### Scenario: Unregistered session id

- **WHEN** the payload's `session_id` is `ghost` and no session has that host session id
- **THEN** stderr carries exactly one unknown-session diagnostic line per `cli/session-commands`
- **AND** stdout is empty, nothing is claimed, and the exit code is 0

### Requirement: Reserve, validate, render, write, then commit

For a delivery, `hook deliver` SHALL reserve (lease, not claim), re-validate the actual reserved claim's
fit, render the reservation's own claim, write it to stdout awaiting the write's completion (not
`stdout.write`'s return value), and only then commit. A write failure, synchronous or asynchronous
(e.g. `EPIPE`), SHALL release the reservation instead of committing (issue #442).

#### Scenario: Hook consumer closed the pipe

- **WHEN** the stdout write fails asynchronously with `EPIPE` after rendering
- **THEN** the reservation is released, no row is claimed, and the events remain pending

#### Scenario: Commit response lost after a successful write

- **WHEN** the write succeeds but the commit RPC fails
- **THEN** at worst the delivery is surfaced again later (duplicate), never silently lost

### Requirement: Reserved fit is re-validated with bounded retry

Because sizing preview and reservation are separate IPC round-trips, `hook deliver` SHALL check that the
actually-reserved events fit, using the same predicate as rendering; on mismatch it SHALL release and
retry with a tighter cap, bounded, with the final attempt forcing a single-event reservation.

#### Scenario: Concurrent substitution

- **WHEN** a concurrent caller makes the reservation return larger events than the preview measured
- **THEN** the reservation is released and retried, and no event is claimed that is not fully rendered (except the single-event final attempt)

### Requirement: Deferred work is re-checked after reservation

After a reservation is accepted, `hook deliver` SHALL re-run the settled-`high` preview and set
`moreDeferred` when any settled event is not in the claim, re-checking fit against the marker-reserving
budget; if that preview fails the reservation SHALL be released before the error propagates.

#### Scenario: Event settles between preview and reserve

- **WHEN** the preview saw one settled event, and a second settles before the reservation
- **THEN** the render carries the deferred-remainder marker for the second event

### Requirement: Unsized claims and reminder deferral

Non-`turn-interruptible` lifecycles and reminder claims (`events: []`) SHALL be reserved and committed
without sizing, and a reminder claim's `moreDeferred` SHALL be reported `false` regardless of any earlier
sizing preview. If reservation returns nothing, or the commit returns null (lease lapsed or daemon
restarted), the command exits 0.

#### Scenario: Preview raced to a reminder

- **WHEN** the sizing preview saw settled `high` work but the reservation returns a reminder claim
- **THEN** `moreDeferred` is false and `--debug` reports no cap deferral

### Requirement: Empty render still commits

When rendering yields nothing (no event bodies and no reminder message), `hook deliver` SHALL write
nothing and still commit the reservation.

#### Scenario: Claim with neither events nor message

- **WHEN** a reserved claim has no events and no message
- **THEN** stdout is empty and the reservation is committed

### Requirement: Hook deliver never fails the host session

`hook deliver` SHALL swallow every internal error (IPC failures, missing state, unexpected errors) and
always exit 0, because an unhandled error would interrupt the user's session.

#### Scenario: Daemon dies mid-claim

- **WHEN** the daemon connection drops during reservation
- **THEN** `hook deliver` exits 0 with empty stdout

### Requirement: Debug diagnosis is stderr-only and read-only

With `--debug`, `hook deliver` SHALL gather its diagnosis with only one additional read-only daemon call
(`hook.diagnose`), computed only when `--debug` is set, and SHALL never claim or mutate delivery state for
diagnosis. The stderr-only output, stdout byte-identity, line format, content, and hold-reason vocabulary
are per the `cli/session-commands` capability.

#### Scenario: Debug does not change delivery state

- **WHEN** the same payload is run with `--debug` against a session with a pending `normal` reminder
- **THEN** the claim outcome and every row's delivery state are the same as for a non-`--debug` run
- **AND** the only extra daemon request is the read-only `hook.diagnose`

### Requirement: Hook registration on context events

The same single command `agentmonitors hook deliver` SHALL be registered for context events only (those
honoring `additionalContext`: `UserPromptSubmit`, `PostToolUse`, `SessionStart`); `--lifecycle` is an
optional override primarily for tests.

#### Scenario: Generic hook configuration

- **WHEN** a user registers `{ "type": "command", "command": "agentmonitors hook deliver" }` under `UserPromptSubmit`, `PostToolUse`, and `SessionStart`
- **THEN** each event derives its own lifecycle without per-event flags

### Requirement: Hook delivery remains unread until acknowledged

Committing a hook delivery marks rows claimed, which is not acknowledgement (BP2 / SP4); every surfaced or
deferred event SHALL remain listable by `agentmonitors events list --unread` until explicitly
acknowledged. `normal`/`low` reminders and the `post-compact` recap need no sizing because they inject no
bodies or re-show all unread each time.

#### Scenario: Recap self-heals

- **WHEN** a recap's omitted events are left unacknowledged
- **THEN** the next `post-compact` recap shows them again

### Requirement: Activation plugin wires lifecycle hooks

The `agentmonitors` activation plugin SHALL wire `SessionStart` → `agentmonitors session start`
(lazy-boot the daemon, register, surface the recap), `UserPromptSubmit` → `agentmonitors hook deliver`,
and `SessionEnd` → `agentmonitors session end` (deregister so the idle daemon can reap). `PreToolUse` and
`Stop` SHALL NOT be wired; `PostToolUse` is not wired (a daemon round-trip per tool is too costly).
Each command string runs the stdin-contract command verbatim, with no flags.

#### Scenario: Plugin hooks.json drives the CLI end to end (config drift)

- **GIVEN** the real `agent-plugins/agentmonitors/hooks/hooks.json` and an `agentmonitors` PATH shim
- **WHEN** each `SessionStart`/`UserPromptSubmit`/`SessionEnd` command string runs verbatim via `/bin/sh -c` with a real hook payload on stdin
- **THEN** `SessionStart` boots the daemon and registers, `UserPromptSubmit` delivers the pending event body, and `SessionEnd` deregisters

### Requirement: Plugin hook wrappers are best-effort and stay wired to the stdin contract

Each plugin hook command SHALL invoke its CLI command as `<command> || true` (e.g. `agentmonitors
session start || true`) behind the missing-CLI guard, so a CLI failure never disrupts the host session. The best-effort property SHALL belong to the wrapper, not to
the commands' own exit codes, which stay as defined by the `cli/session-commands` capability.

#### Scenario: Boot failure is absorbed by the wrapper

- **GIVEN** `agentmonitors session start` exits 1 because the daemon did not come up within the boot timeout
- **WHEN** the plugin's `SessionStart` command string runs
- **THEN** the hook command itself exits 0
- **AND** `session start` invoked directly still exits 1

### Requirement: Plugin lifecycle hooks are host-native

The plugin SHALL author its lifecycle hooks as a host-native `hooks/hooks.json` at the conventional path,
which Claude Code auto-discovers; the plugin manifest MUST NOT also reference that file (a duplicate
hooks reference fails plugin load).

#### Scenario: Manifest has no duplicate hooks reference

- **WHEN** the plugin manifest is inspected
- **THEN** it does not reference `hooks/hooks.json`

### Requirement: Hook commands tolerate a missing CLI

Each plugin hook command SHALL be guarded by `command -v agentmonitors >/dev/null 2>&1` and end in a
silent exit 0 when the CLI is absent (never exit 127). The `SessionStart` command SHALL instead emit a
one-shot `additionalContext` hint to install the CLI with `npm i -g @agentmonitors/cli`.

#### Scenario: CLI not on PATH

- **WHEN** the `SessionStart` command runs with no `agentmonitors` on PATH
- **THEN** it prints the install-hint hook JSON and exits 0
- **AND** the `UserPromptSubmit` and `SessionEnd` commands print nothing and exit 0

### Requirement: Disabled project with monitors gets an advisory

When `session start` finds the project not enabled, it SHALL scan `.claude/monitors`; with one or more
definitions (parsed or failed), it SHALL emit one `additionalContext` advisory naming the count, the
enable step (create `.claude/agentmonitors.local.md` with `enabled: true`), and `agentmonitors doctor`,
then exit 0 without opening a session or booting a daemon; with zero it stays silent (issue #269).

#### Scenario: Monitors present, not enabled

- **WHEN** `.claude/monitors` holds two monitor definitions (one malformed) and the project is not enabled
- **THEN** `session start` emits an advisory stating monitoring is disabled and 2 definitions were found
- **AND** no session is registered and no daemon is started

#### Scenario: Never opted in

- **WHEN** the project is not enabled and has no monitor definitions
- **THEN** `session start` prints nothing and exits 0

### Requirement: SessionStart is a single process

Because a hook invocation has one stdin stream, `session start` SHALL read the payload once and, after
registering, perform the `post-compact` recap itself through the same reserve → render → awaited write →
commit flow as `hook deliver`. The `SessionStart` hook SHALL run the single command `agentmonitors
session start`, never chained with `hook deliver`.

#### Scenario: Recap at session start

- **WHEN** `session start` runs for a session with unread events
- **THEN** it prints the recap `additionalContext` and commits the reservation only after the write completes

#### Scenario: Recap write fails

- **WHEN** the recap write fails asynchronously
- **THEN** the reservation is released, not committed, so no new claim is applied (rows claimed by an earlier delivery stay claimed, per `cli/session-commands`)
- **AND** every reserved row stays unread

### Requirement: Activation ships as a colocated plugin marketplace

Activation SHALL ship as a colocated aipm marketplace in the repository whose single `agentmonitors`
plugin (under `agent-plugins/`) is installed once into Claude Code, after which a project opts in with
project-local state. Generated marketplace registries (`.claude-plugin/marketplace.json`) SHALL be
committed and freshness-checked by `aipm validate` in CI.

#### Scenario: Stale registry

- **WHEN** a plugin change leaves `.claude-plugin/marketplace.json` out of date
- **THEN** CI's `aipm validate` fails

### Requirement: Plugin bundles the setup-monitors skill

The plugin SHALL bundle a `setup-monitors` skill that guides enabling a project (gitignored
`.claude/agentmonitors.local.md` with `enabled: true`) and carries plain-language intent through source
selection, minimal config, `.claude/monitors/<id>/MONITOR.md` authoring, `agentmonitors validate`,
mandatory firing verification, and `monitor explain`-based debugging.

#### Scenario: Skill present in plugin

- **WHEN** the `agentmonitors` plugin is installed
- **THEN** a `setup-monitors` skill is available to the agent

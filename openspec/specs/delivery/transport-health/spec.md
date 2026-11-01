# delivery/transport-health Specification

## Purpose

Specifies transport heartbeats and the transport-health verdict (issue #425): the machine-wide
heartbeat registry each delivery transport writes, its lease/TTL and reaping rules, how records are
matched to sessions, and what the health surface must report and never conflate. How a live channel
heartbeat defers idle reaping is owned by `daemon/ipc`; the `doctor` command surface and its output
format are owned by `cli/doctor`.

## Requirements

### Requirement: Each transport writes a heartbeat record

Each delivery transport SHALL write a heartbeat record naming the transport (`hook` | `channel`), its
process id, CLI entry path, Node binary, CLI version (never a literal), the `HOME` and data root it
resolved, the workspace and socket it bound to, host and AgentMon session ids when known, `startedAt`,
`updatedAt`, `ttlMs`, and `lastDeliveryAt` when it has delivered.

#### Scenario: Channel misbound to the home directory

- **WHEN** a channel server was launched from `$HOME` and resolved `$HOME` as its workspace
- **THEN** its heartbeat names `$HOME` as `workspacePath`, so the health surface can report the misbinding

### Requirement: Channel heartbeat lifecycle

`channel serve` SHALL write its heartbeat at startup (before the first poll, so an unreachable daemon
still shows a running-but-misbound server), refresh it on an independent timer at one third of its TTL
and after every poll settles (success or failure), and remove it on clean shutdown; no write SHALL recreate
the record once shutdown has begun.

#### Scenario: Daemon wedged longer than the TTL

- **WHEN** one poll's IPC round trip hangs for longer than the channel TTL
- **THEN** the independent timer keeps the heartbeat fresh, so the channel is not reported `heartbeat-stale` for the daemon's outage

#### Scenario: Clean shutdown during an in-flight poll

- **WHEN** stdin reaches EOF while a poll is in flight
- **THEN** the heartbeat is removed and is not recreated when that poll settles

### Requirement: Hook heartbeat lifecycle

`hook deliver` SHALL write a heartbeat on each invocation once it has resolved a session, then a second
write once it knows whether it surfaced anything, recording a delivery timestamp only when it actually
wrote output to the host.

#### Scenario: Prompt with nothing pending

- **WHEN** `hook deliver` resolves a session but has nothing to deliver
- **THEN** its heartbeat is refreshed without setting a new `lastDeliveryAt`

### Requirement: Heartbeat writes preserve the last delivery time

Every heartbeat write SHALL be a read-modify-write on `lastDeliveryAt`: a write with nothing new to report
preserves the prior value instead of resetting it.

#### Scenario: Idle prompt after a delivery

- **WHEN** a session's previous prompt delivered at T1 and the current prompt delivers nothing
- **THEN** the record's `lastDeliveryAt` is still T1

### Requirement: Heartbeat writes are atomic and symlink-safe

A heartbeat SHALL be written to a deterministic sibling temp path and renamed into place; before writing,
any pre-existing path at the temp location SHALL be removed (without following symlinks) and the temp file
created exclusively (`O_EXCL`), so a planted symlink can never redirect the write.

#### Scenario: Planted symlink at the temp path

- **WHEN** a symlink to another file exists at the heartbeat's temp path
- **THEN** the write removes it, creates a new file exclusively, and the symlink target is untouched

### Requirement: Heartbeat records carry an owner-declared TTL

Every record SHALL carry `ttlMs` alongside `updatedAt`, so a reader can judge it dead without trusting
the writer to have removed it. The channel TTL SHALL be 30 seconds (well above its 3s poll cadence); the
hook TTL SHALL be 24 hours (there is no hook process between prompts).

#### Scenario: Channel killed with SIGKILL

- **WHEN** a channel server is killed without cleanup and 31 seconds pass
- **THEN** its leftover record is judged stale

#### Scenario: Human pause between prompts

- **WHEN** a hook-only session has not prompted for two hours
- **THEN** its hook record is still fresh

### Requirement: Staleness rule

A record SHALL be stale when `now - updatedAt > ttlMs`, when `updatedAt` is unparseable, or when
`updatedAt` is more than 5 seconds in the future (beyond clock-skew tolerance), so a skewed or forged
record can never stay fresh forever.

#### Scenario: Future timestamp

- **WHEN** a record's `updatedAt` is one hour ahead of the reader's clock
- **THEN** the record is stale and eligible for reaping

### Requirement: Reaping happens only on the write path

Reading the registry SHALL never mutate it. A record expired past its own TTL SHALL be removed only when a
transport writes a heartbeat (any transport on the machine); until then every reader keeps reporting it
as `heartbeat-stale`, so a lapsed transport stays reported until something re-registers.

#### Scenario: Repeated health checks

- **WHEN** `doctor` runs twice against a stale channel record with no transport writing in between
- **THEN** both runs report `heartbeat-stale` and the record still exists

#### Scenario: Next write reaps

- **WHEN** any transport later writes a heartbeat
- **THEN** the expired record's file is removed

### Requirement: Heartbeat registry is machine-wide

Records SHALL live in a flat, machine-wide registry at `<dataRoot>/agentmonitors/transports/`, not inside
any per-workspace data directory, so a server bound to workspace X is visible to a health check run in
workspace Y.

#### Scenario: Cross-workspace visibility

- **WHEN** a channel serving host session `abc` resolved workspace X and `doctor` runs in workspace Y for session `abc`
- **THEN** `doctor` finds that record and reports the workspace mismatch

### Requirement: Records are keyed per host session

Both transports SHALL key their record by host session id when one is known, so each active lead leaves
its own record and a session overwrites only its own.

#### Scenario: Two leads prompting

- **WHEN** two active lead sessions in one workspace each run `hook deliver`
- **THEN** two distinct hook records exist and neither lead reads as uncovered

### Requirement: Registry keys are collision-safe

The registry key SHALL replace every character outside a conservative filename allowlist with `_` (so `/`
or `..` cannot escape the directory) and append a short hash of the raw, unsanitized, untruncated host
session id.

#### Scenario: Colliding sanitized ids

- **WHEN** host session ids `run:1` and `run_1` each write a heartbeat
- **THEN** they are stored in two different files

### Requirement: Record matching differs by transport

Channel records SHALL be matched to a session by host session id across every workspace (detecting
misbinding). Hook records SHALL be matched same-workspace only, preferring records naming an active lead
and falling back to every same-workspace record only when none names one.

#### Scenario: Closed session's record does not poison health

- **WHEN** a workspace has a fresh hook record for active lead L and an in-TTL record for a closed session bound to an obsolete socket
- **THEN** the hook transport is judged from L's record and does not report `socket-mismatch`

#### Scenario: Lead moved workspaces before its first prompt

- **WHEN** a session whose hook last fired in workspace A now leads workspace B and has not prompted there
- **THEN** B reports `hook-lead-uncovered`, not a misbinding

### Requirement: Invisible data roots are reported as absence

A transport running under a different `HOME` / `XDG_DATA_HOME` resolves a different data root and is
invisible; the health surface SHALL report this as an absence whose wording names that possibility,
never as healthy.

#### Scenario: No record found

- **WHEN** no heartbeat matches the session
- **THEN** the report states no transport record was found and mentions a different `HOME`/`XDG_DATA_HOME` as a possible cause

### Requirement: Health surface names the listening method

The transport-health verdict (rendered by `agentmonitors doctor`, per `cli/doctor`) SHALL name the
listening method as `hook`, `channel`, `both`, or `none`.

#### Scenario: Only hooks installed

- **WHEN** only fresh hook records match the active leads
- **THEN** the listening method is `hook`

### Requirement: Health causes are reported distinctly with remediation

The verdict SHALL report each cause distinctly — absent daemon, workspace/socket/environment misbinding,
muted reminders reported by an older daemon, lapsed heartbeat — never collapsed into a generic unhealthy, and SHALL attach a concrete
command or action to every problem. Problem-code names, the blocking/advisory split, and their rendering
are owned by the `cli/doctor` capability.

#### Scenario: Legacy muted reminders

- **WHEN** an older daemon reports a lead's `normal` reminders withheld by `coalesced-until-ack` while both transports are connected
- **THEN** the verdict reports `reminders-suppressed` with a scoped acknowledge command, separate from any binding problem

#### Scenario: Claimed backlog is ordinary

- **WHEN** a lead's diagnosis reports `no-new-work` and no fresh work is pending
- **THEN** the verdict treats it as an ordinary backlog, not a broken delivery path, and reports no `reminders-suppressed` problem

### Requirement: Listening is separated from will-arrive

The verdict SHALL separately answer which method is listening and whether anything will actually arrive
for this session now, asking the daemon per active lead whether a reminder is suppressed.

#### Scenario: Connected but suppressed

- **WHEN** the channel is fresh and correctly bound but an older daemon reports every lead's reminders as suppressed (`coalesced-until-ack`)
- **THEN** the listening method is `channel` and the verdict states delivery will not arrive until acknowledged

### Requirement: Unknown is never reported as healthy

If the per-lead suppression query fails (an older daemon rejecting it, or a connection error), the
verdict MUST report `delivery-diagnosis-unavailable` instead of treating the failed check as a check that
found nothing. Its blocking effect on `deliverable` is per the `cli/doctor` capability.

#### Scenario: Older daemon

- **WHEN** the daemon rejects the diagnosis request as unsupported
- **THEN** the verdict includes `delivery-diagnosis-unavailable` and does not claim delivery will arrive

### Requirement: Active lead sessions are derived once

The set of ACTIVE lead sessions SHALL be derived once and used consistently by record matching, lead
coverage, and the per-lead delivery diagnosis; a closed (`dormant`) session counts as no lead. Which
`doctor` gates consume this set, and their resulting statuses, are per the `cli/doctor` capability.

#### Scenario: Only a closed lead remains

- **WHEN** the workspace's only lead was closed and its hook record is still in TTL
- **THEN** the verdict counts no lead session: no lead-coverage problem and no per-lead suppression query is raised for the closed session

### Requirement: Every active lead must be covered

A channel record matching one active lead SHALL NOT be taken as coverage for others: each active lead
lacking a channel record while the workspace has one SHALL be named by the blocking `channel-lead-uncovered`
problem, and a lead that has not fired hooks here by `hook-lead-uncovered`.

#### Scenario: Two leads, one channel

- **WHEN** active leads L1 and L2 exist and only L1 has a channel heartbeat
- **THEN** `channel-lead-uncovered` names L2 and the channel is not counted as the listening method

### Requirement: Any matched record's blocking problem disqualifies the method

Transport-owned blocking problems on every matched record SHALL be unioned into the transport's problems,
and whether the transport is a listening method SHALL derive from that union, not from the representative
record alone. Shared problems and advisories do not disqualify.

#### Scenario: Stale sibling behind a fresh representative

- **WHEN** one matched channel record is fresh and a sibling matched record is `heartbeat-stale`
- **THEN** the channel is not reported as the listening method and the verdict does not end "(healthy)"

### Requirement: Representative record selection is freshness-first

The representative record SHALL be the freshest (ties broken by problem count), with unparseable or
out-of-tolerance future timestamps sorting as oldest; all matching records' problems are still reported.

#### Scenario: Corrupt record alongside a valid one

- **WHEN** a corrupt record and a current valid record match the same session
- **THEN** the valid record is representative and the transport is reported running

### Requirement: Channel registration is an unverifiable advisory

Because a host started without `--dangerously-load-development-channels plugin:agentmonitors@agentmonitors`
(and not allowlisted) accepts pushes but drops them silently, a connected channel SHALL carry a
`channel-registration-unverified` advisory that points at `agentmonitors verify` and the dev-flag
remediation; its non-blocking treatment is per the `cli/doctor` capability.

#### Scenario: Connected channel

- **WHEN** the channel heartbeat is fresh and correctly bound
- **THEN** the verdict includes the advisory and the channel remains healthy

### Requirement: Suppressing holds require trustworthy claimed ids

`HookDeliveryHold.claimedEventIds` is optional; for a legacy `already-claimed` / `coalesced-until-ack` hold whose
`claimedEventIds` is missing or not a non-empty array of non-empty strings, the verdict SHALL report
`delivery-diagnosis-unavailable` for that session — never a blank `--event-ids` command and never an
unscoped ack-all fallback.

#### Scenario: Hold from an older daemon

- **WHEN** a `coalesced-until-ack` hold arrives without `claimedEventIds`
- **THEN** the session is reported `delivery-diagnosis-unavailable` and no acknowledge command is rendered

#### Scenario: Empty array on a suppressing hold

- **WHEN** an `already-claimed` hold carries `claimedEventIds: []`
- **THEN** it is treated exactly like a missing field

#### Scenario: Settle-window hold

- **WHEN** a `settle-window` hold carries `claimedEventIds: []`
- **THEN** it is valid and not treated as diagnosis-unavailable

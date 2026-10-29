## Why

The push model tells an agent _that_ something changed, but an agent that wants to _act_ on the
signal has no cheap, bounded follow-up read: it cannot fetch the current stored snapshot of the
changed object, diff two stored points in time, or get a one-line orientation without re-fetching
the watched resource itself or standing up its own watching loop. The daemon already holds the
durable snapshots, diffs, and event history; exposing them as read-only daemon verbs keeps the agent
on the right side of PP9 (agents declare intent and never poll) and PP10 (deterministic daemon).

Refs #259 (Epic: multi-host, agent-facing direction). Roadmap gap G16.

Source: 007 §1 (overview, NP-AF), §2.1–§2.3, §3.1–§3.3, §6 (validation implications for §2–§3),
§8 (transport choice, snapshot retention floor, verb names); 005 §14 (preamble), §14.1–§14.3.

## What Changes

- Add three read-only, agent-facing daemon verbs and their CLI surface:
  - `agentmonitors snapshot <monitorId> [--object <objectKey>] [--session <id>]` — the latest stored
    `monitor_snapshots` text for one watched object.
  - `agentmonitors diff <monitorId> --object <objectKey> [--from <point>] [--to <point>] [--session <id>]`
    — a strategy-aware diff of one object between two stored points (event id or ISO-8601 timestamp),
    defaulting to "since my baseline cursor".
  - `agentmonitors summary <monitorId> [--object <objectKey>] [--session <id>]` — a cheap orientation
    (ids, urgency, `changeKind`, unread/claimed counts, title/summary) with no snapshot or diff body.
- Fix the shared read contract: reads come only from durable state, never trigger `observe()`/`watch()`,
  never claim / acknowledge / advance a cursor, are bounded for an agent context window, return
  immediately (no long-poll), and are invoked only in response to a pushed signal or at the agent's
  own turn boundary (NP-AF).
- Define a snapshot-retention floor (or a clear error for a pruned point) so a two-point diff never
  silently returns an empty diff.

Does not resolve a spec/code contradiction: 007 §2–§3 and 005 §14.1–§14.3 are target and no code
exists for these verbs yet (verified: no `snapshot`/`diff`/`summary` command or daemon method in
`apps/cli/src`).

## Capabilities

### New Capabilities

- `agent/signal-verbs`: read-only act-on-signal verbs (`snapshot`, `diff`, `summary`) — their
  read-only/no-re-observe/bounded/async contract and their CLI surface.

### Modified Capabilities

<!-- none -->

## Impact

- Principles relied on: PP9, PP10, AP3, AP6, SP4, SP5, BP2, NP1, NP5 (and the NP-AF non-property).
- `apps/cli/src/commands/*` (new `snapshot`, `diff`, `summary` commands), `apps/cli/src/daemon-ipc.ts`
  (new daemon methods), `libs/core/src/runtime/store.ts` / `service.ts` (snapshot, point-resolution,
  and summary reads; reuse of the runtime's strategy-aware diff renderer).
- Possibly a snapshot-retention policy affecting `monitor_snapshots` pruning (per the
  `persistence/schema` capability).
- Published `@agentmonitors/cli` and likely `@agentmonitors/core` public API (changeset + api-report).
- `apps/website` docs for the new verbs.

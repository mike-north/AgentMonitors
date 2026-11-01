## Why

Process hygiene is one half of "a process you can leave running"; the other half is that the
daemon never lies about durable state. Several open defects let ingest be silently partial, let
per-recipient cursors move backwards, deliver reminders with nothing in them, retroactively rewrite
already-materialized events, or let transport-health surfaces report something other than the
truth. This change sets the cross-cutting commitment level those fixes must meet (008 §9 owns the
commitment; the mechanisms are owned by the runtime, delivery, and source capabilities).
Refs #294, Refs #295, Refs #298, Refs #301, Refs #305, Refs #306, Refs #451, Refs #462, Refs #463,
Refs #464, Refs #465, Refs #473 (milestone M3; commitment level from #504).

Source: 008 §9, §12 (row "Durable state is atomic, truthful, and restart-safe").

## What Changes

- Atomic, truthful ingest: an observation is either fully persisted or truthfully reported as
  failed — never silently partial (#295); an emitted span is persisted before any optional
  Interpret adapter is awaited (#294); validation runs before side effects (#301, #306); an
  unavailable upstream is distinguished from a successful empty baseline (#305).
- Monotonic per-recipient state: per-recipient cursors never move backwards, including across
  out-of-order urgency claims (#298).
- Truthful delivery decisions: a reminder whose unread set emptied before delivery is suppressed
  (#473); editing a monitor never retroactively rewrites already-materialized events (#451);
  transport-health surfaces report the truth (#462–#465).
- The shared crash-into-restart acceptance scenario across ingest → materialize → project → deliver.
- Not changed (already current, owned elsewhere): channel claims follow reserve → push →
  commit/release, committing only after a successful push (`delivery/channel-transport`, #300);
  a failed or completed watcher is released so polling fallback resumes (`runtime/tick-scheduling`,
  #296).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reliability/process-hygiene`: adds the cross-cutting durable-state truthfulness commitments.

## Impact

- Code: `libs/core/src/runtime/*` (ingest, materialization, projection, cursors, reminders),
  `libs/core/src/adapter/*` (Interpret ordering), `apps/cli/src/commands/{monitor,channel,doctor}.ts`,
  `apps/cli/src/transport-heartbeat.ts`, `plugins/source-incoming-changes`.
- Principles: PP1, SP4, AP1 (per `principles`).
- Mechanism owners (each issue's precise behavior belongs in its capability; this change only sets
  the commitment level): `runtime/event-materialization` (#295, #451), `pipeline/post-processing`
  (#294), `cli/monitor-commands` (#301), `cli/session-commands` (#306), `sources/incoming-changes`
  (#305), `delivery/session-projection` (#298), `delivery/lifecycles` (#473),
  `delivery/transport-health` and `cli/doctor` (#462–#465). Changes authored for those capabilities
  for the same issues should be merged with this one.
- Contradictions resolved: 008 §9 flags #296/#300 as "still-open trackers" for implemented clauses;
  both issues are now closed, so no reconciliation remains.
- Changesets for affected packages; api-report regeneration if public types change.

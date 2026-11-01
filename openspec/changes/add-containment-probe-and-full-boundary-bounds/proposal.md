## Why

Timeout escalation today reaches only a monitored command's original process group (POSIX) or
`taskkill` tree (Windows). A descendant that re-groups or re-sessions while keeping its identity
survives escalation with no bound and no report — a silent, unaccounted state. The daemon also
cannot say which containment guarantee is actually in effect on a given machine, so any claim it
makes is unverifiable. Refs #480.

Source: 008 §2.2, §3.2, §6.2 (user-facing docs clause), §7.1, §7.2, §12 (row "The tool answers
accurately what guarantee is in effect on this machine").

## What Changes

- Every process Agent Monitors spawned is always in exactly one of five states: live and bounded,
  cleaned up, deferred-reconciliation, abstained, or escaped (no sixth state).
- An out-of-group descendant that keeps its identity is either terminated at the deadline (on a
  rung whose mechanism tracks descendants across re-grouping) or placed in a reported
  deferred-reconciliation state — never silently unaccounted. **Modifies** the current
  "Out-of-group descendant coverage" requirement, closing the #480 known gap.
- On startup the daemon probes the platform's containment mechanisms and automatically selects the
  highest rung of a normative three-rung capability ladder (kernel-enforced group containment →
  group/session escalation + self-bounding watchdog → bookkeeping fallback). No user-facing tier or
  knob; no permission prompts; an absent optional component never gates a working install.
- `agentmonitors doctor` reports the selected mechanism and the guarantee level achieved, never
  advertising a level the environment cannot enforce, and changes the report on an environment
  downgrade.
- User-facing docs state plainly that escaped processes are recovered with the user's ordinary OS
  tooling.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reliability/process-hygiene`: adds process-state exhaustiveness, the capability probe, the
  ladder, and achieved-guarantee reporting; modifies out-of-group descendant coverage.

## Impact

- Code: `plugins/source-command-poll/src/*` (spawn under the selected mechanism),
  `libs/core/src/runtime/*` (deferred-reconciliation bookkeeping, probe at daemon startup),
  `apps/cli/src/commands/doctor.ts` (containment report), daemon startup path.
- Principles: PP7, BP4, NP4 (per `principles`). Relies on the identity marks defined by
  `verify-identity-before-cleanup-signals` (#479) and the reaping performed by
  `add-restart-sweep-and-stray-collection` (#478); the abstained state is surfaced by
  `add-abstention-warnings` (#507). The rung-2 watchdog is delivered by
  `bound-process-lifecycle-without-daemon` (#470).
- Contradictions resolved: 008 §6.2 is labeled current but requires user-facing docs to state the
  escape posture; `apps/website` does not yet do so. The prohibition half is current (main spec);
  the docs half is delivered here.
- Public surface: new `doctor` output; changeset for `@agentmonitors/cli` (and `@agentmonitors/core`
  if new public types are exported, with api-report regeneration).

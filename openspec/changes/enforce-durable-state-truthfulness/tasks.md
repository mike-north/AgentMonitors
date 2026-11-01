## 1. Atomic, truthful ingest

- [x] 1.1 Make ingest persistence atomic and report materialization failures truthfully (#295; shipped in #482 — see `runtime/event-materialization`)
- [ ] 1.1a Adopt the materialization retry outbox (schema, admission, and reads shipped in #483 — see `persistence/schema`): add retry state transitions, transaction-coupled completion, and runtime drain-before-observe (#295)
- [ ] 1.2 Persist an entire emitted span before awaiting the optional Interpret adapter (#294)
- [ ] 1.3 Apply source `scopeSchema` validation before `monitor test` performs side effects (#301)
- [ ] 1.4 Strictly validate `channel --poll-ms` before starting the MCP loop (#306)
- [ ] 1.5 Distinguish the `incoming-changes` unavailable state from a successful baseline (#305)

## 2. Monotonic per-recipient state and truthful delivery

- [ ] 2.1 Make per-recipient cursors monotonic across out-of-order urgency claims (#298)
- [ ] 2.2 Suppress reminders whose unread set emptied before delivery (#473)
- [ ] 2.3 Stop monitor edits from retroactively changing already-materialized events (#451)
- [ ] 2.4 Make transport-health surfaces truthful (#462, #463, #464, #465)

## 3. Tests

- [ ] 3.1 Each cited issue's regression test is its acceptance bar (one per issue, at the lowest layer that reproduces it)
- [ ] 3.2 Shared crash-into-restart integration test: kill the daemon at each point in ingest → materialize → project → deliver; assert on restart that durable state is complete or truthfully marked failed

## 4. Docs and release

- [ ] 4.1 Update `apps/website` docs where user-visible behavior changes (reminders, doctor transport verdicts, `monitor test` validation)
- [ ] 4.2 Add changesets for affected packages; run `pnpm --filter @agentmonitors/core run fix:api-report` if public types change
- [ ] 4.3 Move each mechanism-level rule into its owning capability's spec as it ships

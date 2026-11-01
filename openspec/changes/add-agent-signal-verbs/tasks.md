## 1. Decisions to pin before build

- [ ] 1.1 Settle the agent-facing transport (Unix-socket IPC vs loopback HTTP) by dogfooding; if loopback HTTP, bind loopback-only
- [ ] 1.2 Define the `monitor_snapshots` retention floor and the error shape for a pruned diff point
- [ ] 1.3 Confirm final verb and flag names (`snapshot` / `diff` / `summary`) and the agent-context output bound

## 2. Core reads

- [ ] 2.1 Add a latest-snapshot read keyed by `(workspacePath, monitorId, objectKey)` and an object-key listing for multi-object monitors
- [ ] 2.2 Add diff-point resolution (event id → its snapshot; ISO-8601 timestamp → snapshot at or immediately before) with defaults (`--from` = recipient baseline cursor, `--to` = latest snapshot)
- [ ] 2.3 Render diffs through the runtime's existing strategy-aware diff renderer (structural for `strategy: json-diff`, line-based otherwise)
- [ ] 2.4 Add the summary read over `monitor_events` + `session_event_state` (id, `objectKey`, urgency, `changeKind`, unread/claimed counts, title/summary)
- [ ] 2.5 Ensure none of the reads claim, acknowledge, advance a cursor, or invoke a source `observe()`

## 3. Daemon and CLI surface

- [ ] 3.1 Add daemon methods for snapshot / diff / summary with Zod-validated params
- [ ] 3.2 Add `agentmonitors snapshot`, `diff`, `summary` commands with `--object`, `--from`, `--to`, `--session`, `--socket`, `--format`
- [ ] 3.3 Add the verbs to the CLI's daemon-socket command classification and socket resolution

## 4. Tests

- [ ] 4.1 Integration test (real daemon IPC): `session_event_state` and `session_object_cursor` are byte-identical before/after each of `snapshot`/`diff`/`summary`
- [ ] 4.2 Integration test with a spy/fake source: `observe()` call count unchanged across each read
- [ ] 4.3 Test: `diff` between two event ids equals the strategy-aware renderer output of their stored snapshots; default `--from` equals the recipient baseline cursor; `json-diff` objects render structurally
- [ ] 4.4 Test: a pruned/absent diff point yields a clear error, not an empty diff
- [ ] 4.5 Test: each verb returns immediately with no change occurring (no long-poll)
- [ ] 4.6 Test: `snapshot` without `--object` on a multi-object monitor lists keys and returns no body; single-object monitor returns its snapshot
- [ ] 4.7 Test: `summary` output contains the specified facets and no snapshot/diff text
- [ ] 4.8 Docker-backed CLI test exercising the real CLI → socket contract for the three verbs

## 5. Release collateral

- [ ] 5.1 Add a changeset for `@agentmonitors/cli` (and `@agentmonitors/core` if its public API changes)
- [ ] 5.2 Regenerate the core API report if public types change (`pnpm --filter @agentmonitors/core run fix:api-report`)
- [ ] 5.3 Document the verbs in `apps/website`

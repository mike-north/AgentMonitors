## 2026-06-13 — Tick reports errored observations instead of a silent `emitted 0` (002 §2.4, §10.1, §10.2)

`RuntimeTickResult` gains an `erroredObservations: { monitorId, message }[]` field, populated from the
same code path that writes each `errored` row to `observation_history` (single source of truth, no
re-scan). `daemon once` and the `daemon run` periodic tick log now surface a non-zero errored count and
each errored monitor's id + message without a verbose flag — e.g.
`Evaluated 3 monitor(s), emitted 0 event(s), 1 errored:` followed by `  <monitorId>: <message>` lines.
Previously the tick printed a clean `emitted 0 event(s)` even when a monitor's `observe()` threw, so an
author could not distinguish a genuine no-change (not a bug) from a broken source. The genuine
no-change case is unchanged (no errored line — the command must not "cry wolf").

- **Proof:** `libs/core/src/runtime/service.test.ts` (errored monitor surfaced on the tick result with
  its message, including the non-Error throw fallback; a no-change tick has empty `erroredObservations`);
  `apps/cli/src/commands/cli.integration.test.ts` (`daemon once error visibility (issue #117)`: error-only,
  genuine no-change, and a mixed errored/emitted/no-change tick all reported truthfully).
- Minor changeset: `@agentmonitors/core` (new `erroredObservations` field + `ErroredObservation` in the
  public surface) and `@agentmonitors/cli` (user-visible tick output).


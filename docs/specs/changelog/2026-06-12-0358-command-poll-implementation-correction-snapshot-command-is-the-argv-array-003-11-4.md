## 2026-06-12 — `command-poll` implementation correction: `snapshot.command` is the argv array (003 §11.4)

Corrected `changedObservation()` in `plugins/source-command-poll/src/index.ts`: `snapshot.command`
was incorrectly set to `scope.objectKey` (the joined-argv string or `key` override) instead of the
argv array (`scope.command`). §11.4 specifies `snapshot: { command, exitCode, stdoutLength,
strategy }` where `command` is the argv array — matching `payload.command`. This was a behavioral
deviation from the spec; the spec wording is unchanged (it was always correct).

Also tightened `isCommandState()` to require `typeof truncated === 'boolean'`, preventing a
malformed `previousState` (e.g. `truncated: "yes"`) from being accepted and re-persisted through
the failure-path state carry-forward.


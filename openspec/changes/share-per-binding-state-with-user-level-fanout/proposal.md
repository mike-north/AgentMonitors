## Why

Ephemeral monitors and project-relative user-level fan-out (#258 — one user-level definition bound
to N workspaces/sessions) share the same underlying need: per-binding, session-or-workspace-scoped
durable state — a distinct baseline, cursor, and unread stream per binding. If the two features are
built independently they risk diverging into two parallel per-binding state models that must be
kept consistent forever. This change fixes the constraint that they compose on one model.

Refs #258. Source: 007 §4.7 (second bullet, "Per-binding fan-out").

## What Changes

- Require that the per-binding durable state used by user-level fan-out bindings (#258) is the same
  model ephemeral monitors already use — the per-recipient `session_object_cursor` primitive plus
  the per-session `session_event_state` unread stream — rather than a second, parallel model.

No spec/code contradiction is resolved. The ephemeral half is current (ephemeral monitors already
key per-recipient diffs on `session_object_cursor`, per the `agent/ephemeral-monitors` capability);
the fan-out half is target (#258 is not implemented — 001/003 currently reject bare-relative globs in
user-level monitors with an error referencing #258).

Possible overlap: the user-level fan-out feature itself (bare-relative globs, N workspace-scoped
instances) is owned by the monitor-definition / file-fingerprint capabilities and may have its own
change for #258; this change only adds the composition constraint on the ephemeral side.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `agent/ephemeral-monitors`: adds the requirement that per-binding state is shared with fan-out
  bindings.

## Impact

- Principles relied on: AP7 (one pipeline), SP5 (snapshot/cursor keying), session isolation and
  durability invariants.
- `libs/core/src/runtime/store.ts` (`session_object_cursor`, `session_event_state`) when #258 is
  implemented; no immediate code change for ephemeral monitors.

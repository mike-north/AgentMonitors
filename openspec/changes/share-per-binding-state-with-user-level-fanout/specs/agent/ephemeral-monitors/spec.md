## ADDED Requirements

### Requirement: One per-binding state model shared with fan-out bindings

Ephemeral monitors and project-relative user-level fan-out bindings (#258) MUST compose on one durable per-binding-state model: each binding (an ephemeral monitor's declaring session, or a fanned-out workspace/session binding) SHALL get its own baseline, cursor, and unread stream through the same `session_object_cursor` per-recipient cursor and `session_event_state` primitives, and the two features MUST NOT diverge into parallel state models.

#### Scenario: Fan-out binding uses the ephemeral cursor primitive

- **GIVEN** a user-level monitor fanned out to workspaces `W1` and `W2`, and an ephemeral watch declared in `W1`
- **WHEN** each fires for object `k`
- **THEN** each binding's baseline/cursor lives in a `session_object_cursor` row keyed by its own recipient and `(monitorId, objectKey, workspacePath)`, and its unread stream in `session_event_state`
- **AND** no separate fan-out-only or ephemeral-only cursor table exists

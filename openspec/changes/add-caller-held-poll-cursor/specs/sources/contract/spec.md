## ADDED Requirements

### Requirement: Poll sources may thread a caller-held cursor

A poll source MAY thread a caller-held cursor through the polled tool instead of caching output or gating on file mtimes. The cursor SHALL live in the source's per-monitor `nextState` slot (the stateful baseline of PP6), so the polled tool stays stateless and merely answers "what changed since `<cursor>`?"; the runtime remains the sole diff producer.

#### Scenario: Cursor persists in nextState

- **GIVEN** a poll monitor whose previous run extracted cursor `42`
- **WHEN** the runtime calls `observe()` again
- **THEN** `context.previousState` carries cursor `42` and the polled tool receives `42` as its "since" argument

#### Scenario: Tool holds no hidden state

- **WHEN** the same cursor value is supplied to the polled tool twice
- **THEN** the tool answers identically both times because the cursor, not the tool, carries the position

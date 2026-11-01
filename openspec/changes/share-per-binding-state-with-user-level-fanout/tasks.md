## 1. Design alignment

- [ ] 1.1 In the #258 fan-out design, model each fanned-out binding's baseline/cursor/unread stream on `session_object_cursor` + `session_event_state`, the primitives ephemeral monitors already use

## 2. Tests

- [ ] 2.1 Integration test: a fanned-out user-level monitor and an ephemeral watch each keep an isolated per-binding cursor and unread stream via the shared primitives, surviving a daemon restart
- [ ] 2.2 Regression test: an ephemeral watch's per-recipient diff behavior is unchanged after fan-out lands

## 3. Release collateral

- [ ] 3.1 Add a changeset if published package behavior or public types change
- [ ] 3.2 Regenerate the core API report if public types change (`pnpm --filter @agentmonitors/core run fix:api-report`)

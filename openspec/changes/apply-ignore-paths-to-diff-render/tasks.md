## 1. Carry ignore-paths to the renderer

- [ ] 1.1 Expose `command-poll`'s top-level `change-detection.ignore-paths` in the observation's snapshot metadata next to `strategy`
- [ ] 1.2 Read the ignore paths from persisted snapshot metadata wherever the runtime renders a `json-diff` `diffText` (shared diff, per-recipient diff, claim-time `net` recomputation)
- [ ] 1.3 Strip the ignored fields from both sides before structural diff rendering, using the same path syntax the source applies

## 2. Tests

- [ ] 2.1 Unit test (`diff.test.ts`): ignored field churn plus a real change renders only the real change
- [ ] 2.2 Unit test: 25 ignored-field changes plus one real change renders the real change with no elision marker from ignored fields
- [ ] 2.3 Integration test through a runtime tick with a real `command-poll` `json-diff` monitor asserting the persisted `monitor_events.diff_text` excludes the ignored field
- [ ] 2.4 Integration test for the claim-time `net` recomputation path excluding ignored fields after a persistence round-trip

## 3. Release collateral

- [ ] 3.1 Add a changeset for `@agentmonitors/core` and `@agentmonitors/source-command-poll`
- [ ] 3.2 If any public type changes, regenerate api reports (`pnpm --filter <pkg> run fix:api-report`)
- [ ] 3.3 Update `apps/website` `command-poll` / `json-diff` docs to state ignored fields no longer appear in delivered diffs

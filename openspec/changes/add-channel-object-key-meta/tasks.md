## 1. Core enrichment

- [ ] 1.1 Add `objectKey` to `DeliveryEventSummary` and populate it wherever delivery claims and reservations are built
- [ ] 1.2 Regenerate the core API report (`pnpm --filter @agentmonitors/core run fix:api-report`) and commit the diff

## 2. Channel rendering

- [ ] 2.1 Emit `meta.object_key` for single-event, non-coalesced claims in `channel-render.ts`, through the existing meta sanitization

## 3. Tests

- [ ] 3.1 Unit test: single-event claim → `meta.object_key` equals the event's `objectKey`
- [ ] 3.2 Unit test: multi-event and coalesced claims emit no `object_key`
- [ ] 3.3 Unit test: an `objectKey` containing `<`, `>`, `[`, `]`, `;`, or a newline is sanitized in `meta`
- [ ] 3.4 Runtime test: claimed `DeliveryEventSummary` carries `objectKey`

## 4. Release and docs

- [ ] 4.1 Add changesets for `@agentmonitors/core` (public type) and `@agentmonitors/cli`
- [ ] 4.2 Update the channel field-schema docs in `apps/website`

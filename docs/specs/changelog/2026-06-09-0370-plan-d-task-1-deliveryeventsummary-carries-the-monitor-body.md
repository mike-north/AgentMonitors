## 2026-06-09 — Plan D Task 1: `DeliveryEventSummary` carries the monitor `body`

- A new required field `body: string` is added to `DeliveryEventSummary`
  (`libs/core/src/runtime/types.ts`). It carries the raw monitor body-instructions
  (`MonitorEventRecord.body`, set from `observation.body ?? monitor.instructions`), so a delivery
  transport can surface what the agent should **do** when a monitor fires — not just the
  `title`/`summary`.
- `claimDelivery()` in `service.ts` populates `body: event.body` in both places that map events to
  `DeliveryEventSummary`: the settled-high (`turn-interruptible`) path and the recap
  (`post-compact`) path. The `normal` and `low` paths return `events: []` and are unaffected.
- `DeliveryEventSummary` is re-exported from the public index; the api-extractor rollup
  (`dist/public.d.ts`) is updated to include the new field.
- [002 §9.1](./002-runtime-delivery.md) and [002 §9.4](./002-runtime-delivery.md) updated to
  document the `body` field. [006](./006-agent-integration.md) updated to reflect the enrichment.


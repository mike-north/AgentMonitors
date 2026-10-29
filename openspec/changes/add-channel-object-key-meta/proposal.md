## Why

The channel notification field schema reserves an `object_key` meta attribute — the event's
`objectKey`, the identity of the specific object that changed — but the channel cannot emit it because
`DeliveryEventSummary` does not carry `objectKey`. Routing identity belongs in `meta`, never in
attacker-influenceable `content`, so without it a channel-connected agent has no structured way to
know which object a single-event push is about.

Source: 006 §4.2 (`object_key` row and "Stage-1 coverage": "`object_key` is target and requires
further enrichment; it is not yet emitted"), 006 §4.6 (identity references belong in `meta`), and the
G7 non-blocking follow-up in `docs/specs/roadmap.md`. No GitHub issue is filed yet.

## What Changes

- Enrich `DeliveryEventSummary` with the event's `objectKey` (public `@agentmonitors/core` type).
- `channel serve` emits `meta.object_key` for single-event, non-coalesced claims, sanitized like every
  other meta value.

Principles: AP3 (host-specific meta stays in the transport), PP4. Resolves no contradiction; it fills a
documented gap.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `delivery/channel-transport`: the "Channel meta fields" requirement gains `object_key`.

## Impact

- `libs/core` runtime delivery types (`DeliveryEventSummary`) and the claim builder; core API report.
- `apps/cli/src/channel-render.ts`.
- Changesets for `@agentmonitors/core` and `@agentmonitors/cli`; `apps/website` channel docs.

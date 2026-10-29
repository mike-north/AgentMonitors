## MODIFIED Requirements

### Requirement: Channel meta fields

`meta` SHALL carry `lifecycle` (`turn-interruptible` | `turn-idle` | `post-compact`), `mode` (the claim's
mode), `event_count`, and `urgency` (`low` | `normal` | `high`) when the claim has one. It SHALL carry
`monitor_id`, `event_id`, and `object_key` (the event's `objectKey`, sanitized like every meta value)
only for a claim with exactly one event and no `coalescedReminder`.

#### Scenario: Single-event high claim

- **WHEN** a claim carries one event (monitor `build-config-drift`, event `01J…`, object key `/repo/package.json`) and no coalesced reminder
- **THEN** `meta` includes `monitor_id="build-config-drift"`, `event_id="01J…"`, `object_key="/repo/package.json"`, `urgency="high"`, `event_count="1"`, `lifecycle="turn-interruptible"`

#### Scenario: Multi-event claim

- **WHEN** a claim carries three events
- **THEN** `meta` has no `monitor_id`, `event_id`, or `object_key` and `event_count="3"`

#### Scenario: Object key with tag-breakout characters

- **WHEN** a single event's `objectKey` is `a<b>;c`
- **THEN** `meta.object_key` contains none of `<`, `>`, `;`, and the object key never appears in `content` as routing data

## ADDED Requirements

### Requirement: Delivery event summaries carry the object key

`DeliveryEventSummary` SHALL carry the event's `objectKey`, so transports can route object identity as
metadata without re-reading events.

#### Scenario: Claim exposes object key

- **WHEN** a `file-fingerprint` event for `/repo/package.json` is claimed
- **THEN** its `DeliveryEventSummary.objectKey` is `/repo/package.json`

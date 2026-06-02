import type { DeliveryClaim } from '@mike-north/core';

// Channel `meta` values become tag attributes, so strip anything that could
// break out of the tag (matching the bundled reference channels). Newlines and
// `;` are illegal in attribute context too, so they go here.
const META_STRIP = /[<>[\]\r\n;]/g;
// Channel `content` is the tag body — newlines are fine, but still remove the
// angle/bracket characters that could be read as nested tags. Source-derived
// text reaches here, so treat it as untrusted (006 §4.6).
const CONTENT_STRIP = /[<>[\]\r]/g;
const MAX_CONTENT = 4000;

function metaValue(value: string): string {
  return value.replace(META_STRIP, ' ').trim();
}

/**
 * Render a runtime {@link DeliveryClaim} into the `{ content, meta }` shape of a
 * `notifications/claude/channel` event (006 §4.2). Pure and side-effect free.
 */
export function renderChannelEvent(claim: DeliveryClaim): {
  content: string;
  meta: Record<string, string>;
} {
  const content = claim.message
    .replace(CONTENT_STRIP, ' ')
    .slice(0, MAX_CONTENT);

  const meta: Record<string, string> = {
    lifecycle: claim.lifecycle,
    mode: claim.mode,
    event_count: String(claim.events.length),
  };
  if (claim.urgency) {
    meta['urgency'] = claim.urgency;
  }
  // Per-event routing only makes sense for a single concrete event; a coalesced
  // claim is summarized at the claim level.
  if (claim.events.length === 1) {
    const event = claim.events[0];
    if (event) {
      meta['monitor_id'] = event.monitorId;
      meta['event_id'] = event.eventId;
    }
  }

  // 006 §4.6: ALL meta values must be tag-breakout-sanitized — defense in depth,
  // even for fields that are currently constrained enums/counts.
  for (const key of Object.keys(meta)) {
    const value = meta[key];
    if (value !== undefined) {
      meta[key] = metaValue(value);
    }
  }

  return { content, meta };
}

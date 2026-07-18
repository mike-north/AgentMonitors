import type { DeliveryClaim } from '@agentmonitors/core';
import { buildEventBlock } from './delivery-event-render.js';

// Channel `meta` values become tag attributes, so strip anything that could
// break out of the tag (matching the bundled reference channels). Newlines and
// `;` are illegal in attribute context too, so they go here.
const META_STRIP = /[<>[\]\r\n;]/g;
// Channel `content` is the tag body — newlines are fine, but still remove the
// angle/bracket characters that could be read as nested tags. Source-derived
// text reaches here, so treat it as untrusted (006 §4.6).
const CONTENT_STRIP = /[<>[\]\r]/g;

function metaValue(value: string): string {
  return value.replace(META_STRIP, ' ').trim();
}

/** Sanitize `content` text for the `<channel>` tag body (006 §4.6). */
function contentValue(value: string): string {
  return value.replace(CONTENT_STRIP, ' ');
}

/**
 * Render a runtime {@link DeliveryClaim} into the `{ content, meta }` shape of a
 * `notifications/claude/channel` event (006 §4.2). Pure and side-effect free.
 *
 * The tag body carries the **same event content** the hook-deliver transport
 * injects (issue #436, 006 §6): a body-injection claim (a settled high-urgency
 * delivery, whose `events` are populated) renders one block per event —
 * `### monitor (urgency)` / title / the monitor's body-instructions / a bounded
 * `Changes:` summary of the diff — via the transport-shared {@link
 * buildEventBlock}, so the channel surface is equivalent to the hook surface,
 * differing only in per-transport content sanitization. A reminder claim
 * (`normal`/`low`, which carries no event bodies — only a coalesced advisory
 * `message`) renders that message as-is (subject to the same tag-safety
 * sanitization as the body-injection path), staying generic (002 §9.2).
 *
 * **The channel surface is NOT length-bounded (006 §5.5).** Unlike the
 * hook-deliver transport — whose `additionalContext` is a single injected string
 * capped at 4000 chars, forcing whole-block sizing so it never claims an event it
 * cannot show — the channel reserves and commits the FULL delivered set with no
 * `maxEvents`, so it MUST render every event it claims. Capping `content` here
 * would break spec 006 §5.5's invariant that **the claimed set equals the
 * rendered set**: an early block exhausting a cap would drop later blocks from the
 * rendered tag while the channel still committed the whole claim, silently
 * omitting claimed-but-unrendered events. Per-event change summaries remain
 * individually bounded inside {@link buildEventBlock} (006 §4.6, currently 800
 * chars each) so no single untrusted diff is dumped wholesale; unbounded growth
 * is only in the number of coalesced events, all of which are claimed and so must
 * all surface.
 */
export function renderChannelEvent(claim: DeliveryClaim): {
  content: string;
  meta: Record<string, string>;
} {
  // Body-injection claim → render the concrete event blocks (title + monitor
  // body + bounded change summary), matching the hook path. Reminder claim (no
  // events) → the coalesced advisory message, kept generic. No overall cap: the
  // channel claims the full delivered set (006 §5.5), so it renders all of it.
  const content =
    claim.events.length > 0
      ? claim.events
          .map((event) => buildEventBlock(event, contentValue))
          .join('\n\n')
      : contentValue(claim.message);

  // A reminder claim carries no concrete events (`events: []`), so `event_count`
  // must NOT read 0 — it counts the pending events the reminder refers to (the
  // session's unread total). A body-injection claim reports the number of
  // coalesced events it actually surfaced (issue #436).
  const eventCount =
    claim.events.length > 0 ? claim.events.length : claim.unreadCounts.total;

  const meta: Record<string, string> = {
    lifecycle: claim.lifecycle,
    mode: claim.mode,
    event_count: String(eventCount),
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

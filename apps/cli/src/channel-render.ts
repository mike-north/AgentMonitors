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
const MAX_CONTENT = 4000;

/**
 * Appended to channel `content` cut at {@link MAX_CONTENT}. The tag body lands
 * in the agent's context window, so a large coalesced delivery is bounded here
 * (006 §4.6) — the marker tells the agent the surfaced content is partial and
 * points at the durable, re-discoverable source of the rest. Truncation never
 * loses an event: the rows stay unread until acknowledged (BP2), so anything cut
 * here is still listed by `agentmonitors events list --unread` (issue #436).
 */
const CONTENT_TRUNCATION_MARKER =
  '\n\n[truncated — run `agentmonitors events list --unread` to see the rest]';

function metaValue(value: string): string {
  return value.replace(META_STRIP, ' ').trim();
}

/** Sanitize `content` text for the `<channel>` tag body (006 §4.6). */
function contentValue(value: string): string {
  return value.replace(CONTENT_STRIP, ' ');
}

/**
 * Cap `content` at {@link MAX_CONTENT} code units, cutting at a Unicode
 * code-point boundary (never splitting a surrogate pair) and appending
 * {@link CONTENT_TRUNCATION_MARKER} when truncation occurs, so the
 * marker-included result stays ≤ the cap.
 */
function capContent(content: string): string {
  if (content.length <= MAX_CONTENT) return content;
  const budget = Math.max(0, MAX_CONTENT - CONTENT_TRUNCATION_MARKER.length);
  let out = '';
  for (const ch of content) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + CONTENT_TRUNCATION_MARKER;
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
 * differing only in per-transport content sanitization and cap. A reminder claim
 * (`normal`/`low`, which carries no event bodies — only a coalesced advisory
 * `message`) renders that message as-is (subject to the same tag-safety
 * sanitization and length cap as the body-injection path), staying generic
 * (002 §9.2).
 */
export function renderChannelEvent(claim: DeliveryClaim): {
  content: string;
  meta: Record<string, string>;
} {
  // Body-injection claim → render the concrete event blocks (title + monitor
  // body + bounded change summary), matching the hook path. Reminder claim (no
  // events) → the coalesced advisory message, kept generic.
  const rawContent =
    claim.events.length > 0
      ? claim.events
          .map((event) => buildEventBlock(event, contentValue))
          .join('\n\n')
      : contentValue(claim.message);
  const content = capContent(rawContent);

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

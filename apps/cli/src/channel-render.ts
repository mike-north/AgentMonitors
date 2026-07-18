import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import {
  buildEventBlock,
  packEventsUnderCap as packSharedEventsUnderCap,
} from './delivery-event-render.js';

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
 * Ceiling on how much rendered content one `notifications/claude/channel`
 * push may carry (006 §5.5). Restoring rendering-parity with the hook path
 * (issue #436) — full event bodies plus a bounded change summary per event —
 * made a coalesced push's SIZE unbounded again (bodies and the number of
 * coalesced events have no cap; only the per-event `diffText`, §4.6, does).
 * Unlike the hook-deliver transport's 4000-char single-turn injection budget,
 * the channel surfaces a push outside a specific turn's context budget, so
 * this ceiling is deliberately much larger — several multiples of the hook
 * cap — while still bounding worst-case payload size for one JSON-RPC
 * notification. The invariant that makes this safe (006 §5.5, "claimed set
 * equals rendered set") is preserved: the ceiling sizes how many WHOLE event
 * blocks are RESERVED/CLAIMED (`packChannelEventsUnderCap`, used by
 * `channel.ts` before calling `reserveDelivery`), never how many of an
 * already-claimed set are rendered — `renderChannelEvent` still renders every
 * event in the claim it is given.
 */
export const MAX_CHANNEL_CONTENT = 20_000;

/**
 * Appended to `content` when the channel deferred some settled high-urgency
 * events beyond this push's ceiling (`options.moreDeferred` on
 * {@link renderChannelEvent}) — the deferred events stay pending and
 * re-deliver on a later poll (006 §5.5). Deliberately bracket-free (no
 * `<`/`>`/`[`/`]`) so it never needs `contentValue` sanitization itself: a
 * marker that had to be stripped of its own punctuation would render
 * confusingly (e.g. missing brackets around a command name).
 */
export const CHANNEL_DEFERRED_MARKER =
  '\n\n(more monitor updates are pending; they will surface on a later poll)';

/**
 * How many WHOLE high-urgency event blocks (from `events`, oldest-first) a
 * channel push can render under {@link MAX_CHANNEL_CONTENT} (006 §5.5). Mirrors
 * the hook-deliver transport's `packEventsUnderCap` (`hook-deliver-render.ts`,
 * issue #299): `channel.ts` calls this on the settled-high preview BEFORE
 * reserving, so it can pass the result as `reserveDelivery`'s `maxEvents` — the
 * claimed/reserved set is sized to what will actually be rendered, never more.
 * Blocks are joined by a blank line (`\n\n`), matching {@link renderChannelEvent}'s
 * body-injection join, with no fixed header (unlike the hook's lead-line
 * header). Returns 0 for an empty list; at least 1 for a non-empty list (forward
 * progress even when a single event's own block exceeds the ceiling).
 */
export function packChannelEventsUnderCap(
  events: DeliveryEventSummary[],
  cap: number = MAX_CHANNEL_CONTENT,
): number {
  return packSharedEventsUnderCap(events, contentValue, cap, {
    joiner: '\n\n',
    markerLength: CHANNEL_DEFERRED_MARKER.length,
  });
}

/** Optional signals for {@link renderChannelEvent}. */
export interface RenderChannelEventOptions {
  /**
   * The channel deferred additional settled high-urgency events beyond the
   * ones in this claim (`packChannelEventsUnderCap` sized the claim to fewer
   * than the full settled-high preview): they were left unclaimed to re-deliver
   * on a later poll, so the rendered `content` MUST carry
   * {@link CHANNEL_DEFERRED_MARKER} even though every event IN this claim
   * fits.
   */
  moreDeferred?: boolean;
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
 * **The channel surface IS bounded (006 §5.5), but by packing WHOLE event
 * blocks under {@link MAX_CHANNEL_CONTENT} BEFORE reserving, never by cutting
 * an already-claimed render.** `renderChannelEvent` itself renders every event
 * in the `claim` it is given — it never drops a block to fit a cap. The
 * boundedness instead lives in `channel.ts`: it previews the settled-high
 * delivery, sizes how many whole blocks fit via
 * {@link packChannelEventsUnderCap}, and reserves/claims exactly that many
 * (`reserveDelivery`'s `maxEvents`), so the deferred remainder stays pending
 * and re-delivers on a later poll. This is what makes claimed-set-equals-
 * rendered-set (006 §5.5) compatible with boundedness: capping `content` here,
 * after commit, would have dropped later blocks from the rendered tag while
 * the whole claim was still committed — silently omitting claimed-but-
 * unrendered events. When the caller passes `options.moreDeferred` (some
 * settled-high events did not make this push), {@link CHANNEL_DEFERRED_MARKER}
 * is appended so the agent knows more is pending. Per-event change summaries
 * remain individually bounded inside {@link buildEventBlock} (006 §4.6,
 * currently 800 chars each) so no single untrusted diff is dumped wholesale
 * regardless of packing.
 */
export function renderChannelEvent(
  claim: DeliveryClaim,
  options: RenderChannelEventOptions = {},
): {
  content: string;
  meta: Record<string, string>;
} {
  // Body-injection claim → render the concrete event blocks (title + monitor
  // body + bounded change summary), matching the hook path. Reminder claim (no
  // events) → the coalesced advisory message, kept generic. `renderChannelEvent`
  // renders every event it is given; boundedness is enforced upstream by
  // packing WHOLE blocks under the ceiling before reserving (006 §5.5).
  let content =
    claim.events.length > 0
      ? claim.events
          .map((event) => buildEventBlock(event, contentValue))
          .join('\n\n')
      : contentValue(claim.message);
  if (claim.events.length > 0 && (options.moreDeferred ?? false)) {
    content += CHANNEL_DEFERRED_MARKER;
  }

  // A reminder claim carries no concrete events (`events: []`), so `event_count`
  // must NOT read 0 — it counts the pending events the reminder refers to (the
  // session's unread total). A body-injection claim reports the number of
  // events actually reserved/claimed/rendered THIS push (issue #436) — with
  // packing, that is always exactly `claim.events.length`, so the count
  // genuinely equals the surfaced set even when some settled-high events were
  // deferred to a later poll.
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

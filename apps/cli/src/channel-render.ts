import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import {
  appendMarkerWithinCap,
  buildEventBlock,
  packEventsUnderCap as packSharedEventsUnderCap,
  packWholeBlocks,
  type PackedBlocks,
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
 * `channel.ts` before calling `reserveDelivery`), never by dropping a block
 * from an already-claimed render. `renderChannelEvent` still carries a
 * defense-in-depth truncation for the one case sizing cannot prevent: a
 * single event whose own block already exceeds this ceiling (or a claim whose
 * actual events differ from what was sized — issue #442) — see its doc
 * comment.
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
 * Appended when the ONE claimed event's own block already exceeds {@link
 * MAX_CHANNEL_CONTENT} (minus marker room) and had to be mid-truncated
 * (issue #442, PR #442 round-5 review). Unlike {@link CHANNEL_DEFERRED_MARKER},
 * this claim IS committed by `reserveDelivery` before render — `channel.ts`
 * sets `first_notified_at` on the reservation, and
 * `pendingEventsForSession()` only returns rows where that column is still
 * `NULL` (002 §7), so the omitted tail of THIS event will NOT surface on a
 * later poll: the cycle goes idle. Its only recovery path is the durable,
 * unread copy of the full event (claiming ≠ acking, BP2 / SP4), discoverable
 * via `agentmonitors events list --unread` — so this marker points there
 * instead of promising a later re-delivery. Deliberately bracket-free (no
 * `<`/`>`/`[`/`]`) for the same tag-safety reason as
 * {@link CHANNEL_DEFERRED_MARKER}: it never needs `contentValue` sanitization
 * itself.
 */
export const CHANNEL_TRUNCATED_MARKER =
  '\n\n(this update was too large to show in full; run `agentmonitors events list --unread` to see the full copy)';

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

/** The result of {@link resolveChannelClaimFit}. */
export interface ChannelClaimFit {
  /**
   * Whether {@link renderChannelEvent} will render EVERY block in `events`
   * WHOLE for the given `moreDeferred` flag — i.e. nothing in the claim gets
   * cut, though {@link CHANNEL_DEFERRED_MARKER} may still be appended when
   * `moreDeferred` is true even though nothing was cut. This is the fit
   * question `channel.ts`'s post-reserve check needs (issue #442): did the
   * ACTUAL claim survive rendering intact?
   */
  fits: boolean;
  /**
   * How many whole blocks fit under the EFFECTIVE budget the renderer will
   * use for this claim — at least 1 for a non-empty claim (forward
   * progress), matching {@link packChannelEventsUnderCap}'s semantics.
   */
  includedCount: number;
  /** Blocks packed at the FULL `cap` (no marker room reserved). */
  whole: PackedBlocks;
  /** Blocks packed at `cap − CHANNEL_DEFERRED_MARKER.length` — the budget
   * {@link renderChannelEvent} actually uses whenever a marker will be
   * appended. */
  reserved: PackedBlocks;
}

/**
 * Determine whether {@link renderChannelEvent} will render every block of
 * `events` WHOLE, checked against the SAME effective budget the renderer
 * itself uses (issue #442, PR #442 round-3 review). This is the ONE place
 * that decision is computed: both `renderChannelEvent` (deciding whether to
 * append {@link CHANNEL_DEFERRED_MARKER} and, if so, how many blocks make the
 * cut) and `channel.ts`'s `reserveSizedChannelDelivery` (deciding whether the
 * just-reserved ACTUAL claim needs to be released and re-sized) call this
 * function, so the two sizing predicates can never diverge.
 *
 * Before this was shared, `channel.ts` validated the actual claim against the
 * FULL `MAX_CHANNEL_CONTENT` via `packChannelEventsUnderCap`, while
 * `renderChannelEvent` repacks with room reserved for the marker whenever one
 * will be needed (`moreDeferred`, or the count check itself would defer). A
 * claim whose joined length landed between `(cap − marker)` and `cap` passed
 * the channel.ts check (it fit under the full cap) but was then silently
 * shrunk by the renderer — the committed set no longer equalled the rendered
 * set, while `meta.event_count` still reported the full committed count.
 */
export function resolveChannelClaimFit(
  events: DeliveryEventSummary[],
  moreDeferred: boolean,
  cap: number = MAX_CHANNEL_CONTENT,
): ChannelClaimFit {
  const blocks = events.map((event) => buildEventBlock(event, contentValue));
  const whole = packWholeBlocks(blocks, cap, { joiner: '\n\n' });
  const reserved = packWholeBlocks(
    blocks,
    cap - CHANNEL_DEFERRED_MARKER.length,
    {
      joiner: '\n\n',
    },
  );
  if (whole.includedCount === blocks.length && !moreDeferred) {
    return { fits: true, includedCount: blocks.length, whole, reserved };
  }
  const includedCount = Math.max(1, reserved.includedCount);
  return {
    fits: includedCount === blocks.length,
    includedCount,
    whole,
    reserved,
  };
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
 * **The channel surface IS bounded (006 §5.5), primarily by packing WHOLE
 * event blocks under {@link MAX_CHANNEL_CONTENT} BEFORE reserving, not by
 * cutting an already-claimed render.** The boundedness mostly lives in
 * `channel.ts`: it previews the settled-high delivery, sizes how many whole
 * blocks fit via {@link packChannelEventsUnderCap}, and reserves/claims
 * exactly that many (`reserveDelivery`'s `maxEvents`), so the deferred
 * remainder stays pending and re-delivers on a later poll. This is what makes
 * claimed-set-equals-rendered-set (006 §5.5) compatible with boundedness in
 * the common case: capping `content` here, after commit, would otherwise drop
 * later blocks from the rendered tag while the whole claim was still
 * committed — silently omitting claimed-but-unrendered events.
 *
 * `renderChannelEvent` still carries its OWN defense-in-depth ceiling
 * enforcement (issue #442), because sizing upstream cannot rule out every
 * over-cap case: {@link packChannelEventsUnderCap} deliberately returns at
 * least 1 for a non-empty list (forward progress) even when a single event's
 * own block exceeds the ceiling, and a reserve can race the earlier preview
 * (`channel.ts`'s `reserveSizedChannelDelivery`) so the actually-claimed
 * events can differ from what was sized. So `renderChannelEvent` packs the
 * claim's OWN blocks under {@link MAX_CHANNEL_CONTENT} again here: when every
 * block fits (the expected, common case), nothing is cut. When it doesn't —
 * or the caller passes `options.moreDeferred` (some settled-high events did
 * not make this push) — {@link CHANNEL_DEFERRED_MARKER} is appended, sized
 * with room reserved so no INCLUDED block is cut. Only in the single
 * pathological case where even the first block alone exceeds
 * `MAX_CHANNEL_CONTENT − CHANNEL_DEFERRED_MARKER.length` is it mid-truncated
 * at a Unicode code-point boundary (mirroring the hook-deliver transport's
 * `renderHookDelivery`), using the distinct {@link CHANNEL_TRUNCATED_MARKER}
 * — its full body stays unread (claiming ≠ acking, BP2 / SP4), and because
 * this claim is already committed, the omitted tail will NOT surface on a
 * later poll (issue #442): the durable unread copy is the only recovery
 * path. Per-event change summaries are ALSO individually bounded inside
 * {@link buildEventBlock} (006 §4.6, currently 800 chars each), so no single
 * untrusted diff is dumped wholesale regardless of packing.
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
  // events) → the coalesced advisory message, kept generic. Boundedness is
  // enforced upstream (packing WHOLE blocks under the ceiling before
  // reserving, 006 §5.5) — but this pack-and-truncate is repeated here as a
  // defense-in-depth ceiling enforcement (issue #442): sizing upstream cannot
  // rule out every over-cap case (see the doc comment above).
  let content: string;
  if (claim.events.length > 0) {
    const moreDeferred = options.moreDeferred ?? false;
    const blocks = claim.events.map((event) =>
      buildEventBlock(event, contentValue),
    );
    const fit = resolveChannelClaimFit(
      claim.events,
      moreDeferred,
      MAX_CHANNEL_CONTENT,
    );
    if (fit.whole.includedCount === blocks.length && !moreDeferred) {
      // Every claimed block fits and nothing was deferred → no marker.
      content = fit.whole.text;
    } else if (fit.reserved.includedCount >= 1) {
      // A marker is needed (some claimed blocks did not fit here, and/or the
      // caller deferred more): repack reserving marker room so no INCLUDED
      // block is cut.
      content = fit.reserved.text + CHANNEL_DEFERRED_MARKER;
    } else {
      // Even the first block alone exceeds (cap − marker): mid-truncate it
      // at a code-point boundary. This is the ONLY case a durable event is
      // shown partially. Unlike the branch above, THIS claim is already
      // committed (`first_notified_at` set) — the omitted tail will NOT
      // surface on a later poll (issue #442), so it uses the distinct
      // `CHANNEL_TRUNCATED_MARKER`, which points at the durable unread copy
      // (`agentmonitors events list --unread`) instead of promising a later
      // re-delivery (claiming ≠ acking, 006 §5.5).
      const firstBlock = blocks[0] ?? '';
      content = appendMarkerWithinCap(
        firstBlock,
        MAX_CHANNEL_CONTENT,
        CHANNEL_TRUNCATED_MARKER,
      );
    }
  } else {
    content = contentValue(claim.message);
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

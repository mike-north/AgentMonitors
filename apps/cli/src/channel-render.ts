import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import {
  appendMarkerWithinCap,
  buildEventBlock,
  escapeShellPath,
  packEventsUnderCap as packSharedEventsUnderCap,
  packWholeBlocks,
  truncateWithMarker,
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
 * Build the marker appended when the ONE claimed event's own block already
 * exceeds {@link MAX_CHANNEL_CONTENT} (minus marker room) and had to be
 * mid-truncated (issue #442, PR #442 round-5/round-6 review). Unlike {@link
 * CHANNEL_DEFERRED_MARKER}, this event is not merely deferred — its own
 * content was cut short by THIS render. The omitted tail is recoverable via
 * the durable, unread copy of the full event (claiming ≠ acking, BP2 / SP4)
 * right now — but whether it will ALSO resurface via a later ordinary poll
 * of the same row is genuinely unresolved at render time (see the three-way
 * commit outcome below, issue #442, PR #442 round-12 review); the marker
 * deliberately promises only the former, not the latter.
 *
 * **This is rendered BEFORE the reservation is committed** (`channel.ts`'s
 * `reserveAndCommit`: reserve → push/render → commit, issue #442, PR #442
 * round-11 review) — `commitDeliveryClient` is the call that sets
 * `first_notified_at`, and it only runs AFTER this push resolves. So at
 * render time it is genuinely unknown which of THREE outcomes the commit
 * will land on (issue #442, PR #442 round-12 review — collapsing these to
 * two conflates a definite outcome with a genuinely uncertain one):
 *
 * - **Resolves non-null** — committed: the row is claimed, and
 *   `pendingEventsForSession()` (which excludes rows with `first_notified_at`
 *   set, 002 §7) will never surface it again on an ordinary poll.
 * - **Resolves null** — the reservation's lease already lapsed
 *   (`'surfaced-uncommitted'`, `channel.ts`): the row was definitely never
 *   claimed, so it stays eligible for at-least-once redelivery.
 * - **Rejects** (an IPC/transport error) — UNCERTAIN, not a third definite
 *   outcome: the daemon may have applied the commit before its response was
 *   lost, so whether the row ends up claimed or still pending cannot be
 *   determined from the rejection alone.
 *
 * The wording below asserts only what holds regardless of all three
 * outcomes — the full copy is unread and reachable right now via the
 * recovery command — mirroring the hook transport's
 * `buildHookClaimedUnreadMarker` (`hook-deliver-render.ts`),
 * which has the identical render-before-commit ordering and uncertainty.
 *
 * `agentmonitors events list` **requires** `--session <id>` (issue #420 P2,
 * `apps/cli/src/commands/events.ts`) — a bare `agentmonitors events list
 * --unread` exits 1, so a marker advertising that alone left the ONLY stated
 * recovery path for a committed oversized event unusable (PR #442 round-6
 * review). The marker instead renders the exact, directly executable
 * command for the session that received THIS delivery, taking `sessionId`
 * from the claim itself and sanitizing it the same way every other
 * claim-derived field reaching this tag body is sanitized (§4.6) — an id
 * that happened to carry a tag-breakout or attribute-breakout character
 * would otherwise corrupt the rendered command or the surrounding tag.
 *
 * Deliberately bracket-free (no `<`/`>`/`[`/`]`) for the same tag-safety
 * reason as {@link CHANNEL_DEFERRED_MARKER}, aside from the sanitized session
 * id it embeds: the surrounding marker text never needs `contentValue`
 * sanitization itself.
 *
 * The caller ({@link renderChannelEvent}) passes this marker's length to
 * {@link appendMarkerWithinCap}, which computes its truncation budget from
 * the marker's ACTUAL length — so the varying length of a longer or shorter
 * session id (and, now, socket path) is already accounted for in cap sizing;
 * no separate adjustment is needed at the call site.
 *
 * `socketPath`, when provided, is rendered as an explicit `--socket <path>`
 * so the advertised command is reliably runnable regardless of
 * `$AGENTMONITORS_SOCKET` (issue #358, PR #442 round-7 review): `channel
 * serve` may be bound to an **enabled workspace's own persisted/derived
 * socket** (`resolveChannelSocketPath`, `channel.ts`), which takes precedence
 * over a stale `AGENTMONITORS_SOCKET` left over from a different workspace —
 * but `agentmonitors events list` itself resolves env-first
 * (`resolveManualDaemonSocketPath`, issue #335), so a copy-pasted command with
 * no `--socket` could silently query the wrong (or a dead) daemon. The path is
 * escaped with {@link escapeShellPath} — NOT `metaValue`/`contentValue`, since
 * both of those strip the very tag-breakout characters a raw path could
 * contain rather than round-tripping them — so it stays both tag-safe (006
 * §4.6) and shell-safe, and reconstructs to the exact original path when the
 * advertised command is run (issue #442, PR #442 round-8 review). Omitted (no
 * `--socket` clause) only when the caller genuinely has no socket to
 * advertise.
 */
export function buildChannelTruncatedMarker(
  sessionId: string,
  socketPath?: string,
): string {
  const safeSessionId = metaValue(sessionId);
  const socketClause = socketPath
    ? ` --socket ${escapeShellPath(socketPath)}`
    : '';
  return `\n\n(this update was too large to show in full; run \`agentmonitors events list --session ${safeSessionId}${socketClause} --unread\` to see the full copy)`;
}

/**
 * The action step this transport appends to a reminder-only (`normal`/`low`)
 * claim's semantic `message` (PR #445 review, finding 2). The runtime's
 * `reminderMessage()` (`libs/core/src/runtime/service.ts`) states only the
 * transport-neutral fact that changes are pending; each transport supplies
 * its own concrete next step. Unlike the hook transport (whose reminder step
 * names `agentmonitors events ack` directly, `hook-deliver-render.ts`'s
 * `buildHookReminderActionStep`), a channel-connected agent acknowledges
 * through the `agentmon_ack` MCP tool the server's own `instructions` already
 * describe (`channel.ts`).
 *
 * **Inspection is a PREREQUISITE, not an alternative (PR #445 review, finding
 * 2, round 2).** A prior wording offered `agentmon_ack` as an "or" alternative
 * to listing details — but `agentmon_ack` called with no `event_ids`
 * acknowledges EVERY unread event for the session (`channel-ack.ts`'s
 * `ACK_TOOL`/`parseAckArgs`: omitting `event_ids` means "all unread"), not
 * just the ones this reminder refers to. Read literally, the "or" phrasing's
 * most direct path — call `agentmon_ack` with no arguments — silently
 * acknowledges unrelated, never-seen cross-band events (e.g. a `low`-urgency
 * reminder's blanket ack also clearing unread `high`-urgency work the
 * recipient never inspected). The corrected instruction sequences the two
 * steps instead: list this session's unread events first, THEN call
 * `agentmon_ack` with exactly the `event_id` values of the ones actually
 * handled — never the bare, no-argument form. The `events list` command
 * carries an explicit `--socket <path>` (issue #358, PR #445 review finding
 * 4) so it can't silently query a stale `$AGENTMONITORS_SOCKET`.
 */
function buildChannelReminderActionStep(
  sessionId: string,
  socketPath: string | undefined,
): string {
  const safeSessionId = metaValue(sessionId);
  const socketClause = socketPath
    ? ` --socket ${escapeShellPath(socketPath)}`
    : '';
  return (
    ' Run ' +
    `\`agentmonitors events list --session ${safeSessionId}${socketClause} --unread\` ` +
    'to see them, then call the agentmon_ack tool with the event_id values of the ones you handled.'
  );
}

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
  /**
   * The daemon socket path THIS `channel serve` poll is actually bound to
   * (`resolveChannelSocketPath`, `channel.ts`). Threaded into
   * {@link buildChannelTruncatedMarker} so the mid-truncation marker's
   * advertised recovery command carries an explicit `--socket <path>` (issue
   * #358, PR #442 round-7 review) rather than relying on
   * `$AGENTMONITORS_SOCKET`, which `events list` resolves env-first and can
   * point at a stale or different workspace's daemon.
   */
  socketPath?: string;
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
 * sanitization as the body-injection path).
 *
 * Attribution is transport-owned (issue #438): the runtime emits a SEMANTIC
 * reminder `message` with no product-name prefix, and this transport adds
 * NONE — the enclosing `<channel source="agentmonitors">` tag already names
 * the source, so an "AgentMon" prefix here would double-attribute. (The hook
 * transport, whose `additionalContext` arrives unlabeled, prepends its own
 * label instead — see `hook-deliver-render.ts`'s `HOOK_ATTRIBUTION_PREFIX`.)
 *
 * **The channel surface IS bounded (006 §5.5), primarily by packing WHOLE
 * event blocks under {@link MAX_CHANNEL_CONTENT} BEFORE reserving, not by
 * cutting an already-claimed render.** The boundedness mostly lives in
 * `channel.ts`: it previews the settled-high delivery, sizes how many whole
 * blocks fit via {@link packChannelEventsUnderCap}, and reserves/claims
 * exactly that many (`reserveDelivery`'s `maxEvents`), so the deferred
 * remainder stays pending and re-delivers on a later poll. This is what makes
 * claimed-set-equals-rendered-set (006 §5.5) compatible with boundedness in
 * the common case: capping `content` here, after the claim was already
 * reserved, would otherwise drop later blocks from the rendered tag while the
 * whole claim was still eligible to be committed — silently omitting
 * claimed-but-unrendered events (rendering runs BEFORE commit, see
 * {@link buildChannelTruncatedMarker}'s doc comment).
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
 * `renderHookDelivery`), using the distinct marker built by {@link
 * buildChannelTruncatedMarker} — its full body stays unread (claiming ≠
 * acking, BP2 / SP4); the durable unread copy, at the exact session-scoped
 * command the marker renders, is the only recovery path for the omitted
 * tail (issue #442; see {@link buildChannelTruncatedMarker}'s doc comment
 * for why the marker cannot also promise the tail will never resurface —
 * this render happens before the reservation is committed). When `options
 * .moreDeferred` is ALSO true in this branch (mixed case, issue #442, PR
 * #442 round-12 review), {@link CHANNEL_DEFERRED_MARKER} is appended too —
 * the mid-truncated event's own tail and the separately-deferred remainder
 * are two distinct, non-overlapping facts, and signposting only one would
 * silently drop the other (mirroring `renderHookDelivery`'s identical mixed
 * case). Per-event change summaries are ALSO individually
 * bounded inside
 * {@link buildEventBlock} (006 §4.6, currently 800 chars each), so no single
 * untrusted diff is dumped wholesale regardless of packing.
 *
 * When `claim.coalescedReminder` is set (issue #441 cross-monitor coalescing:
 * a due normal-urgency reminder was folded into this settled-high batch), its
 * text is appended as a sanitized, cap-reserved footer after the packed event
 * blocks — mirroring `renderHookDelivery`'s identical handling (PR #456 review
 * finding 2).
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
    // A coalesced normal-urgency reminder (issue #441, PR #456 review finding
    // 2): reserved BEFORE packing event blocks (not appended after) so its own
    // length never pushes the render over `MAX_CHANNEL_CONTENT`. Mirrors
    // `renderHookDelivery`'s identical footer — see its doc comment for why
    // this is required at all (`claim.events`/`claim.message` carry no
    // representation of the coalesced reminder on their own, yet
    // `claimDelivery` claims the coalesced normal rows alongside the surfaced
    // high events). Per #445's wording contract (002 §9.2 / 006 §5.1.1) the
    // runtime emits ONLY the transport-neutral reminder body; this transport
    // appends its OWN acknowledge step ({@link buildChannelReminderActionStep},
    // pointing at the `agentmon_ack` MCP tool — never the hook's CLI ack verb),
    // exactly as the reminder-only branch below does, so the coalesced reminder
    // is self-sufficient and actionable on the channel surface too.
    const reminderFooter = claim.coalescedReminder
      ? `\n\n${contentValue(claim.coalescedReminder)}${buildChannelReminderActionStep(
          claim.sessionId,
          options.socketPath,
        )}`
      : '';
    const effectiveCap = MAX_CHANNEL_CONTENT - reminderFooter.length;
    const fit = resolveChannelClaimFit(
      claim.events,
      moreDeferred,
      effectiveCap,
    );
    if (fit.whole.includedCount === blocks.length && !moreDeferred) {
      // Every claimed block fits and nothing was deferred → no marker.
      content = fit.whole.text + reminderFooter;
    } else if (fit.reserved.includedCount >= 1) {
      // A marker is needed (some claimed blocks did not fit here, and/or the
      // caller deferred more): repack reserving marker room so no INCLUDED
      // block is cut.
      content = fit.reserved.text + CHANNEL_DEFERRED_MARKER + reminderFooter;
    } else {
      // Even the first block alone exceeds (cap − marker): mid-truncate it
      // at a code-point boundary. This is the ONLY case a durable event is
      // shown partially. This render happens BEFORE the reservation is
      // committed (`channel.ts`'s reserve → push/render → commit ordering),
      // so at render time the eventual commit outcome for THIS event's own
      // tail is genuinely unknown (see `buildChannelTruncatedMarker`'s doc
      // comment for the three-way outcome this implies) — the marker points
      // at a directly runnable
      // `agentmonitors events list --session <id> --unread` for THIS claim's
      // session (issue #442, PR #442 round-6 review — a bare `--unread`
      // without `--session` exits 1) rather than promising a specific
      // claimed/redelivery outcome for this event's own tail (claiming ≠
      // acking, 006 §5.5).
      //
      // Mixed case (issue #442, PR #442 round-12 review): `moreDeferred` can
      // ALSO be true here — this claim's single (oversized) event is the
      // only one actually reserved, but genuinely more settled-high work
      // exists beyond it and stays pending (the reservation/claim was sized
      // to just this one event). Rendering the truncated-event marker alone
      // would silently suppress that second, distinct signal, contradicting
      // §5.5's candidate-growth guarantee (and diverging from the hook
      // transport's `renderHookDelivery`, which renders both of its
      // analogous markers in the same mixed case). Render BOTH markers
      // whenever both apply — they describe two different, non-overlapping,
      // outcome-neutral facts (this event's own tail is recoverable via the
      // exact session+socket unread command; additional distinct work
      // remains pending and will surface on a later poll) and are never
      // redundant with each other. Both are sized within
      // {@link MAX_CHANNEL_CONTENT} by `appendMarkerWithinCap`'s
      // marker-length budget, which is computed from the COMBINED marker's
      // actual length.
      const firstBlock = blocks[0] ?? '';
      const truncatedMarker = buildChannelTruncatedMarker(
        claim.sessionId,
        options.socketPath,
      );
      const marker = moreDeferred
        ? truncatedMarker + CHANNEL_DEFERRED_MARKER
        : truncatedMarker;
      content =
        appendMarkerWithinCap(firstBlock, effectiveCap, marker) +
        reminderFooter;
    }
  } else {
    // Reminder claim (`normal`/`low`, no events): the runtime's semantic
    // message plus this transport's own action step (agentmon_ack, not the
    // hook's CLI ack verb — see `buildChannelReminderActionStep`). Bounded by
    // {@link MAX_CHANNEL_CONTENT} like every other branch here (PR #445
    // review, finding 5) — latent today (the reminder is short), but this was
    // previously the one render path in the file without the #442
    // defense-in-depth ceiling. If truncation is ever needed, this is THIS
    // claim's own content being cut (not other pending work deferred), so it
    // uses {@link buildChannelTruncatedMarker} — mirroring the hook
    // transport's identical choice for its reminder-truncation case
    // (`hook-deliver-render.ts`'s `buildHookClaimedUnreadMarker` usage).
    const actionStep = buildChannelReminderActionStep(
      claim.sessionId,
      options.socketPath,
    );
    content = truncateWithMarker(
      `${contentValue(claim.message)}${actionStep}`,
      MAX_CHANNEL_CONTENT,
      buildChannelTruncatedMarker(claim.sessionId, options.socketPath),
    );
  }

  // A reminder claim carries no concrete events (`events: []`), so `event_count`
  // must NOT read 0 — it counts the pending events the reminder refers to (the
  // session's unread total). A body-injection claim reports the number of
  // events actually reserved/claimed/rendered THIS push (issue #436) — with
  // packing, that is always exactly `claim.events.length`, so the count
  // genuinely equals the surfaced set even when some settled-high events were
  // deferred to a later poll.
  //
  // Coalesced case (issue #441, PR #456 review): when `claim.coalescedReminder`
  // is set, the claimed set is `events` (the surfaced high events) PLUS the
  // folded-in normal rows the reminder refers to (`coalescedNormalCount`) —
  // `claimDelivery` claims both. Reporting `events.length` alone would
  // under-report the claimed set and invite a scoped ack (via the event_id
  // values in `event_count`'s neighboring meta) that leaves the coalesced
  // normal rows claimed-but-unacknowledged, durably muting the session's
  // normal reminders (`service.ts`'s `normalPending.length ===
  // unreadNormal.length` gate never re-fires until they're acked).
  const eventCount = claim.coalescedReminder
    ? claim.events.length + (claim.coalescedNormalCount ?? 0)
    : claim.events.length > 0
      ? claim.events.length
      : claim.unreadCounts.total;

  const meta: Record<string, string> = {
    lifecycle: claim.lifecycle,
    mode: claim.mode,
    event_count: String(eventCount),
  };
  if (claim.urgency) {
    meta['urgency'] = claim.urgency;
  }
  // Per-event routing only makes sense for a single concrete event that is
  // ALSO the claim's entire claimed set — a coalesced claim (even one with
  // exactly one high event) always claims additional normal rows alongside
  // it, so it is summarized at the claim level, never routed to that one
  // event's own monitor_id/event_id (issue #441, PR #456 review: a scoped ack
  // built from a single-event's ids would leave the coalesced rows unacked).
  if (claim.events.length === 1 && !claim.coalescedReminder) {
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

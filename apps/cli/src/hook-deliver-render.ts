import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import {
  appendMarkerWithinCap as appendSharedMarkerWithinCap,
  buildEventBlock as buildSharedEventBlock,
  escapeShellPath,
  packEventsUnderCap as packSharedEventsUnderCap,
  packWholeBlocks as packSharedWholeBlocks,
  truncateWithMarker,
} from './delivery-event-render.js';

export const MAX_ADDITIONAL_CONTEXT = 4000;

const LEAD_LINE =
  'AgentMon: monitored changes are pending — consider handling them before continuing.';

/**
 * Render the `--socket <path>` clause shared by both hook markers below, or
 * `''` when no socket was supplied. `socketPath`, when provided, is the
 * daemon socket THIS hook invocation actually resolved and claimed against
 * (`hook.ts`'s `socketPath` — the workspace's own persisted/derived socket,
 * which can differ from `$AGENTMONITORS_SOCKET`, issue #358). `agentmonitors
 * events list` itself resolves env-first (`resolveManualDaemonSocketPath`,
 * issue #335), so a copy-pasted recovery command with no `--socket` could
 * silently query a stale or different workspace's daemon (PR #442 round-7
 * review). Escaped with the transport-shared {@link escapeShellPath} (issue
 * #442, PR #442 round-8 review) — shared with the channel transport's
 * `buildChannelTruncatedMarker` — so the advertised command both stays safe to
 * paste verbatim (spaces, quotes) AND reconstructs to the exact original
 * socket path when run.
 */
function socketClause(socketPath: string | undefined): string {
  return socketPath ? ` --socket ${escapeShellPath(socketPath)}` : '';
}

/**
 * Build the marker appended when a WHOLE event block was left OUT of this
 * render — either because it did not fit under the cap, or because the
 * caller deferred more (`options.moreDeferred`) — but genuinely stays
 * **pending** (`first_notified_at` still `NULL`): `claimDeliveryClient` only
 * claimed the events actually rendered, so the omitted remainder re-delivers
 * at the next context event (006 §5.1/§5.5). "more monitor updates are
 * pending" is therefore an accurate promise for THIS branch only — see
 * {@link buildHookClaimedUnreadMarker} for the synchronously-claimed
 * single-event mid-truncation branch, which must NOT reuse this framing
 * (issue #442, PR #442 round-7 review — the two branches were previously
 * rendered by one marker, falsely implying the mid-truncated event's own
 * omitted tail would also redeliver).
 *
 * `agentmonitors events list` **requires** `--session <id>` (issue #420 P2,
 * `apps/cli/src/commands/events.ts`) — a bare `agentmonitors events list
 * --unread` exits 1, so the marker renders the exact, directly executable
 * command for the session that received THIS delivery, taking `sessionId`
 * from the claim itself and sanitizing it the same way every other
 * claim-derived field reaching this payload is sanitized (see
 * {@link sanitize}) — an id that happened to carry a raw control character
 * would otherwise corrupt the rendered command.
 *
 * The caller passes this marker's own length to {@link packEventsUnderCap}
 * and {@link truncateForCap} — so the varying length of a longer or shorter
 * session id (and, now, socket path) is already accounted for in cap sizing;
 * no separate adjustment is needed at each call site.
 */
function buildHookDeferredMarker(
  sessionId: string,
  socketPath?: string,
): string {
  const safeSessionId = sanitize(sessionId);
  return `\n\n[truncated — more monitor updates are pending; run \`agentmonitors events list --session ${safeSessionId}${socketClause(socketPath)} --unread\` to see the rest]`;
}

/**
 * Build the marker appended when THIS claim's own render was cut short but
 * the underlying row is ALREADY claimed (`claimDeliveryClient` sets
 * `first_notified_at` synchronously, before this render runs) — so, unlike
 * {@link buildHookDeferredMarker}, the omitted content will NOT surface again
 * via the ordinary context-event flow (`pendingEventsForSession` never
 * returns a claimed row, 006 §5.1/§5.5). Used for: (1) the single-event
 * mid-truncation branch (one event's own block exceeds the cap and is shown
 * partially), and (2) a reminder claim (`normal`/`low`, no event blocks) whose
 * coalesced `message` itself is long enough to need truncating — both are
 * this SAME claim's own content being cut, not other pending work being
 * deferred (issue #442, PR #442 round-7 review). Its only recovery path is
 * the durable, still-unread copy of the full event (claiming ≠ acking, BP2 /
 * SP4), so the framing says so explicitly instead of promising a redelivery
 * that will not happen — mirroring the channel transport's
 * `buildChannelTruncatedMarker` (`channel-render.ts`).
 *
 * **Not valid for a `post-compact` recap** — see {@link buildHookRecapMarker}.
 */
function buildHookClaimedUnreadMarker(
  sessionId: string,
  socketPath?: string,
): string {
  const safeSessionId = sanitize(sessionId);
  return `\n\n[truncated — this update was too large to show in full; it is claimed but NOT acknowledged, so the full copy stays unread (it will not redeliver automatically) — run \`agentmonitors events list --session ${safeSessionId}${socketClause(socketPath)} --unread\` to see it]`;
}

/**
 * Build the marker used for a truncated `post-compact` **recap** — lifecycle-
 * aware, distinct from both {@link buildHookDeferredMarker} and
 * {@link buildHookClaimedUnreadMarker} (issue #442, PR #442 round-9 review).
 *
 * Neither of those two markers is TRUE for a recap. A recap's decision
 * (`decideDelivery`'s `post-compact` branch, `service.ts`) reads ALL unread
 * events for the session and claims the FULL unread set at apply time
 * (`applyDelivery` claims `decision.candidates`, not just the rendered
 * `recapSlice`) — but recap re-SOURCES from `unreadEventsForSession`, not
 * `pendingEventsForSession`, so a row being claimed (`first_notified_at` set)
 * never hides it from a FUTURE recap; only acknowledging does (§5.5). That
 * means:
 *
 * - {@link buildHookDeferredMarker}'s "more monitor updates are pending ...
 *   run `events list --unread` to see the rest" is misleading here: the
 *   omitted whole blocks are not "pending" in the ordinary sense (they were
 *   already claimed along with the rest of the recap's candidate set) —
 *   they will not redeliver at "the next context event" the way a genuinely
 *   unclaimed `turn-interruptible` event would.
 * - {@link buildHookClaimedUnreadMarker}'s "it will not redeliver
 *   automatically" is actively FALSE for a recap: the omitted/cut content
 *   WILL reappear, automatically, on the next `post-compact` recap (and any
 *   after that) until it is acknowledged — that is the intentional self-heal
 *   behavior §5.5 documents.
 *
 * So a recap needs its own truthful framing regardless of which of
 * {@link renderHookDelivery}'s two truncation branches (whole-blocks-omitted,
 * or a single event's own block mid-truncated) produced it — both are, for a
 * recap, the SAME fact: this content is claimed-but-unacknowledged and will
 * keep re-surfacing on future recaps.
 */
function buildHookRecapMarker(sessionId: string, socketPath?: string): string {
  const safeSessionId = sanitize(sessionId);
  return `\n\n[truncated — not everything fit in this recap; the omitted content is claimed but NOT acknowledged, so it stays unread and will reappear on future recaps until acknowledged — run \`agentmonitors events list --session ${safeSessionId}${socketClause(socketPath)} --unread\` to see it now]`;
}

/**
 * `additionalContext` is a plain JSON string — `JSON.stringify` escapes quotes,
 * backslashes, and control characters when the command serializes the output, so
 * no character is a "JSON injection" vector here. Unlike the channel transport
 * (which embeds text in `<channel>` tag attributes — see channel-render.ts), this
 * field is NOT tag-delimited, so `<`, `>`, `[`, `]`, `;` are inert and must be
 * preserved: a monitor body is trusted, user-authored markdown that routinely
 * contains code (`Array<T>`), links (`[text](url)`), and punctuation, and its
 * multi-line structure carries meaning. We therefore strip only raw C0/C1 control
 * characters (except tab and newline) that could corrupt terminal/log output, and
 * preserve everything else faithfully. Length is capped by the caller.
 */
function sanitize(value: string): string {
  // No trim: leading indentation and deliberate surrounding whitespace are part
  // of a markdown body (e.g. an indented code block), and the transport contract
  // is to preserve structure verbatim.
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl =
      (code < 0x20 && ch !== '\n' && ch !== '\t') ||
      (code >= 0x7f && code <= 0x9f);
    if (!isControl) out += ch;
  }
  return out;
}

/**
 * The exact wire shape a Claude Code hook must print to stdout to inject
 * advisory context at a turn boundary. `continue: true` makes it non-blocking;
 * `hookSpecificOutput` carries the event name and the context text.
 *
 * Advisory delivery MUST NOT include a `permissionDecision` field — the agent
 * decides how to handle the surfaced context (BP2).
 *
 * @see https://docs.claude.ai/en/api/claude-code/hooks
 */
export interface HookDeliveryOutput {
  continue: true;
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

/**
 * Truncate `value` so the returned string is at most `cap` UTF-16 code units,
 * cutting only at a Unicode CODE-POINT boundary (never splitting a surrogate
 * pair) and, when truncation occurs, appending `marker` so the final string —
 * marker included — is still ≤ `cap`. Delegates to the shared
 * {@link truncateWithMarker} (`delivery-event-render.ts`) so this transport and
 * the channel's per-event diff bound share one code-point-safe implementation.
 */
function truncateForCap(value: string, cap: number, marker: string): string {
  return truncateWithMarker(value, cap, marker);
}

/**
 * Append `marker` to `body`, trimming `body` at a Unicode code-point boundary
 * only if the marker would push it past `cap`, so the result (marker
 * included) is always ≤ `cap`. Used for the single pathological case where
 * one event's own block already exceeds the cap and must be shown partially
 * (see {@link renderHookDelivery}).
 */
function appendMarkerWithinCap(
  body: string,
  cap: number,
  marker: string,
): string {
  return appendSharedMarkerWithinCap(body, cap, marker);
}

/** The fixed prefix of a body-injection payload: lead line + blank line. */
const HEADER = `${LEAD_LINE}\n\n`;

/**
 * Render one event as its `additionalContext` block, using the transport-shared
 * block builder so this path and the channel path render the same event
 * equivalently (issue #436, 006 §6). The hook `sanitize` preserves `<>[]` — the
 * `additionalContext` is a JSON string, not tag-delimited (see {@link sanitize}).
 */
function buildEventBlock(event: DeliveryEventSummary): string {
  return buildSharedEventBlock(event, sanitize);
}

/**
 * Greedily accumulate WHOLE event blocks whose assembled string
 * (`header` + blocks joined by `\n`) stays within `cap`. A block is added only
 * when it fits in full, so the visible set maps 1:1 to durable events — never a
 * partially-shown block, which would be a claimed-but-unread event with no clean
 * re-delivery boundary (issue #299). Thin wrapper over the transport-shared
 * {@link packSharedWholeBlocks} (`delivery-event-render.ts`), fixing this
 * transport's `\n` block joiner.
 */
function packWholeBlocks(
  header: string,
  blocks: string[],
  cap: number,
): { text: string; includedCount: number } {
  return packSharedWholeBlocks(blocks, cap, { header, joiner: '\n' });
}

/**
 * How many WHOLE high-urgency event blocks (from `events`, oldest-first) the
 * hook-deliver transport can render under its `additionalContext` cap
 * (006 §5.1, issue #299). The transport uses this to decide how many events to
 * CLAIM, so the claimed set equals the rendered set and the remainder stays
 * pending for the next context event. Thin wrapper over the transport-shared
 * {@link packSharedEventsUnderCap} (`delivery-event-render.ts`), fixing this
 * transport's `sanitize`, lead-line `HEADER`, and the session-scoped
 * truncation marker's length.
 *
 * `sessionId` is the session the sizing decision is being made for (the same
 * id the eventual claim/render will carry) — it MUST size against the marker
 * this session's own {@link buildHookDeferredMarker} produces (the marker
 * `renderHookDelivery` actually appends when whole blocks are deferred), since
 * a longer or shorter session id (and socket path) changes the marker's
 * length and therefore how many whole blocks fit (issue #442).
 *
 * When not everything fits, room is reserved for the truncation marker so no
 * INCLUDED block is cut. At least 1 is returned when there is any event — there
 * must be forward progress: the first event is surfaced (and claimed) even if
 * its own body exceeds the cap, in which case {@link renderHookDelivery}
 * mid-truncates it with the marker pointing at the still-unread full copy.
 * Returns 0 for an empty list.
 */
export function packEventsUnderCap(
  events: DeliveryEventSummary[],
  sessionId: string,
  cap: number = MAX_ADDITIONAL_CONTEXT,
  socketPath?: string,
): number {
  return packSharedEventsUnderCap(events, sanitize, cap, {
    header: HEADER,
    joiner: '\n',
    markerLength: buildHookDeferredMarker(sessionId, socketPath).length,
  });
}

/** The result of {@link resolveHookClaimFit}. */
export interface HookClaimFit {
  /**
   * Whether {@link renderHookDelivery} will render EVERY block in `events`
   * WHOLE for the given `moreDeferred` flag — i.e. nothing in the claim gets
   * cut, though the deferred marker may still be appended when `moreDeferred`
   * is true even though nothing was cut. Mirrors the channel transport's
   * `resolveChannelClaimFit` (`channel-render.ts`) — the fit question
   * `hook.ts`'s post-reserve check needs (issue #442, PR #442 round-8 review):
   * did the ACTUAL reserved claim survive rendering intact?
   */
  fits: boolean;
  /**
   * How many whole blocks fit under the EFFECTIVE budget the renderer will
   * use for this claim — at least 1 for a non-empty claim (forward progress).
   */
  includedCount: number;
  /** Blocks packed at the FULL `cap` (no marker room reserved). */
  whole: PackedHookBlocks;
  /** Blocks packed at `cap − <this session's deferred marker length>` — the
   * budget {@link renderHookDelivery} actually uses whenever a marker will be
   * appended. */
  reserved: PackedHookBlocks;
}

/** The `{ text, includedCount }` shape shared by {@link HookClaimFit}'s two packings. */
export interface PackedHookBlocks {
  text: string;
  includedCount: number;
}

/**
 * Determine whether {@link renderHookDelivery} will render every block of
 * `events` WHOLE, checked against the SAME effective budget the renderer
 * itself uses (issue #442, PR #442 round-8 review).
 *
 * `claimDeliveryClient`/`reserveDeliveryClient`'s `maxEvents` bounds only the
 * candidate **count** — `previewSettledHighDeliveryClient` and the eventual
 * claim/reservation are two SEPARATE IPC round-trips, so the events actually
 * returned can differ from the ones the earlier preview sized `maxEvents`
 * against (a "substitution race": e.g. another transport claims/leases the
 * previewed rows first, and the reservation instead fills the same COUNT from
 * different, larger pending events). Sizing on count alone would then commit
 * (via `claimDelivery`) a set that no longer fits the rendered cap — and
 * because the row is claimed synchronously, the truncated-away tail can
 * **never redeliver** (§5.5). `hook.ts`'s `reserveSizedHookDelivery` calls
 * this function on the ACTUAL reserved claim, before committing, so a
 * mismatch can still be released and retried while the rows are only leased,
 * not yet claimed — mirroring the channel transport's
 * `reserveSizedChannelDelivery`/`resolveChannelClaimFit` pattern exactly.
 */
export function resolveHookClaimFit(
  events: DeliveryEventSummary[],
  sessionId: string,
  socketPath: string | undefined,
  moreDeferred: boolean,
  cap: number = MAX_ADDITIONAL_CONTEXT,
): HookClaimFit {
  const blocks = events.map(buildEventBlock);
  const whole = packWholeBlocks(HEADER, blocks, cap);
  if (whole.includedCount === blocks.length && !moreDeferred) {
    return { fits: true, includedCount: blocks.length, whole, reserved: whole };
  }
  const deferredMarker = buildHookDeferredMarker(sessionId, socketPath);
  const reserved = packWholeBlocks(HEADER, blocks, cap - deferredMarker.length);
  const includedCount = Math.max(1, reserved.includedCount);
  return {
    fits: includedCount === blocks.length,
    includedCount,
    whole,
    reserved,
  };
}

/** Optional signals for {@link renderHookDelivery}. */
export interface RenderHookDeliveryOptions {
  /**
   * The transport deferred additional high-urgency events beyond the ones in
   * this claim (issue #299): they were left unclaimed to re-deliver next context
   * event, so the rendered output MUST carry the truncation marker even when the
   * claimed events themselves fit.
   */
  moreDeferred?: boolean;
  /**
   * The daemon socket path THIS hook invocation actually resolved and claimed
   * against (`hook.ts`'s `socketPath`). Threaded into both marker builders so
   * their advertised recovery command carries an explicit `--socket <path>`
   * (issue #358, PR #442 round-7 review) instead of relying on
   * `$AGENTMONITORS_SOCKET`, which `events list` resolves env-first.
   */
  socketPath?: string;
}

/**
 * Render a {@link DeliveryClaim} into the advisory hook-output payload that a
 * turn-boundary hook prints to stdout. Returns `null` only when there is
 * genuinely nothing to surface — a null claim, or a claim carrying neither
 * event bodies nor a reminder message — so the caller can skip stdout entirely.
 *
 * Two delivery shapes are rendered (issue #198):
 *
 * - **Body injection** — a claim with `events` (settled `high`-urgency
 *   turn-interruptible events, or the `post-compact` recap) renders a lead line
 *   plus a per-event block carrying the monitor body. Blocks are packed WHOLE
 *   under the cap (issue #299): the visible set maps 1:1 to durable events so a
 *   length-bounded transport can claim exactly what it renders. When events are
 *   omitted here — because they did not fit, or because the caller deferred more
 *   via {@link RenderHookDeliveryOptions.moreDeferred} — the marker built by
 *   {@link buildHookDeferredMarker} (a directly runnable `agentmonitors events
 *   list --session <id> --unread` for THIS claim's session, issue #442 — a bare
 *   `--unread` without `--session` exits 1) is appended pointing at the
 *   genuinely-pending rest, which re-delivers at the next context event. Only
 *   when a SINGLE event's own block exceeds the cap is it shown partially
 *   (mid-truncated at a code-point boundary) — this is a DIFFERENT case: the
 *   row is already claimed (`claimDeliveryClient` set `first_notified_at`
 *   synchronously before this render runs), so the omitted tail will NOT
 *   redeliver via the ordinary context-event flow. That branch uses the
 *   distinct {@link buildHookClaimedUnreadMarker} instead (issue #442, PR #442
 *   round-7 review) — its full body stays unread (claiming ≠ acking, BP2 /
 *   SP4), recoverable only via the durable unread copy.
 * - **Reminder line** — a `normal`/`low` turn-boundary claim carries no event
 *   bodies (`events: []`) but a populated `message` (the same advisory line
 *   `hook claim` surfaces). It renders that message as a sanitized, length-capped
 *   reminder line, with **no** body injection — so a default (`normal`-urgency)
 *   monitor produces a visible mid-turn signal instead of silence. The
 *   underlying row is ALREADY claimed (not deferred), so any truncation of the
 *   message itself also uses {@link buildHookClaimedUnreadMarker} — the event
 *   stays unread and re-discoverable via `agentmonitors events list --session
 *   <id> --unread`, but will not redeliver on its own.
 *
 * The renderer is **pure and side-effect-free**: no I/O, no mutation. Text is
 * preserved faithfully (a monitor body is trusted, user-authored markdown) with
 * only raw control characters removed (see {@link sanitize}); the total
 * `additionalContext` is capped so a large diff cannot blow the context window.
 *
 * @param claim - The delivery claim from `claimDeliveryClient`, or null.
 * @param hookEventName - The Claude Code event name to echo (e.g. `"PreToolUse"`).
 * @param options - See {@link RenderHookDeliveryOptions}.
 */
export function renderHookDelivery(
  claim: DeliveryClaim | null,
  hookEventName: string,
  options: RenderHookDeliveryOptions = {},
): HookDeliveryOutput | null {
  if (!claim) return null;

  // A `post-compact` recap is a DIFFERENT lifecycle from a `turn-interruptible`
  // (or `turn-idle`) claim: it intentionally re-shows the full unread set on
  // EVERY recap, regardless of whether a given row already got claimed
  // (§5.5) — so neither of the two markers below is truthful for it. Marker
  // selection is therefore lifecycle-aware (issue #442, PR #442 round-9
  // review): see {@link buildHookRecapMarker}.
  const isRecap = claim.lifecycle === 'post-compact';

  // Built once per claim from its own `sessionId` (issue #442) and the
  // resolved `socketPath` (issue #358, PR #442 round-7 review) so every marker
  // rendered below points at the exact, directly runnable recovery command for
  // THIS claim's session — see {@link buildHookDeferredMarker} and
  // {@link buildHookClaimedUnreadMarker}. The two are DELIBERATELY distinct
  // for a non-recap claim (see their doc comments): the deferred marker
  // promises a redelivery that will actually happen; the claimed-unread
  // marker does not. For a recap, both slots use the SAME recap-aware marker
  // (`buildHookRecapMarker`) — the distinction between "genuinely pending" and
  // "already claimed" doesn't apply: recap re-shows everything unread
  // regardless of claimed state.
  const deferredMarker = isRecap
    ? buildHookRecapMarker(claim.sessionId, options.socketPath)
    : buildHookDeferredMarker(claim.sessionId, options.socketPath);
  const claimedUnreadMarker = isRecap
    ? deferredMarker
    : buildHookClaimedUnreadMarker(claim.sessionId, options.socketPath);

  // Reminder-only delivery (issue #198): a `normal`/`low` turn-boundary claim
  // has no event bodies to inject, only a lightweight advisory `message`. Body
  // injection stays reserved for `high` and the `post-compact` recap (both of
  // which populate `events`), so surface the message as a reminder line instead
  // of emitting nothing. A genuinely empty claim (no events, blank message) is
  // never produced by the runtime — `claimDelivery` returns `null` when nothing
  // is pending — but we still guard for it so the caller stays silent. The
  // underlying row is ALREADY claimed by the time this renders, so a truncated
  // reminder uses the claimed-unread marker, not the deferred one (issue #442,
  // PR #442 round-7 review) — there is no "more updates pending" to promise
  // here; it is THIS claim's own message being cut.
  if (claim.events.length === 0) {
    const reminder = sanitize(claim.message);
    if (reminder.trim().length === 0) return null;
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName,
        additionalContext: truncateForCap(
          reminder,
          MAX_ADDITIONAL_CONTEXT,
          claimedUnreadMarker,
        ),
      },
    };
  }

  const moreDeferred = options.moreDeferred ?? false;
  const blocks = claim.events.map(buildEventBlock);
  const whole = packWholeBlocks(HEADER, blocks, MAX_ADDITIONAL_CONTEXT);

  let additionalContext: string;
  if (whole.includedCount === blocks.length && !moreDeferred) {
    // Every claimed event fits and nothing was deferred → no marker.
    additionalContext = whole.text;
  } else {
    // A marker is needed (some claimed blocks did not fit here, and/or the caller
    // deferred more). Repack reserving marker room so no INCLUDED block is cut.
    // Sized against the DEFERRED marker: this branch only fires when at least
    // one WHOLE block was genuinely left pending (unclaimed), which is exactly
    // what that marker promises.
    const reserved = packWholeBlocks(
      HEADER,
      blocks,
      MAX_ADDITIONAL_CONTEXT - deferredMarker.length,
    );
    if (reserved.includedCount >= 1) {
      additionalContext = reserved.text + deferredMarker;
    } else {
      // Even the first block alone exceeds (cap − marker): mid-truncate block 0
      // at a code-point boundary. This is the ONLY case a durable event is shown
      // partially — and unlike the branch above, THIS event is already claimed,
      // so its own omitted tail will NOT redeliver (issue #442, PR #442 round-7
      // review): use the claimed-unread marker, which says so.
      //
      // Mixed case (issue #442, PR #442 round-8 review): `moreDeferred` can
      // ALSO be true here — this claim's single (oversized) event is the only
      // one actually claimed, but genuinely more high-urgency work exists
      // beyond it and stays pending (the reservation/claim was sized to just
      // this one event). Rendering the claimed-unread marker alone would
      // silently suppress that second, real signal: an agent reading only
      // "this update was too large ... it will not redeliver" would have no
      // idea further, DIFFERENT pending work is queued and genuinely will
      // redeliver. Render BOTH markers whenever both apply — they describe
      // two different, non-overlapping facts (this event's own tail vs. the
      // separate pending remainder) and are never redundant with each other.
      // For a recap, `deferredMarker === claimedUnreadMarker` (both are the
      // same recap marker) and `moreDeferred` is never set true by
      // `reserveSizedHookDelivery` for a non-`turn-interruptible` lifecycle
      // anyway (issue #442, PR #442 round-9 review) — but guard against ever
      // doubling an identical marker regardless.
      const firstBlock = blocks[0] ?? '';
      const marker =
        moreDeferred && claimedUnreadMarker !== deferredMarker
          ? claimedUnreadMarker + deferredMarker
          : claimedUnreadMarker;
      additionalContext = appendMarkerWithinCap(
        HEADER + firstBlock,
        MAX_ADDITIONAL_CONTEXT,
        marker,
      );
    }
  }

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}

/**
 * Render the "monitors exist but this project is not enabled" advisory
 * (issue #269) emitted by `session start`'s quick-exit path. A workspace can
 * have `.claude/monitors/**` definitions authored without ever flipping
 * `.claude/agentmonitors.local.md`'s `enabled: true` — until now that state
 * quick-exited **silently**, so a user who missed the enable step got zero
 * breadcrumb, forever (the worst kind of onboarding dead-end).
 *
 * This uses the SAME `additionalContext` wire mechanism as
 * {@link renderHookDelivery} (§5.1 of the agent-integration spec), but is a
 * fixed advisory template rather than a rendering of a `DeliveryClaim` — there
 * is no daemon, no session, and no claimed delivery in this path (by design;
 * see the non-goals in issue #269: never auto-enable, never boot a daemon).
 * The message text is a fixed template with an interpolated count, so no
 * `sanitize()`/truncation is needed (contrast {@link renderHookDelivery},
 * which injects untrusted monitor-authored body text).
 *
 * The message also names `agentmonitors doctor` (issue #331) — the enable
 * step alone doesn't tell the author whether the monitors they authored are
 * otherwise healthy; `doctor` is the single command that answers that.
 *
 * @param monitorCount - Number of monitor definitions discovered under the
 *   project's `.claude/monitors` directory (both files that parsed
 *   successfully and files that failed to parse — a malformed monitor is
 *   still evidence the user tried to author one, so it still counts toward
 *   "found").
 * @param hookEventName - The Claude Code event name to echo; `session start`
 *   only ever runs from `SessionStart`, so callers pass that literal.
 */
export function renderMonitoringDisabledAdvisory(
  monitorCount: number,
  hookEventName: string,
): HookDeliveryOutput {
  const plural = monitorCount === 1 ? '' : 's';
  const additionalContext =
    `AgentMon: monitoring is disabled for this project ` +
    `(${String(monitorCount)} monitor definition${plural} found under .claude/monitors/, ` +
    `but none of them are being watched). To enable it, create ` +
    '`.claude/agentmonitors.local.md` in this project with `enabled: true`. ' +
    'Run `agentmonitors doctor` any time for the full workspace-health picture.';
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}

import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import {
  appendMarkerWithinCap as appendSharedMarkerWithinCap,
  buildEventBlock as buildSharedEventBlock,
  escapeShellPath,
  packWholeBlocks as packSharedWholeBlocks,
  truncateWithMarker,
} from './delivery-event-render.js';

export const MAX_ADDITIONAL_CONTEXT = 4000;

/**
 * The attribution label this transport prepends to every payload it delivers.
 * Attribution is transport-owned (issue #438): the hook's `additionalContext`
 * arrives in the agent's context window UNLABELED, so the hook adapter names
 * the source itself. The runtime core emits only the semantic message (no
 * product name); the channel transport, whose `<channel source="agentmonitors">`
 * tag already names the source, adds nothing. Keeping this a named constant
 * makes the seam explicit and keeps the two hook shapes (body-injection lead
 * line, reminder line) attributed with the SAME prefix — though not
 * identical casing in the sentence that follows it: {@link LEAD_LINE} (its own
 * fixed advisory text) starts lowercase ("monitored changes…"), while the
 * reminder line prepends this prefix directly to the runtime's own
 * `reminderMessage()` sentence, which starts capitalized ("Monitored
 * changes…") because it also stands on its own in `libs/core` (no prefix)
 * and in the channel transport (no prefix either) — both of the un-prefixed
 * uses need a sentence that reads correctly capitalized on its own (PR #445
 * review, cleanup 7e).
 */
const HOOK_ATTRIBUTION_PREFIX = 'AgentMon: ';

const LEAD_LINE = `${HOOK_ATTRIBUTION_PREFIX}monitored changes are pending — consider handling them before continuing.`;

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
 * The action step this transport appends to a reminder-only (`normal`/`low`)
 * delivery's semantic `message` (PR #445 review, finding 2). The runtime's
 * `reminderMessage()` (`libs/core/src/runtime/service.ts`) states only the
 * transport-neutral fact that changes are pending — attribution AND the
 * concrete next step are both transport-owned (002 §9.2, 006 §5.1.1): this
 * transport names the CLI verbs directly, with an explicit `--socket <path>`
 * (issue #358) so a copy-pasted command can't silently query a stale
 * `$AGENTMONITORS_SOCKET` (PR #445 review, finding 4) — unlike the channel
 * transport, which instead points at its `agentmon_ack` MCP tool
 * (`channel-render.ts`'s reminder branch).
 *
 * The reminder claims the FULL unread set of its own urgency band (the
 * runtime only ever emits this claim when every unread event of that band is
 * still unclaimed — `service.ts`'s `normalPending`/`shouldSendLow` guards), so
 * (unlike the per-batch ack instruction in {@link buildHookAckInstruction})
 * there is no narrower id list to scope the ack to here.
 */
function buildHookReminderActionStep(
  sessionId: string,
  socketPath: string | undefined,
): string {
  const safeSessionId = sanitize(sessionId);
  const socket = socketClause(socketPath);
  return (
    ` Run \`agentmonitors events list --session ${safeSessionId}${socket} --unread\` ` +
    `to see them, then \`agentmonitors events ack --session ${safeSessionId}${socket}\` once handled.`
  );
}

/**
 * Build the marker appended when a WHOLE event block was left OUT of this
 * render — either because it did not fit under the cap, or because the
 * caller deferred more (`options.moreDeferred`) — but genuinely stays
 * **pending** (`first_notified_at` still `NULL`): `claimDeliveryClient` only
 * claimed the events actually rendered, so the omitted remainder re-delivers
 * at the next context event (006 §5.1/§5.5). "more monitor updates are
 * pending" is therefore an accurate promise for THIS branch only — see
 * {@link buildHookClaimedUnreadMarker} for the single-event mid-truncation
 * branch, which must NOT reuse this framing
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
 * Build the marker appended when THIS claim's own render was cut short, but
 * the underlying row's DURABLE claim state is NOT something this render can
 * promise either way. Used for: (1) the single-event mid-truncation branch
 * (one event's own block exceeds the cap and is shown partially), and (2) a
 * reminder claim (`normal`/`low`, no event blocks) whose coalesced `message`
 * itself is long enough to need truncating — both are this SAME claim's own
 * content being cut, not other pending work being deferred (issue #442, PR
 * #442 round-7 review).
 *
 * **Why this can't assert a specific claim/redelivery outcome.** Rendering
 * now happens BEFORE the reservation is committed (`reserveRenderAndCommitHookDelivery`
 * / `writeAndCommitHookDelivery`, `hook.ts`, issue #442, PR #442 round-9/10
 * review), off the reservation's own (not-yet-durable) claim — so at render
 * time it is genuinely unknown which of THREE outcomes the commit that
 * follows will land on (issue #442, PR #442 round-12 review — collapsing
 * these to two conflates a definite outcome with a genuinely uncertain one).
 * A prior version of this marker asserted "it is claimed but NOT
 * acknowledged ... it will not redeliver automatically" — true only if the
 * commit **resolves non-null** (the row is claimed and will never redeliver
 * via the ordinary context-event flow, §5.5); FALSE if the commit
 * **resolves null** (the reservation's lease already lapsed — the row was
 * definitely never claimed, so it stays pending and WILL redeliver); and
 * neither assertion holds if the commit **rejects** (an IPC/transport
 * error) — the daemon may have applied it before the response was lost, so
 * whether the row ends up claimed or still pending is genuinely UNCERTAIN,
 * not a guaranteed redelivery (issue #442, PR #442 round-10/12 review). The
 * wording below asserts only what holds regardless of which of the three
 * outcomes occurs: the full copy is not yet acknowledged, so it stays
 * unread and reachable right now via the recovery command — mirroring the
 * channel transport's `buildChannelTruncatedMarker` (`channel-render.ts`).
 * The channel transport has the SAME render-before-commit ordering
 * (reserve → push/render → commit, `channel.ts`'s `reserveAndCommit`) and
 * therefore the same three-way conditional outcome: a successful (non-null)
 * commit prevents ordinary repoll; a commit that resolves null leaves the
 * pushed event definitely uncommitted and eligible for at-least-once
 * redelivery on a later poll; a rejected commit is neither — so
 * `buildChannelTruncatedMarker` is kept outcome-neutral for the same
 * reason, not because its claim is committed any earlier than this one's.
 *
 * **Not valid for a `post-compact` recap** — see {@link buildHookRecapMarker}.
 */
function buildHookClaimedUnreadMarker(
  sessionId: string,
  socketPath?: string,
): string {
  const safeSessionId = sanitize(sessionId);
  return `\n\n[truncated — this update was too large to show in full; the full copy stays unread — run \`agentmonitors events list --session ${safeSessionId}${socketClause(socketPath)} --unread\` to see it now]`;
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
 * - {@link buildHookDeferredMarker}'s own contract — "more monitor updates
 *   are pending; run `events list --unread` to see the rest" — is a genuine
 *   promise that the omitted rows stay pending and WILL redeliver: it is
 *   built only for rows that were never reserved at all (see its own doc
 *   comment). That promise does not hold here: the recap's omitted whole
 *   blocks ARE part of THIS reservation's candidate set (`applyDelivery`
 *   claims `decision.candidates`, not just the rendered `recapSlice`) and
 *   are about to be claimed once this render's commit lands — not yet
 *   claimed at render time, per the render-before-commit ordering described
 *   below. So whether they end up claimed (and therefore excluded from
 *   ordinary, `pendingEventsForSession`-sourced redelivery) or return to
 *   pending depends on which of the three commit outcomes follows (a null
 *   commit returns them to pending; a resolved non-null commit claims them;
 *   a rejected commit leaves that outcome unknown) — reusing the deferred
 *   marker here would misleadingly borrow a guarantee this reservation
 *   can't back up. The recap marker below is preferred precisely because it
 *   CAN make a guarantee that holds across all three commit outcomes:
 *   future recap resurfacing, which is unaffected by whether THIS commit
 *   claims these rows (§5.5's self-heal re-sources from
 *   `unreadEventsForSession`, not `pendingEventsForSession`).
 * - {@link buildHookClaimedUnreadMarker} (in its current, post-round-10
 *   wording) no longer asserts a redelivery outcome either way — but a
 *   recap's own framing is still distinct: it can (and should) promise the
 *   POSITIVE "will reappear on future recaps" outcome, which is true
 *   regardless of whether THIS recap's own commit lands, because a FUTURE
 *   recap always re-sources from `unreadEventsForSession` (§5.5's self-heal).
 *   The ordinary marker cannot make that promise (a `turn-interruptible`
 *   claim's tail genuinely does NOT redeliver once acknowledged-adjacent
 *   state is uncertain), so it settles for the outcome-agnostic "stays
 *   unread" framing instead — see {@link buildHookClaimedUnreadMarker}'s own
 *   doc comment.
 *
 * So a recap needs its own truthful framing regardless of which of
 * {@link renderHookDelivery}'s two truncation branches (whole-blocks-omitted,
 * or a single event's own block mid-truncated) produced it — both are, for a
 * recap, the SAME fact: this content stays unread and will keep re-surfacing
 * on future recaps until acknowledged. Like {@link buildHookClaimedUnreadMarker},
 * this marker is built from the reservation's own (not-yet-committed) claim
 * (issue #442, PR #442 round-9/10 review) — so it deliberately does NOT
 * assert this content "is claimed" at render time either, only the
 * self-healing future-recap behavior, which holds regardless of this
 * particular commit's outcome.
 */
function buildHookRecapMarker(sessionId: string, socketPath?: string): string {
  const safeSessionId = sanitize(sessionId);
  return `\n\n[truncated — not everything fit in this recap; the omitted content stays unread and will reappear on future recaps until acknowledged — run \`agentmonitors events list --session ${safeSessionId}${socketClause(socketPath)} --unread\` to see it now]`;
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

/**
 * The one-line acknowledge instruction appended to the body-injection header
 * (issue #434). A body-injection delivery (settled high-urgency events, or the
 * `post-compact` recap) CLAIMS the events it renders — but claiming is not
 * acknowledgment (BP2 / SP4), and until the recipient acknowledges, the
 * `coalesced-until-ack` rule (002 §9.2) suppresses only the reminder for the
 * band(s) the claimed events actually belong to (006 §5.1.1) — a `high`-only
 * claim never suppresses a `normal`/`low` reminder, but a mixed-band recap
 * that also claims an old `normal`/`low` event DOES suppress that band's next
 * reminder until it too is acknowledged. The delivered payload used to name
 * no way to acknowledge, so an agent that fully handled the work still left the
 * claimed band silently muted — the remediation lived only in `monitor explain`,
 * which nobody runs while things appear fine. This line closes that loop, in
 * the delivered context itself.
 *
 * **Scoped to the CLAIMED batch, not "ack everything" (PR #445 review,
 * finding 1).** `agentmonitors events ack --session <id>` with no
 * `--event-ids` acknowledges EVERY unread event for the session — including
 * high-urgency events a capped delivery genuinely deferred (they stay
 * pending and re-deliver next context event, per {@link buildHookDeferredMarker})
 * and a recap's own un-rendered tail. A compliant agent that runs the
 * blanket form after handling only the rendered batch would silently
 * acknowledge — and thereby permanently drop from the ordinary redelivery
 * path — events it never saw. `eventIds` is always the exact set THIS render
 * actually included (never the full candidate/claimed set, which can be
 * larger for a recap — see {@link resolveHookHeaderPacking}), so the
 * instruction can never claim more than what the recipient was shown.
 *
 * Emitted ONCE per delivery batch (it lives in the shared header, not per
 * event) and kept terse — this lands in an LLM context window (006 §5.1's
 * injection-size concern). The session id and each event id are sanitized
 * like every other claim-derived field reaching this payload (see
 * {@link sanitize}).
 *
 * **Carries an explicit `--socket <path>` (PR #445 review, finding 1).**
 * `agentmonitors events ack` resolves its daemon socket env-first
 * (`resolveManualDaemonSocketPath`, issue #335) — the SAME class of bug as
 * the truncation-recovery markers (issue #358): a copy-pasted ack with no
 * `--socket` under a stale `$AGENTMONITORS_SOCKET` silently scopes the ack to
 * the WRONG daemon, leaving the real session's events unread and unmuted
 * while the agent believes it acknowledged them. `socketPath` is the same
 * resolved daemon socket already threaded into every other marker in this
 * file (`hook.ts`'s `socketPath`, issue #358) — reusing it here keeps every
 * recovery/ack command in this transport pointed at the same daemon.
 */
function buildHookAckInstruction(
  sessionId: string,
  eventIds: string[],
  socketPath: string | undefined,
): string {
  const idsClause =
    eventIds.length > 0 ? ` --event-ids ${sanitize(eventIds.join(','))}` : '';
  return `When handled, acknowledge: agentmonitors events ack --session ${sanitize(sessionId)}${socketClause(socketPath)}${idsClause}`;
}

/**
 * The prefix of a body-injection payload: the attributed lead line, the
 * per-batch acknowledge instruction (issue #434, scoped to `eventIds` per PR
 * #445 review finding 1), then a blank line before the event blocks.
 * Session- AND event-id-scoped — every sizing path that packs blocks under
 * the cap ({@link packEventsUnderCap}, {@link resolveHookClaimFit},
 * {@link renderHookDelivery}) goes through {@link resolveHookHeaderPacking},
 * which recomputes this header for the ACTUAL set of events that end up
 * included as packing shrinks that set, so the header's true length is
 * always accounted for wherever blocks are fit. Also socket-scoped ({@link
 * buildHookAckInstruction}, PR #445 review finding 1) — every sizing path
 * threads the same resolved `socketPath` so the header's true length
 * (varying with socket path length) is accounted for too.
 */
function buildHeader(
  sessionId: string,
  eventIds: string[],
  socketPath: string | undefined,
): string {
  return `${LEAD_LINE}\n${buildHookAckInstruction(sessionId, eventIds, socketPath)}\n\n`;
}

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

/** The result of {@link resolveHookHeaderPacking}. */
interface HeaderPacked {
  text: string;
  includedCount: number;
  header: string;
}

/**
 * Pack `events`' whole blocks under `cap` with a {@link buildHeader} whose
 * per-batch ack instruction names EXACTLY the ids of the events the packing
 * actually includes (PR #445 review, finding 1) — a fixed point, since the
 * header's own length depends on how many ids it lists, which depends on how
 * much room is left for blocks, which depends on the header's length.
 *
 * **Tests each candidate `k` directly rather than iterating a fixed-point
 * guess (PR #445 review, round-6 finding — the prior iterative-narrowing
 * approach could oscillate: `guess=2` packs 1, the shorter 1-id header then
 * packs 2, `guess` bounces 2→1→2→1… without ever landing on a `k` where the
 * header's named ids equal what's included, falling through to a header that
 * names FEWER ids than the blocks actually rendered — an under-scoped
 * `--event-ids` that lets a compliant ack silently drop unrendered rows).**
 * Descends `k` from `events.length` to `0` and, for each, builds the header
 * naming exactly `events.slice(0, k)` and packs ONLY `blocks.slice(0, k)` — so
 * `packed.includedCount` can never exceed `k` (the input array itself holds no
 * more), and the candidate is self-consistent exactly when all `k` of those
 * blocks fit (`packed.includedCount === k`). `k = 0` (empty header, zero
 * blocks) is always self-consistent, so the descent is guaranteed to return
 * before exhausting the loop — no fixed-point search, no oscillation, no
 * under-scoped header.
 */
function resolveHookHeaderPacking(
  events: DeliveryEventSummary[],
  blocks: string[],
  sessionId: string,
  cap: number,
  socketPath: string | undefined,
): HeaderPacked {
  for (let k = events.length; k >= 0; k--) {
    const eventIds = events.slice(0, k).map((event) => event.eventId);
    const header = buildHeader(sessionId, eventIds, socketPath);
    const packed = packWholeBlocks(header, blocks.slice(0, k), cap);
    if (packed.includedCount === k) {
      return { text: packed.text, includedCount: k, header };
    }
  }
  /* c8 ignore start -- k=0 (no ids named, no blocks attempted) always matches
   * `packed.includedCount === k`, so the loop above always returns by then;
   * this is unreachable and exists only to satisfy the return-type checker. */
  throw new Error(
    'unreachable: resolveHookHeaderPacking did not converge at k=0',
  );
  /* c8 ignore stop */
}

/**
 * How many WHOLE high-urgency event blocks (from `events`, oldest-first) the
 * hook-deliver transport can render under its `additionalContext` cap
 * (006 §5.1, issue #299). The transport uses this to decide how many events to
 * CLAIM, so the claimed set equals the rendered set and the remainder stays
 * pending for the next context event.
 *
 * `sessionId` is the session the sizing decision is being made for (the same
 * id the eventual claim/render will carry) — it MUST size against the marker
 * this session's own {@link buildHookDeferredMarker} produces (the marker
 * `renderHookDelivery` actually appends when whole blocks are deferred), AND
 * against the per-batch ack instruction's own length, which now varies with
 * how many event ids it names ({@link resolveHookHeaderPacking}) — a longer
 * or shorter session id, socket path, or candidate-event-id list all change
 * how many whole blocks fit (issue #442; event-id scoping, PR #445 review).
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
  if (events.length === 0) return 0;
  const blocks = events.map(buildEventBlock);
  const whole = resolveHookHeaderPacking(
    events,
    blocks,
    sessionId,
    cap,
    socketPath,
  );
  if (whole.includedCount === blocks.length) return blocks.length;
  const markerLength = buildHookDeferredMarker(sessionId, socketPath).length;
  const reserved = resolveHookHeaderPacking(
    events,
    blocks,
    sessionId,
    cap - markerLength,
    socketPath,
  );
  return Math.max(1, reserved.includedCount);
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
 *
 * `deferredMarker` defaults to this session's {@link buildHookDeferredMarker}
 * output, which is correct for every `reserveSizedHookDelivery` call site
 * (only ever `turn-interruptible`, never a recap). `renderHookDelivery`,
 * however, MUST pass its own already-selected marker explicitly: a
 * `post-compact` recap claim appends the LONGER {@link buildHookRecapMarker}
 * instead, and this function reserving room for the shorter deferred marker
 * while the caller then appends the longer recap marker on top let the
 * rendered `additionalContext` exceed `cap` (PR #445 review, finding
 * 3611418583) — reserving against the marker that will ACTUALLY be appended
 * is the only way `includedCount` stays truthful for both lifecycles.
 */
export function resolveHookClaimFit(
  events: DeliveryEventSummary[],
  sessionId: string,
  socketPath: string | undefined,
  moreDeferred: boolean,
  cap: number = MAX_ADDITIONAL_CONTEXT,
  deferredMarker: string = buildHookDeferredMarker(sessionId, socketPath),
): HookClaimFit {
  const blocks = events.map(buildEventBlock);
  const whole = resolveHookHeaderPacking(
    events,
    blocks,
    sessionId,
    cap,
    socketPath,
  );
  if (whole.includedCount === blocks.length && !moreDeferred) {
    return { fits: true, includedCount: blocks.length, whole, reserved: whole };
  }
  const reserved = resolveHookHeaderPacking(
    events,
    blocks,
    sessionId,
    cap - deferredMarker.length,
    socketPath,
  );
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
 * Two callers use this renderer, both going through the SAME
 * reserve → render → write → commit flow (`reserveRenderAndCommitHookDelivery`
 * / `writeAndCommitHookDelivery`, `hook.ts`) so neither ever durably commits a
 * reservation before its rendered output has actually been written (issue
 * #442, PR #442 round-9/round-16 review): `hook.ts`'s `hook deliver` action
 * (`turn-interruptible`/`turn-idle` claims, and its own `post-compact` path),
 * and `session.ts`'s `session start` action, which reuses the identical flow
 * for the `post-compact` recap it surfaces from the SAME stdin payload it
 * reads to register the session (a chained `hook deliver` would see an
 * already-consumed stdin and no-op — 006 §5.6). Both callers render off the
 * RESERVATION's own (not-yet-committed) claim, never a claim that has already
 * been durably committed.
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
 *   (mid-truncated at a code-point boundary) — this is a DIFFERENT case: this
 *   render is built from the RESERVATION's own claim, before the reservation
 *   is committed (`hook.ts`'s `reserveRenderAndCommitHookDelivery` /
 *   `writeAndCommitHookDelivery`, issue #442, PR #442 round-9/10 review — the
 *   render→write→commit ordering, not commit→render), so at render time it is
 *   not yet known whether the row will end up durably claimed. That branch
 *   uses the distinct {@link buildHookClaimedUnreadMarker} instead (issue
 *   #442, PR #442 round-7/round-10 review) — its full body stays unread
 *   regardless of which of the three commit outcomes follows (resolves
 *   non-null, resolves null, or rejects — claiming ≠ acking, BP2 / SP4), so
 *   the `events list --unread` command it advertises is the recovery path
 *   guaranteed across EVERY commit outcome, not merely the sole recourse for
 *   an uncommitted one; the marker itself asserts only that outcome-agnostic
 *   fact, never a specific claimed/redelivery direction (round-10 review).
 * - **Reminder line** — a `normal`/`low` turn-boundary claim carries no event
 *   bodies (`events: []`) but a populated `message` (the same advisory line
 *   `hook claim` surfaces). It renders that message as a sanitized, length-capped
 *   reminder line, with **no** body injection — so a default (`normal`-urgency)
 *   monitor produces a visible mid-turn signal instead of silence. Any
 *   truncation of the message itself also uses {@link buildHookClaimedUnreadMarker}
 *   — the event stays unread and re-discoverable via `agentmonitors events
 *   list --session <id> --unread` regardless of whether this delivery's
 *   commit ultimately lands.
 *
 * The renderer is **pure and side-effect-free**: no I/O, no mutation. Text is
 * preserved faithfully (a monitor body is trusted, user-authored markdown) with
 * only raw control characters removed (see {@link sanitize}); the total
 * `additionalContext` is capped so a large diff cannot blow the context window.
 *
 * @param claim - The (not-yet-committed) reservation's claim, or null.
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
  // promises a redelivery that will actually happen (these events were never
  // reserved at all — they stay pending, full stop); the claimed-unread marker
  // makes no redelivery promise either way, since it is rendered from the
  // reservation's own claim before that reservation is committed (issue #442,
  // PR #442 round-9/10 review). For a recap, both slots use the SAME
  // recap-aware marker (`buildHookRecapMarker`) — the distinction between
  // "genuinely pending" and "this claim's own content" doesn't apply: recap
  // re-shows everything unread regardless of this delivery's own commit
  // outcome.
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
  // is pending — but we still guard for it so the caller stays silent. This is
  // THIS claim's own message being cut, not other pending work being deferred,
  // so a truncated reminder uses the claimed-unread marker, not the deferred
  // one (issue #442, PR #442 round-7 review) — there is no "more updates
  // pending" to promise here.
  //
  // The runtime emits a SEMANTIC message with no product-name attribution AND
  // no transport-specific verb (issues #438, #445 review finding 2): this
  // transport owns both its own attribution — prepend
  // {@link HOOK_ATTRIBUTION_PREFIX}, since the hook's `additionalContext`
  // arrives unlabeled (the channel, whose tag already names the source, adds
  // nothing) — and its own concrete, session+socket-scoped action step
  // ({@link buildHookReminderActionStep}); the channel transport instead
  // points at its `agentmon_ack` tool (`channel-render.ts`). The prefix is
  // prepended BEFORE truncation so it always survives at the front even when
  // the semantic body is cut.
  if (claim.events.length === 0) {
    const reminder = sanitize(claim.message);
    if (reminder.trim().length === 0) return null;
    const actionStep = buildHookReminderActionStep(
      claim.sessionId,
      options.socketPath,
    );
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName,
        additionalContext: truncateForCap(
          `${HOOK_ATTRIBUTION_PREFIX}${reminder}${actionStep}`,
          MAX_ADDITIONAL_CONTEXT,
          claimedUnreadMarker,
        ),
      },
    };
  }

  // Body injection: consume {@link resolveHookClaimFit}'s OWN sizing rather
  // than re-inlining `buildHeader` + packing here (PR #445 review, cleanup
  // 7c) — the two were a maintained copy-pair (every prior sizing fix had to
  // land in both places identically), which is exactly the class of drift
  // issue #442 hit once already.
  const moreDeferred = options.moreDeferred ?? false;
  const fit = resolveHookClaimFit(
    claim.events,
    claim.sessionId,
    options.socketPath,
    moreDeferred,
    MAX_ADDITIONAL_CONTEXT,
    // Reserve against the marker THIS render will actually append below
    // (`deferredMarker`, already lifecycle-aware — the recap marker for a
    // `post-compact` claim, the shorter deferred marker otherwise) rather
    // than `resolveHookClaimFit`'s own default, which always assumes the
    // deferred marker regardless of lifecycle (PR #445 review, finding
    // 3611418583).
    deferredMarker,
  );

  let additionalContext: string;
  if (fit.whole.includedCount === claim.events.length && !moreDeferred) {
    // Every claimed event fits and nothing was deferred → no marker.
    additionalContext = fit.whole.text;
  } else if (fit.reserved.includedCount >= 1) {
    // A marker is needed (some claimed blocks did not fit here, and/or the caller
    // deferred more). `fit.reserved` already reserved room for the deferred
    // marker AND named exactly the events it includes in its own header — this
    // branch only fires when at least one WHOLE block was genuinely left
    // pending (unclaimed), which is exactly what that marker promises.
    additionalContext = fit.reserved.text + deferredMarker;
  } else {
    // Even the first block alone exceeds (cap − marker): mid-truncate block 0
    // at a code-point boundary. This is the ONLY case a durable event is shown
    // partially — and unlike the branch above, THIS event's own content is
    // what got cut (not other pending work), so it uses the claimed-unread
    // marker (issue #442, PR #442 round-7/round-10 review) — its outcome-
    // agnostic wording is correct whether or not this delivery's reservation
    // ends up durably committed (see {@link buildHookClaimedUnreadMarker}).
    // Only THIS one event is claimed here, so the header names only its id.
    //
    // Mixed case (issue #442, PR #442 round-8 review): `moreDeferred` can
    // ALSO be true here — this claim's single (oversized) event is the only
    // one actually reserved, but genuinely more high-urgency work exists
    // beyond it and stays pending (the reservation/claim was sized to just
    // this one event). Rendering the claimed-unread marker alone would
    // silently suppress that second, real signal: an agent reading only
    // "the full copy stays unread" would have no idea further, DIFFERENT
    // pending work is queued and genuinely will redeliver. Render BOTH
    // markers whenever both apply — they describe two different,
    // non-overlapping facts (this event's own tail vs. the separate pending
    // remainder) and are never redundant with each other.
    // For a recap, `deferredMarker === claimedUnreadMarker` (both are the
    // same recap marker) and `moreDeferred` is never set true by
    // `reserveSizedHookDelivery` for a non-`turn-interruptible` lifecycle
    // anyway (issue #442, PR #442 round-9 review) — but guard against ever
    // doubling an identical marker regardless.
    const firstEvent = claim.events[0];
    const firstBlock = firstEvent ? buildEventBlock(firstEvent) : '';
    const soleEventHeader = buildHeader(
      claim.sessionId,
      firstEvent ? [firstEvent.eventId] : [],
      options.socketPath,
    );
    const marker =
      moreDeferred && claimedUnreadMarker !== deferredMarker
        ? claimedUnreadMarker + deferredMarker
        : claimedUnreadMarker;
    additionalContext = appendMarkerWithinCap(
      soleEventHeader + firstBlock,
      MAX_ADDITIONAL_CONTEXT,
      marker,
    );
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

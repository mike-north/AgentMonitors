import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import {
  appendMarkerWithinCap as appendSharedMarkerWithinCap,
  buildEventBlock as buildSharedEventBlock,
  packEventsUnderCap as packSharedEventsUnderCap,
  packWholeBlocks as packSharedWholeBlocks,
  truncateWithMarker,
} from './delivery-event-render.js';

const MAX_ADDITIONAL_CONTEXT = 4000;

const LEAD_LINE =
  'AgentMon: monitored changes are pending — consider handling them before continuing.';

/**
 * Build the marker appended when the assembled context is truncated. It tells
 * the agent the visible context is incomplete and points at the durable,
 * re-discoverable source of the rest. Claiming a delivery does NOT
 * acknowledge it (BP2 / SP4): `unreadEventsForSession` filters on
 * `acknowledgedAt IS NULL` only, so an event whose body was truncated away
 * here remains UNREAD and is still listed by `agentmonitors events list
 * --session <id> --unread` (and re-delivered by the next context event). No
 * event is lost by truncation.
 *
 * `agentmonitors events list` **requires** `--session <id>` (issue #420 P2,
 * `apps/cli/src/commands/events.ts`) — a bare `agentmonitors events list
 * --unread` exits 1, so a marker advertising that alone left the ONLY stated
 * recovery path unusable (issue #442, mirroring the channel transport's
 * `buildChannelTruncatedMarker` fix — `channel-render.ts`). The marker
 * instead renders the exact, directly executable command for the session
 * that received THIS delivery, taking `sessionId` from the claim itself and
 * sanitizing it the same way every other claim-derived field reaching this
 * payload is sanitized (see {@link sanitize}) — an id that happened to carry
 * a raw control character would otherwise corrupt the rendered command.
 *
 * The caller passes this marker's own length to {@link packEventsUnderCap},
 * {@link truncateForCap}, and {@link appendMarkerWithinCap} — so the varying
 * length of a longer or shorter session id is already accounted for in cap
 * sizing; no separate adjustment is needed at each call site.
 */
function buildHookTruncatedMarker(sessionId: string): string {
  const safeSessionId = sanitize(sessionId);
  return `\n\n[truncated — more monitor updates are pending; run \`agentmonitors events list --session ${safeSessionId} --unread\` to see the rest]`;
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
 * this session's own {@link buildHookTruncatedMarker} produces, since a longer
 * or shorter session id changes the marker's length and therefore how many
 * whole blocks fit (issue #442).
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
): number {
  return packSharedEventsUnderCap(events, sanitize, cap, {
    header: HEADER,
    joiner: '\n',
    markerLength: buildHookTruncatedMarker(sessionId).length,
  });
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
 *   {@link buildHookTruncatedMarker} (a directly runnable `agentmonitors events
 *   list --session <id> --unread` for THIS claim's session, issue #442 — a bare
 *   `--unread` without `--session` exits 1) is appended pointing at the
 *   still-unread rest. Only when a SINGLE event's own block exceeds the cap is
 *   it shown partially (mid-truncated at a code-point boundary); its full body
 *   stays unread (claiming ≠ acking, BP2 / SP4).
 * - **Reminder line** — a `normal`/`low` turn-boundary claim carries no event
 *   bodies (`events: []`) but a populated `message` (the same advisory line
 *   `hook claim` surfaces). It renders that message as a sanitized, length-capped
 *   reminder line, with **no** body injection — so a default (`normal`-urgency)
 *   monitor produces a visible mid-turn signal instead of silence. The
 *   underlying rows are claimed but NOT acknowledged (BP2 / SP4), so the event
 *   stays unread and re-discoverable via `agentmonitors events list --session
 *   <id> --unread`.
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

  // Built once per claim from its own `sessionId` (issue #442) so every marker
  // rendered below points at the exact, directly runnable recovery command for
  // THIS claim's session — see {@link buildHookTruncatedMarker}.
  const truncatedMarker = buildHookTruncatedMarker(claim.sessionId);

  // Reminder-only delivery (issue #198): a `normal`/`low` turn-boundary claim
  // has no event bodies to inject, only a lightweight advisory `message`. Body
  // injection stays reserved for `high` and the `post-compact` recap (both of
  // which populate `events`), so surface the message as a reminder line instead
  // of emitting nothing. A genuinely empty claim (no events, blank message) is
  // never produced by the runtime — `claimDelivery` returns `null` when nothing
  // is pending — but we still guard for it so the caller stays silent.
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
          truncatedMarker,
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
    const reserved = packWholeBlocks(
      HEADER,
      blocks,
      MAX_ADDITIONAL_CONTEXT - truncatedMarker.length,
    );
    if (reserved.includedCount >= 1) {
      additionalContext = reserved.text + truncatedMarker;
    } else {
      // Even the first block alone exceeds (cap − marker): mid-truncate block 0
      // at a code-point boundary. This is the ONLY case a durable event is shown
      // partially; its full body stays unread (claiming ≠ acking, 006 §5.5).
      const firstBlock = blocks[0] ?? '';
      additionalContext = appendMarkerWithinCap(
        HEADER + firstBlock,
        MAX_ADDITIONAL_CONTEXT,
        truncatedMarker,
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

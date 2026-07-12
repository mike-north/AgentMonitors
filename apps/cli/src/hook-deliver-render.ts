import type { DeliveryClaim } from '@agentmonitors/core';

const MAX_ADDITIONAL_CONTEXT = 4000;

/**
 * Appended verbatim when the assembled context is truncated. It tells the agent
 * the visible context is incomplete and points at the durable, re-discoverable
 * source of the rest. Claiming a delivery does NOT acknowledge it (BP2 / SP4):
 * `unreadEventsForSession` filters on `acknowledgedAt IS NULL` only, so an event
 * whose body was truncated away here remains UNREAD and is still listed by
 * `agentmonitors events list --unread` (and re-delivered by the next context
 * event). No event is lost by truncation.
 */
const TRUNCATION_MARKER =
  '\n\n[truncated — more monitor updates are pending; run `agentmonitors events list --unread` to see the rest]';

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
 * pair) and, when truncation occurs, appending {@link TRUNCATION_MARKER} so the
 * final string — marker included — is still ≤ `cap`.
 *
 * Iterating with `for…of` / `Array.from` walks code points, so an astral
 * character (emoji) at the boundary is dropped wholesale rather than leaving a
 * lone surrogate (which would corrupt the JSON the hook prints).
 */
function truncateForCap(value: string, cap: number): string {
  if (value.length <= cap) return value;

  // Budget for the body so that body + marker ≤ cap. The marker is plain ASCII,
  // so its UTF-16 length equals its code-point count.
  const budget = Math.max(0, cap - TRUNCATION_MARKER.length);

  let out = '';
  for (const ch of value) {
    // ch is a full code point (1 or 2 UTF-16 units); only append if it fits
    // wholly within the budget, so a surrogate pair is never split.
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + TRUNCATION_MARKER;
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
 *   plus a per-event block carrying the monitor body.
 * - **Reminder line** — a `normal`/`low` turn-boundary claim carries no event
 *   bodies (`events: []`) but a populated `message` (the same advisory line
 *   `hook claim` surfaces). It renders that message as a sanitized, length-capped
 *   reminder line, with **no** body injection — so a default (`normal`-urgency)
 *   monitor produces a visible mid-turn signal instead of silence. The
 *   underlying rows are claimed but NOT acknowledged (BP2 / SP4), so the event
 *   stays unread and re-discoverable via `agentmonitors events list --unread`.
 *
 * The renderer is **pure and side-effect-free**: no I/O, no mutation. Text is
 * preserved faithfully (a monitor body is trusted, user-authored markdown) with
 * only raw control characters removed (see {@link sanitize}); the total
 * `additionalContext` is capped so a large diff cannot blow the context window.
 * When the cap is exceeded the text is truncated at a code-point boundary and an
 * explicit {@link TRUNCATION_MARKER} is appended pointing at the still-unread,
 * re-discoverable events (claiming ≠ acking, so nothing is lost).
 *
 * @param claim - The delivery claim from `claimDeliveryClient`, or null.
 * @param hookEventName - The Claude Code event name to echo (e.g. `"PreToolUse"`).
 */
export function renderHookDelivery(
  claim: DeliveryClaim | null,
  hookEventName: string,
): HookDeliveryOutput | null {
  if (!claim) return null;

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
        additionalContext: truncateForCap(reminder, MAX_ADDITIONAL_CONTEXT),
      },
    };
  }

  const leadLine =
    'AgentMon: monitored changes are pending — consider handling them before continuing.';

  const blocks = claim.events.map((e) => {
    const id = sanitize(e.monitorId);
    const urgency = sanitize(e.urgency);
    const title = sanitize(e.title);
    const body = sanitize(e.body);
    return `### ${id} (${urgency})\n${title}\n\n${body}`;
  });

  const full = [leadLine, '', ...blocks].join('\n');
  const additionalContext = truncateForCap(full, MAX_ADDITIONAL_CONTEXT);

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
    '`.claude/agentmonitors.local.md` in this project with `enabled: true`.';
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}

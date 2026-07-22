/**
 * The single wording for the "in-flight delivery lease" exception to an
 * unqualified ack (issue #300): the no-`eventIds` ack path deliberately
 * excludes rows still leased by an in-flight delivery reservation, so every
 * surface that promises "acknowledge all unread" must say so identically.
 * This is the ONE place that sentence is written — {@link buildAckResultText},
 * {@link ACK_TOOL}'s `description` and its `event_ids` schema hint, and the
 * channel server's own MCP `instructions` string (`commands/channel.ts`) all
 * interpolate it rather than each spelling out its own copy, so the four
 * surfaces can never drift the way the schema hint's stale, unconditional
 * "all unread" wording once did (PR #445 review, round 13).
 */
export const LEASED_ROW_EXCEPTION =
  'except any rows still leased by an in-flight delivery push, which stay unread until that push resolves';

/** The `agentmon_ack` tool descriptor advertised to Claude Code over MCP. */
export const ACK_TOOL = {
  name: 'agentmon_ack',
  description:
    'Acknowledge AgentMon events surfaced in this session. Pass the event_id values from the ' +
    '<channel event_id="..."> tags; omit event_ids to acknowledge all unread events, ' +
    `${LEASED_ROW_EXCEPTION}.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      event_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Event IDs from the <channel event_id="..."> tags. Omit to acknowledge all unread, ' +
          `${LEASED_ROW_EXCEPTION}.`,
      },
    },
  },
};

export interface AckArgs {
  /**
   * Event IDs to acknowledge; omitted means "all unread for this session"
   * except any rows currently leased by an in-flight delivery reservation,
   * which are left unread until each reservation resolves (issue #300).
   */
  eventIds?: string[];
}

export type AckParseResult =
  | { ok: true; args: AckArgs }
  | { ok: false; error: string };

/**
 * Build the `agentmon_ack` tool result text for a successful acknowledge call.
 *
 * Extracted as its own function (rather than inlined at the call site) so the
 * shipped result text, `ACK_TOOL`'s advertised description/schema, and the
 * public 005/006 wording contracts all trace to one place — the no-`eventIds`
 * path deliberately excludes rows still leased by an in-flight delivery
 * reservation (issue #300, `acknowledgeSession`'s TSDoc in
 * `libs/core/src/runtime/service.ts`), so the result text must say so rather
 * than claiming it acknowledged "all unread" unconditionally.
 */
export function buildAckResultText(eventIds?: string[]): string {
  return eventIds
    ? `Requested acknowledgement of ${String(eventIds.length)} event(s); ids not projected to this session are ignored.`
    : `Acknowledged all unread events for this session, ${LEASED_ROW_EXCEPTION}.`;
}

/**
 * Validate the arguments passed to an `agentmon_ack` tool call. Arguments arrive
 * as untrusted `unknown` from the MCP boundary, so the shape is checked
 * defensively before any IPC call.
 */
export function parseAckArgs(raw: unknown): AckParseResult {
  if (raw === undefined || raw === null) {
    return { ok: true, args: {} };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'arguments must be an object' };
  }

  const eventIds = (raw as Record<string, unknown>)['event_ids'];
  if (eventIds === undefined) {
    return { ok: true, args: {} };
  }
  if (!Array.isArray(eventIds)) {
    return { ok: false, error: 'event_ids must be an array of strings' };
  }
  const ids = eventIds.filter(
    (value): value is string => typeof value === 'string',
  );
  if (ids.length !== eventIds.length) {
    return { ok: false, error: 'event_ids must be an array of strings' };
  }
  return { ok: true, args: { eventIds: ids } };
}

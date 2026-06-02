/** The `agentmon_ack` tool descriptor advertised to Claude Code over MCP. */
export const ACK_TOOL = {
  name: 'agentmon_ack',
  description:
    'Acknowledge AgentMon events surfaced in this session. Pass the event_id values from the ' +
    '<channel event_id="..."> tags; omit event_ids to acknowledge all unread events.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      event_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Event IDs from the <channel event_id="..."> tags. Omit to acknowledge all unread.',
      },
    },
  },
};

export interface AckArgs {
  /** Event IDs to acknowledge; omitted means "all unread for this session". */
  eventIds?: string[];
}

export type AckParseResult =
  | { ok: true; args: AckArgs }
  | { ok: false; error: string };

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

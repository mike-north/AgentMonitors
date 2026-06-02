import { describe, expect, it } from 'vitest';
import { ACK_TOOL, parseAckArgs } from './channel-ack.js';

describe('ACK_TOOL', () => {
  it('declares a valid agentmon_ack tool descriptor', () => {
    expect(ACK_TOOL.name).toBe('agentmon_ack');
    expect(ACK_TOOL.inputSchema.type).toBe('object');
    expect(ACK_TOOL.inputSchema.properties).toHaveProperty('event_ids');
  });
});

describe('parseAckArgs', () => {
  it('treats omitted arguments as "ack all unread"', () => {
    expect(parseAckArgs(undefined)).toEqual({ ok: true, args: {} });
    expect(parseAckArgs(null)).toEqual({ ok: true, args: {} });
    expect(parseAckArgs({})).toEqual({ ok: true, args: {} });
    expect(parseAckArgs({ event_ids: undefined })).toEqual({
      ok: true,
      args: {},
    });
  });

  it('accepts an array of string event ids', () => {
    expect(parseAckArgs({ event_ids: ['a', 'b'] })).toEqual({
      ok: true,
      args: { eventIds: ['a', 'b'] },
    });
  });

  it('rejects a non-object argument', () => {
    expect(parseAckArgs(['a']).ok).toBe(false);
    expect(parseAckArgs('a').ok).toBe(false);
  });

  it('rejects event_ids that is not an array of strings', () => {
    expect(parseAckArgs({ event_ids: 'a' }).ok).toBe(false);
    expect(parseAckArgs({ event_ids: [1, 2] }).ok).toBe(false);
    expect(parseAckArgs({ event_ids: ['a', 2] }).ok).toBe(false);
  });
});

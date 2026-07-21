import { describe, expect, it } from 'vitest';
import { ACK_TOOL, buildAckResultText, parseAckArgs } from './channel-ack.js';

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

describe('buildAckResultText', () => {
  // Regression for PR #445 review round 13 (discussion_r3624690058): the
  // no-eventIds ack path deliberately excludes rows still leased by an
  // in-flight delivery reservation (issue #300), so the shipped result text
  // must say so rather than the earlier "Acknowledged all unread events for
  // this session." wording, which was unconditionally false while a
  // reservation was in flight.
  it('names the leased-row exception when no event ids are given', () => {
    expect(buildAckResultText(undefined)).toBe(
      'Acknowledged all unread events for this session, except any rows still leased by an in-flight delivery push.',
    );
  });

  it('frames explicit event ids as a request, not a blanket acknowledgement', () => {
    expect(buildAckResultText(['a', 'b'])).toBe(
      'Requested acknowledgement of 2 event(s); ids not projected to this session are ignored.',
    );
  });

  it('reports a singular count for a single explicit event id', () => {
    expect(buildAckResultText(['only-one'])).toBe(
      'Requested acknowledgement of 1 event(s); ids not projected to this session are ignored.',
    );
  });

  it('reports zero for an empty explicit event id array', () => {
    // Edge case: an empty array is truthy-distinct from `undefined` — it must
    // still take the "requested" branch, not silently fall back to the
    // all-unread wording.
    expect(buildAckResultText([])).toBe(
      'Requested acknowledgement of 0 event(s); ids not projected to this session are ignored.',
    );
  });
});

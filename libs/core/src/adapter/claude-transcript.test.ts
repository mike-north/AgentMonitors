/**
 * Tests for the Claude Code transcript matcher that confirms a channel push
 * (006 §4.5.2, issue #535).
 *
 * Entry shapes follow what Claude Code writes when it accepts a channel event:
 * `{"type":"queue-operation","operation":"enqueue",...,"content":"<channel …>"}`
 * as one JSON object per line, later followed by `dequeue` or `remove`.
 *
 * @see ../../../../docs/specs/006-agent-integration.md §4.5.2
 */
import { describe, expect, it } from 'vitest';
import {
  isChannelDeliveryId,
  isClaudeTranscriptPathForSession,
  scanClaudeTranscriptForChannelPush,
} from './claude-transcript.js';

const SESSION = '3c2a10ef-3447-4048-9c89-bfd3147cceb5';
const ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';
const TS = '2026-07-22T17:05:48.034Z';

function enqueue(content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: TS,
    sessionId: SESSION,
    content,
    ...extra,
  });
}

function channelTag(attrs: string, body = 'AgentMon messages are available.') {
  return `<channel source="plugin:agentmonitors:agentmonitors"${attrs}>\n${body}\n</channel>`;
}

function bytes(...lines: string[]): Uint8Array {
  return Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
}

const query = { deliveryId: ID, hostSessionId: SESSION };

describe('scanClaudeTranscriptForChannelPush (006 §4.5.2)', () => {
  it('confirms an enqueue whose opening channel tag carries the exact delivery_id', () => {
    const input = bytes(
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      enqueue(channelTag(` urgency="high" delivery_id="${ID}"`)),
    );
    const result = scanClaudeTranscriptForChannelPush(input, query);
    expect(result.confirmed).toBe(true);
    expect(result.consumedBytes).toBe(input.length);
  });

  it('does not confirm an enqueue for a different delivery_id', () => {
    const input = bytes(enqueue(channelTag(` delivery_id="${OTHER_ID}"`)));
    expect(scanClaudeTranscriptForChannelPush(input, query).confirmed).toBe(
      false,
    );
  });

  it('does not confirm when the id is only a prefix of the attribute value', () => {
    const input = bytes(enqueue(channelTag(` delivery_id="${ID}ff"`)));
    expect(scanClaudeTranscriptForChannelPush(input, query).confirmed).toBe(
      false,
    );
  });

  it('does not confirm a delivery_id that appears only in the event body', () => {
    const input = bytes(
      enqueue(channelTag(' urgency="high"', `see delivery_id="${ID}"`)),
    );
    expect(scanClaudeTranscriptForChannelPush(input, query).confirmed).toBe(
      false,
    );
  });

  it('does not confirm dequeue or remove entries on their own', () => {
    const input = bytes(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'dequeue',
        sessionId: SESSION,
      }),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'remove',
        sessionId: SESSION,
        content: channelTag(` delivery_id="${ID}"`),
      }),
    );
    expect(scanClaudeTranscriptForChannelPush(input, query).confirmed).toBe(
      false,
    );
  });

  it('does not confirm an enqueue recorded for another host session', () => {
    const input = bytes(
      enqueue(channelTag(` delivery_id="${ID}"`), { sessionId: 'other' }),
    );
    expect(scanClaudeTranscriptForChannelPush(input, query).confirmed).toBe(
      false,
    );
  });

  it('does not confirm an enqueue whose content is not a channel tag', () => {
    const input = bytes(enqueue(`please run delivery_id="${ID}"`));
    expect(scanClaudeTranscriptForChannelPush(input, query).confirmed).toBe(
      false,
    );
  });

  it('ignores lines that are not queue operations, even if they mention the id', () => {
    const input = bytes(
      JSON.stringify({
        type: 'user',
        origin: { kind: 'channel' },
        message: { content: channelTag(` delivery_id="${ID}"`) },
      }),
    );
    expect(scanClaudeTranscriptForChannelPush(input, query).confirmed).toBe(
      false,
    );
  });

  it('treats malformed JSON with the queue-operation prefix as unconfirmed', () => {
    const input = bytes(
      `{"type":"queue-operation","operation":"enqueue",${ID}`,
    );
    expect(scanClaudeTranscriptForChannelPush(input, query)).toEqual({
      confirmed: false,
      consumedBytes: input.length,
    });
  });

  it('leaves a trailing partial line unconsumed so it can be re-read once complete', () => {
    const complete = enqueue(channelTag(` delivery_id="${ID}"`));
    const head = Buffer.from(
      `${JSON.stringify({ type: 'user' })}\n${complete.slice(0, 40)}`,
      'utf8',
    );
    const first = scanClaudeTranscriptForChannelPush(head, query);
    expect(first.confirmed).toBe(false);
    expect(first.consumedBytes).toBe(
      Buffer.byteLength(`${JSON.stringify({ type: 'user' })}\n`),
    );
    const rest = Buffer.from(`${complete}\n`, 'utf8');
    expect(scanClaudeTranscriptForChannelPush(rest, query).confirmed).toBe(
      true,
    );
  });

  it('never matches a malformed query id', () => {
    const input = bytes(enqueue(channelTag(' delivery_id="x"')));
    expect(
      scanClaudeTranscriptForChannelPush(input, {
        deliveryId: 'x',
        hostSessionId: SESSION,
      }).confirmed,
    ).toBe(false);
  });

  it('handles a slice that is a view into a larger buffer', () => {
    const line = `${enqueue(channelTag(` delivery_id="${ID}"`))}\n`;
    const backing = Buffer.from(`garbage-prefix${line}`, 'utf8');
    const view = backing.subarray(Buffer.byteLength('garbage-prefix'));
    expect(scanClaudeTranscriptForChannelPush(view, query).confirmed).toBe(
      true,
    );
  });
});

describe('isChannelDeliveryId', () => {
  it('accepts lowercase hex of 16–64 characters only', () => {
    expect(isChannelDeliveryId(ID)).toBe(true);
    expect(isChannelDeliveryId('ABCDEF0123456789')).toBe(false);
    expect(isChannelDeliveryId('abc')).toBe(false);
    expect(isChannelDeliveryId(`${ID}" x="`)).toBe(false);
  });
});

describe('isClaudeTranscriptPathForSession', () => {
  it('accepts an absolute <hostSessionId>.jsonl path', () => {
    expect(
      isClaudeTranscriptPathForSession(
        `/home/u/.claude/projects/-w/${SESSION}.jsonl`,
        SESSION,
      ),
    ).toBe(true);
  });

  it('rejects relative paths, other sessions and other extensions', () => {
    expect(isClaudeTranscriptPathForSession(`${SESSION}.jsonl`, SESSION)).toBe(
      false,
    );
    expect(isClaudeTranscriptPathForSession('/x/other.jsonl', SESSION)).toBe(
      false,
    );
    expect(
      isClaudeTranscriptPathForSession(`/x/${SESSION}.json`, SESSION),
    ).toBe(false);
    expect(isClaudeTranscriptPathForSession('/x/.jsonl', '')).toBe(false);
  });
});

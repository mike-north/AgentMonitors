/**
 * Tests for the transport-shared event-block renderer and packing helpers
 * (`buildEventBlock`, `truncateWithMarker`, `packWholeBlocks`,
 * `packEventsUnderCap`) — the primitives both the hook-deliver transport
 * (`hook-deliver-render.ts`, 006 §5.1) and the channel transport
 * (`channel-render.ts`, 006 §4.2) build on. Before {@link truncateWithMarker}
 * and the generic packing helpers were extracted here, `hook-deliver-render.ts`
 * and `delivery-event-render.ts` each carried a character-identical copy of
 * the same code-point-safe truncation loop (issue #442, review finding #5b).
 *
 * @see docs/specs/006-agent-integration.md §4.2.1, §5.1, §5.5
 */
import { describe, expect, it } from 'vitest';
import type { DeliveryEventSummary } from '@agentmonitors/core';
import {
  buildEventBlock,
  DIFF_ELISION_MARKER,
  MAX_EVENT_DIFF,
  packEventsUnderCap,
  packWholeBlocks,
  shellQuoteSingle,
  truncateWithMarker,
} from './delivery-event-render.js';

const identity = (value: string): string => value;

function makeEvent(
  overrides: Partial<DeliveryEventSummary> = {},
): DeliveryEventSummary {
  return {
    eventId: 'e1',
    monitorId: 'm1',
    title: 't1',
    summary: 's1',
    urgency: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    body: 'a body',
    ...overrides,
  };
}

describe('shellQuoteSingle', () => {
  it('wraps a plain path in single quotes', () => {
    expect(shellQuoteSingle('/tmp/agentmon.sock')).toBe("'/tmp/agentmon.sock'");
  });

  it('escapes an embedded single quote so the quoted command stays valid shell syntax', () => {
    expect(shellQuoteSingle("/tmp/weird ' path.sock")).toBe(
      String.raw`'/tmp/weird '\'' path.sock'`,
    );
  });

  it('quotes a path containing spaces (a common workspace-directory case)', () => {
    const quoted = shellQuoteSingle('/Users/me/My Project/.sock');
    // Round-trips as a single shell word: no unescaped, unquoted space.
    expect(quoted).toBe("'/Users/me/My Project/.sock'");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});

describe('truncateWithMarker', () => {
  it('returns the value unchanged when it already fits under the cap', () => {
    expect(truncateWithMarker('short', 100, '[MARK]')).toBe('short');
  });

  it('cuts at the budget and appends the marker when over the cap', () => {
    const result = truncateWithMarker('abcdefghij', 8, '..');
    expect(result.length).toBe(8);
    expect(result.endsWith('..')).toBe(true);
    expect(result).toBe('abcdef..');
  });

  it('never splits a surrogate pair at the truncation boundary', () => {
    const emoji = '😀'; // 2 UTF-16 code units, 1 code point
    const value = `abc${emoji}`; // length 5 in UTF-16 units
    // Cap lands exactly between the emoji's two surrogate halves.
    const result = truncateWithMarker(value, 4, '');
    // Either the whole emoji is included or wholly excluded — never a lone
    // surrogate.
    expect(result === 'abc' || result === `abc${emoji}`).toBe(true);
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      if (isHighSurrogate) {
        const next = result.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
    }
  });

  it('handles a cap smaller than the marker itself without throwing', () => {
    const result = truncateWithMarker('abcdefgh', 2, '[MARKER]');
    expect(result).toBe('[MARKER]');
  });
});

describe('buildEventBlock', () => {
  it('renders the header, title, and body with no Changes section when diffText is absent', () => {
    const block = buildEventBlock(makeEvent(), identity);
    expect(block).toBe('### m1 (high)\nt1\n\na body');
    expect(block).not.toContain('Changes:');
  });

  it('appends a bounded Changes section when diffText is present', () => {
    const block = buildEventBlock(
      makeEvent({ diffText: '+ line added' }),
      identity,
    );
    expect(block).toContain('Changes:\n+ line added');
  });

  it('omits the Changes section for a blank/whitespace-only diffText', () => {
    const block = buildEventBlock(makeEvent({ diffText: '   ' }), identity);
    expect(block).not.toContain('Changes:');
  });

  it('bounds a large diffText at MAX_EVENT_DIFF with the elision marker', () => {
    const bigDiff = '+ line\n'.repeat(500);
    const block = buildEventBlock(makeEvent({ diffText: bigDiff }), identity);
    const changesIdx = block.indexOf('Changes:\n');
    const rendered = block.slice(changesIdx + 'Changes:\n'.length);
    expect(rendered.length).toBeLessThanOrEqual(MAX_EVENT_DIFF);
    expect(rendered).toContain(DIFF_ELISION_MARKER.trim());
  });

  it('passes every field through sanitize', () => {
    const sanitize = (value: string): string => value.toUpperCase();
    const block = buildEventBlock(makeEvent(), sanitize);
    expect(block).toBe('### M1 (HIGH)\nT1\n\nA BODY');
  });
});

describe('packWholeBlocks', () => {
  it('includes every block when the whole set fits', () => {
    const result = packWholeBlocks(['aa', 'bb', 'cc'], 100);
    expect(result.includedCount).toBe(3);
    expect(result.text).toBe('aa\nbb\ncc');
  });

  it('stops before a block that would exceed the cap (never a partial block)', () => {
    const result = packWholeBlocks(['aaaa', 'bbbb', 'cccc'], 9);
    // "aaaa" (4) + "\n" (1) + "bbbb" (4) = 9, fits; + "\n" + "cccc" = 14 > 9.
    expect(result.includedCount).toBe(2);
    expect(result.text).toBe('aaaa\nbbbb');
  });

  it('applies a fixed header before any blocks', () => {
    const result = packWholeBlocks(['aa'], 100, { header: 'HEAD\n\n' });
    expect(result.text).toBe('HEAD\n\naa');
    expect(result.includedCount).toBe(1);
  });

  it('respects a custom joiner between blocks', () => {
    const result = packWholeBlocks(['aa', 'bb'], 100, { joiner: '\n\n' });
    expect(result.text).toBe('aa\n\nbb');
  });

  it('returns 0 included and empty text for an empty block list', () => {
    const result = packWholeBlocks([], 100);
    expect(result).toEqual({ text: '', includedCount: 0 });
  });

  it('excludes even the first block when the header alone already exceeds the cap', () => {
    const result = packWholeBlocks(['aa'], 3, { header: 'HEADER\n' });
    expect(result.includedCount).toBe(0);
  });
});

describe('packEventsUnderCap', () => {
  it('returns 0 for an empty event list', () => {
    expect(packEventsUnderCap([], identity, 1000)).toBe(0);
  });

  it('returns the full count when every whole block fits under the cap', () => {
    const events = [makeEvent({ eventId: 'e1' }), makeEvent({ eventId: 'e2' })];
    expect(packEventsUnderCap(events, identity, 1000)).toBe(2);
  });

  it('returns fewer than the full count when the combined length exceeds the cap, reserving marker room', () => {
    const bigBody = 'x'.repeat(500);
    const events = [
      makeEvent({ eventId: 'e1', body: bigBody }),
      makeEvent({ eventId: 'e2', body: bigBody }),
      makeEvent({ eventId: 'e3', body: bigBody }),
    ];
    const fit = packEventsUnderCap(events, identity, 700, {
      markerLength: 20,
    });
    expect(fit).toBeGreaterThanOrEqual(1);
    expect(fit).toBeLessThan(events.length);
  });

  it('returns at least 1 even when the first event alone exceeds the cap (forward progress)', () => {
    const events = [makeEvent({ eventId: 'e1', body: 'x'.repeat(10_000) })];
    expect(
      packEventsUnderCap(events, identity, 100, { markerLength: 10 }),
    ).toBe(1);
  });
});

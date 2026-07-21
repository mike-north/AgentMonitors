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
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { DeliveryEventSummary } from '@agentmonitors/core';
import {
  buildEventBlock,
  DIFF_ELISION_MARKER,
  escapeShellPath,
  MAX_EVENT_DIFF,
  packEventsUnderCap,
  packWholeBlocks,
  truncateWithMarker,
} from './delivery-event-render.js';

/** 006 §4.6: every tag-breakout / attribute-breakout character. */
const FORBIDDEN_CHARS = /[<>[\]\r\n;]/;

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

// ---------------------------------------------------------------------------
// PR #442 round-8 review: a socket path is interpolated into a truncation
// marker AFTER the surrounding content has already been tag/attribute-safety
// sanitized (`contentValue`/`metaValue` in channel-render.ts) — so an explicit
// path carrying `< > [ ] ; \r \n` or a backtick would otherwise reintroduce
// those forbidden bytes into the pushed content raw. `escapeShellPath` must be
// BOTH transport-safe (no forbidden byte survives) AND shell-round-trip-safe
// (bash/zsh reconstruct the exact original path).
// ---------------------------------------------------------------------------
describe('escapeShellPath', () => {
  it('wraps a plain, all-safe path in single quotes (no escaping needed)', () => {
    expect(escapeShellPath('/tmp/agentmon.sock')).toBe("'/tmp/agentmon.sock'");
  });

  it('ANSI-C-escapes an embedded single quote instead of the close/escape/reopen trick', () => {
    const escaped = escapeShellPath("/tmp/weird ' path.sock");
    expect(escaped).toBe(String.raw`$'/tmp/weird\x20\x27\x20path.sock'`);
    // No raw quote or space survives unescaped in the tag body.
    expect(escaped).not.toMatch(FORBIDDEN_CHARS);
  });

  it('ANSI-C-escapes a path containing spaces (a common workspace-directory case)', () => {
    const escaped = escapeShellPath('/Users/me/My Project/.sock');
    expect(escaped).toBe(String.raw`$'/Users/me/My\x20Project/.sock'`);
  });

  it('ANSI-C-escapes tag-breakout characters so none survive raw', () => {
    const escaped = escapeShellPath('/tmp/x<channel>[oops].sock');
    expect(escaped).toBe(String.raw`$'/tmp/x\x3cchannel\x3e\x5boops\x5d.sock'`);
    expect(escaped).not.toMatch(FORBIDDEN_CHARS);
  });

  it('ANSI-C-escapes control characters (CR) and a backtick', () => {
    const escaped = escapeShellPath('/tmp/weird`\r.sock');
    expect(escaped).not.toContain('`');
    expect(escaped).not.toMatch(FORBIDDEN_CHARS);
    expect(escaped).toContain(String.raw`\x60`);
    expect(escaped).toContain(String.raw`\x0d`);
  });

  it('round-trips a multi-byte code point via UTF-8 byte escapes', () => {
    const escaped = escapeShellPath('/tmp/wörk.sock');
    // ö is U+00F6, UTF-8 encoded as 0xC3 0xB6.
    expect(escaped).toBe(String.raw`$'/tmp/w\xc3\xb6rk.sock'`);
  });

  it('reconstructs the exact original path when evaluated by a real shell', () => {
    const adversarialPaths = [
      '/tmp/agentmon.sock',
      "/tmp/weird ' path.sock",
      '/tmp/x<channel>[oops].sock',
      '/Users/me/My Project/.sock',
      '/tmp/wörk.sock',
    ];
    for (const path of adversarialPaths) {
      const escaped = escapeShellPath(path);
      const result = spawnSync('bash', ['-c', `printf '%s' ${escaped}`], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(path);
    }
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
  it('renders the header, title, summary, and body with no Changes section when diffText is absent', () => {
    const block = buildEventBlock(makeEvent(), identity);
    // The summary line carries the source's per-object text, which the title no
    // longer does (002 §5.4, issue #449) — so it is rendered under the title.
    expect(block).toBe('### m1 (high)\nt1\ns1\n\na body');
    expect(block).not.toContain('Changes:');
  });

  it('omits the summary line when it merely repeats the body (source set only title + body)', () => {
    // Materialization derives an absent `Observation.summary` from `body`
    // (002 §5.1), so this is a valid third-party observation shape — the body
    // must not be rendered twice (issue #449 review).
    const block = buildEventBlock(
      makeEvent({
        title: 'Alert',
        summary: 'Do the work',
        body: 'Do the work',
      }),
      identity,
    );
    expect(block).toBe('### m1 (high)\nAlert\n\nDo the work');
    expect(block.split('Do the work').length - 1).toBe(1);
  });

  it('omits the summary line when it is identical to the title (a nameless monitor)', () => {
    // A monitor with no authored `name` falls back to the source title, so title
    // and summary are the same string; rendering it twice would be noise.
    const block = buildEventBlock(makeEvent({ summary: 't1' }), identity);
    expect(block).toBe('### m1 (high)\nt1\n\na body');
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
    expect(block).toBe('### M1 (HIGH)\nT1\nS1\n\nA BODY');
  });

  // Regression (issue #449 review): `summary` prefers the Interpret digest
  // (G14, 002 §1.1.8) when one was produced for the recipient's delta, and a
  // digest is a prose reading of the change that carries no guaranteed object
  // identity. `objectDetail` is the deterministic per-object text and must be
  // what names the object here, even when `summary` has been replaced by a
  // digest that shares no text with either.
  it('names the object from objectDetail AND surfaces a distinct digest, dropping neither (issue #449 review)', () => {
    const block = buildEventBlock(
      makeEvent({
        summary: 'The status page reported a brief outage.', // Interpret digest
        objectDetail: 'Incoming change: docs/specs/001.md (modified)',
      }),
      identity,
    );
    // Object identity (deterministic, never digest-replaced) renders first...
    expect(block).toBe(
      '### m1 (high)\nt1\nIncoming change: docs/specs/001.md (modified)\nThe status page reported a brief outage.\n\na body',
    );
    // ...and the digest is NOT dropped: a named multi-object prose delivery
    // must not silently discard a successful Interpret summarization.
    expect(block).toContain('brief outage');
  });

  it('falls back to summary when objectDetail is absent (a hand-constructed DeliveryEventSummary)', () => {
    const block = buildEventBlock(
      makeEvent({ summary: 'legacy summary text' }),
      identity,
    );
    expect(block).toContain('legacy summary text');
  });

  it('objectDetail participates in the same title/body dedup as summary did, and a distinct digest still renders on its own additional line', () => {
    // objectDetail identical to title -> omitted, but the distinct digest is
    // still surfaced (it says something objectDetail/title do not).
    expect(
      buildEventBlock(
        makeEvent({ objectDetail: 't1', summary: 'digest text' }),
        identity,
      ),
    ).toBe('### m1 (high)\nt1\ndigest text\n\na body');
    // Identical to body -> objectDetail omitted (source supplied only title +
    // body), digest still rendered since it differs from both.
    expect(
      buildEventBlock(
        makeEvent({
          title: 'Alert',
          objectDetail: 'Do the work',
          summary: 'digest text',
          body: 'Do the work',
        }),
        identity,
      ),
    ).toBe('### m1 (high)\nAlert\ndigest text\n\nDo the work');
  });

  it('does not duplicate the line when the digest equals objectDetail (no digest was produced, both fall back to the same deterministic chain)', () => {
    expect(
      buildEventBlock(
        makeEvent({
          objectDetail: 'Incoming change: docs/specs/001.md (modified)',
          summary: 'Incoming change: docs/specs/001.md (modified)',
        }),
        identity,
      ),
    ).toBe(
      '### m1 (high)\nt1\nIncoming change: docs/specs/001.md (modified)\n\na body',
    );
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

/**
 * Tests for the TOON output format helper and CLI --format toon integration.
 *
 * @see https://toonformat.dev/
 * @see https://github.com/toon-format/toon
 */
import { describe, it, expect } from 'vitest';
import { renderToon, decodeToon } from './toon-format.js';

describe('renderToon', () => {
  it('round-trips a plain object back to the identical JSON value', () => {
    const value = { name: 'alice', age: 30, active: true };
    const toon = renderToon(value);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(value);
  });

  it('round-trips an array of objects (tabular form)', () => {
    const value = [
      { id: 1, label: 'alpha', score: 0.5 },
      { id: 2, label: 'beta', score: 1.0 },
    ];
    const toon = renderToon(value);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(value);
  });

  it('round-trips an empty array', () => {
    const toon = renderToon([]);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual([]);
  });

  it('round-trips a nested object', () => {
    const value = {
      monitor: { id: 'watch-files', urgency: 'normal' },
      stages: [
        { id: 'definition', status: 'ok', reason: 'Monitor found' },
        { id: 'scheduling', status: 'ok', reason: 'Due' },
      ],
    };
    const toon = renderToon(value);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(value);
  });

  it('round-trips null values in objects', () => {
    const value = { notify: null, tags: [] as string[] };
    const toon = renderToon(value);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(value);
  });

  it('round-trips boolean values', () => {
    const value = { running: false, sessions: 0 };
    const toon = renderToon(value);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(value);
  });

  it('produces a string (not an object or array)', () => {
    const result = renderToon({ key: 'value' });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('produces output that is visibly different from JSON (no outer braces on objects)', () => {
    const value = { name: 'alice', age: 30 };
    const toon = renderToon(value);
    const json = JSON.stringify(value, null, 2);
    // TOON does not wrap the root object in braces
    expect(toon).not.toContain('{');
    expect(toon).not.toContain('}');
    // JSON has braces
    expect(json).toContain('{');
  });

  it('strips undefined values (matching JSON.stringify semantics)', () => {
    // JSON.stringify omits undefined properties; renderToon must behave the same
    // since it normalises through JSON.parse/stringify before encoding.
    const value = { keep: 'yes', drop: undefined } as {
      keep: string;
      drop?: string;
    };
    const toon = renderToon(value);
    const decoded = decodeToon(toon) as Record<string, unknown>;
    expect(decoded['keep']).toBe('yes');
    expect('drop' in decoded).toBe(false);
  });

  // Round-trip tests for the exact JSON shapes emitted by each structured-output
  // command. These are spec-derived from the JSON output contract in 005 §4–§7.

  it('round-trips the scan output shape', () => {
    const scanOutput = {
      monitors: [
        {
          id: 'my-monitor',
          name: 'My Monitor',
          source: 'file-fingerprint',
          urgency: 'normal',
          tags: ['ci'],
          notify: null,
        },
      ],
      errors: [] as { filePath: string; error: string }[],
      duplicateIds: [] as string[],
    };
    const toon = renderToon(scanOutput);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(scanOutput);
  });

  it('round-trips the source list output shape', () => {
    const sourceListOutput = [
      {
        name: 'file-fingerprint',
        configFields: ['globs', 'cwd'],
        scopeFields: ['globs', 'cwd'],
        required: ['globs'],
      },
    ];
    const toon = renderToon(sourceListOutput);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(sourceListOutput);
  });

  it('round-trips the events list output shape', () => {
    const eventsOutput = [
      {
        id: 'evt-123',
        monitorId: 'watch-files',
        urgency: 'normal',
        title: 'File changed',
        createdAt: '2024-01-15T10:00:00.000Z',
        state: 'unread',
      },
    ];
    const toon = renderToon(eventsOutput);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(eventsOutput);
  });

  it('round-trips the monitor history output shape', () => {
    const historyOutput = [
      {
        id: 1,
        monitorId: 'watch-files',
        sourceName: 'file-fingerprint',
        result: 'triggered',
        createdAt: '2024-01-15T10:00:00.000Z',
      },
    ];
    const toon = renderToon(historyOutput);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(historyOutput);
  });

  it('round-trips the monitor explain report shape', () => {
    const explainOutput = {
      monitorId: 'watch-files',
      generatedAt: '2024-01-15T10:00:00.000Z',
      monitor: {
        id: 'watch-files',
        displayName: 'Watch Files',
        filePath: '/home/user/.claude/monitors/watch-files/MONITOR.md',
        sourceName: 'file-fingerprint',
        urgency: 'normal',
      },
      stages: [
        {
          id: 'definition',
          label: 'Definition',
          status: 'ok',
          reason: 'Monitor found',
          details: {},
        },
      ],
      verdict: {
        status: 'ok',
        stage: 'definition',
        reason: 'Monitor found',
      },
      observations: [] as unknown[],
      events: [] as unknown[],
      projections: [] as unknown[],
      leadSessions: [] as unknown[],
    };
    const toon = renderToon(explainOutput);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(explainOutput);
  });
});

describe('decodeToon', () => {
  it('is the inverse of renderToon for round-trip verification', () => {
    const original = { monitors: [{ id: 'a', name: 'A' }], errors: [] };
    const toon = renderToon(original);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(original);
  });
});

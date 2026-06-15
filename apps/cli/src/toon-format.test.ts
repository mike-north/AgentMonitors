/**
 * Tests for the TOON output format helper and CLI --format toon integration.
 *
 * @see https://toonformat.dev/
 * @see https://github.com/toon-format/toon
 * @see https://github.com/mike-north/is-agentic-tui
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToon, decodeToon, resolveFormat } from './toon-format.js';

// Mock is-agentic-tui so resolveFormat unit tests are hermetic regardless of
// which agentic env vars happen to be set in the test-runner environment
// (e.g. CLAUDE_CODE_ENTRYPOINT when running inside Claude Code).
vi.mock('is-agentic-tui', () => ({
  isAgenticTui: vi.fn(() => false),
  clearCache: vi.fn(),
}));

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
    // duplicateIds is DuplicateMonitorId[] — objects with { id, filePaths },
    // NOT string[]. The CLI passes result.duplicateIds through directly.
    // @see apps/cli/src/commands/scan.ts (line: duplicateIds: result.duplicateIds)
    // @see libs/core/src/runtime/types.ts DuplicateMonitorId
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
      duplicateIds: [
        {
          id: 'duplicate-monitor',
          filePaths: ['/monitors/a/MONITOR.md', '/monitors/b/MONITOR.md'],
        },
      ] as { id: string; filePaths: string[] }[],
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
    // Full MonitorEventRecord JSON shape as emitted by `events list --format json`.
    // The command does JSON.stringify(events) directly; Date fields become ISO strings.
    // @see libs/core/src/runtime/types.ts MonitorEventRecord
    // @see apps/cli/src/commands/events.ts (JSON.stringify(events, null, 2))
    const eventsOutput = [
      {
        id: 'evt-123',
        workspacePath: '/home/user/project',
        monitorId: 'watch-files',
        sourceName: 'file-fingerprint',
        urgency: 'normal',
        title: 'File changed',
        body: 'The file watched.txt was modified.',
        summary: 'watched.txt modified',
        payload: { kind: 'modified', path: 'watched.txt' },
        snapshotMetadata: null,
        snapshotText: null,
        diffText: null,
        objectKey: null,
        queryScope: {},
        tags: ['ci'],
        createdAt: '2024-01-15T10:00:00.000Z',
      },
    ];
    const toon = renderToon(eventsOutput);
    const decoded = decodeToon(toon);
    expect(decoded).toEqual(eventsOutput);
  });

  it('round-trips the monitor history output shape', () => {
    // Full ObservationHistoryRecord JSON shape as emitted by `monitor history --format json`.
    // id is a string (not number), observationData is Record<string, unknown>.
    // @see libs/core/src/runtime/types.ts ObservationHistoryRecord
    const historyOutput = [
      {
        id: 'obs-abc-123',
        monitorId: 'watch-files',
        sourceName: 'file-fingerprint',
        observationData: { observed: 1, emitted: 1 },
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

describe('resolveFormat', () => {
  // Obtain a typed reference to the mock so we can control its return value per
  // test. The module-level `vi.mock('is-agentic-tui', ...)` above replaces the
  // real library with a controlled stub, making these tests hermetic regardless
  // of which agentic env vars are set in the process running the test suite
  // (e.g. CLAUDE_CODE_ENTRYPOINT when tests run inside Claude Code).
  let mockIsAgenticTui: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('is-agentic-tui');
    mockIsAgenticTui = mod.isAgenticTui as ReturnType<typeof vi.fn>;
    // Default to non-agentic; individual tests override as needed.
    mockIsAgenticTui.mockReturnValue(false);
  });

  // (a) Agent detected + no --format → toon
  it('returns toon when isAgenticTui() returns true and no explicit format', () => {
    mockIsAgenticTui.mockReturnValue(true);
    expect(resolveFormat(undefined)).toBe('toon');
  });

  // (b) Human (interactive) + no --format → text
  it('returns text when isAgenticTui() returns false and no explicit format', () => {
    mockIsAgenticTui.mockReturnValue(false);
    expect(resolveFormat(undefined)).toBe('text');
  });

  // (c) Explicit --format always overrides auto-detection
  it('returns toon when --format toon is explicit, regardless of detection', () => {
    mockIsAgenticTui.mockReturnValue(false);
    expect(resolveFormat('toon')).toBe('toon');
  });

  it('returns json when --format json is explicit, even when agent is detected', () => {
    mockIsAgenticTui.mockReturnValue(true);
    expect(resolveFormat('json')).toBe('json');
  });

  it('returns text when --format text is explicit, even when agent is detected', () => {
    mockIsAgenticTui.mockReturnValue(true);
    expect(resolveFormat('text')).toBe('text');
  });

  // Negative: unknown/garbage values fall back to auto-detection
  it('falls back to auto-detect for unrecognised explicit values (returns text when non-agentic)', () => {
    mockIsAgenticTui.mockReturnValue(false);
    // 'auto' is not a valid value — falls through to detection.
    expect(resolveFormat('auto')).toBe('text');
  });

  it('falls back to auto-detect for unrecognised explicit values (returns toon when agentic)', () => {
    mockIsAgenticTui.mockReturnValue(true);
    expect(resolveFormat('auto')).toBe('toon');
  });
});

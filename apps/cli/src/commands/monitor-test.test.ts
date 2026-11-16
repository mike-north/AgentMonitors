import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type {
  ObservationContext,
  ObservationResult,
  SourceRegistry,
} from '@agentmonitors/core';
import path from 'node:path';
import {
  monitorTestCommand,
  configRootForMonitorFile,
  createFollowupObservationContext,
} from './monitor-test.js';

describe('createFollowupObservationContext', () => {
  it('preserves previousState and refreshes now', async () => {
    const previousState = { baseline: 'abc123' };
    const before = new Date('2026-03-20T12:00:00.000Z');

    const next = createFollowupObservationContext({
      now: before,
      previousState,
    });

    expect(next.previousState).toBe(previousState);
    expect(next.now).toBeInstanceOf(Date);
    expect(next.now.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(next.now).not.toBe(before);
  });
});

describe('configRootForMonitorFile', () => {
  it('returns an absolute Windows drive root when config dir is at the drive root', () => {
    const root = configRootForMonitorFile(
      'C:\\.claude\\monitors\\root-monitor\\MONITOR.md',
      path.win32,
    );

    expect(root).toBe('C:\\');
    expect(path.win32.isAbsolute(root)).toBe(true);
  });
});

/** The initial baseline belongs to the source; CLI only tests for its presence. */
describe('initial stateful baseline contract', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'baseline-guard-'));
  const file = path.join(root, 'MONITOR.md');
  writeFileSync(
    file,
    '---\nname: Guard\nwatch:\n  type: guard-source\nurgency: normal\n---\nHandle changes.\n',
  );
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    observe.mockReset();
  });

  async function run(format = 'json') {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await monitorTestCommand.parseAsync([
      'node',
      'monitor',
      'test',
      file,
      '--format',
      format,
    ]);
    return {
      stdout: output.mock.calls.map((c) => String(c[0])).join('\n'),
      stderr: error.mock.calls.map((c) => String(c[0])).join('\n'),
    };
  }

  it.each([undefined, null])(
    'rejects missing initial state %s before second observe',
    async (nextState) => {
      observe.mockResolvedValue({ observations: [], nextState });
      const result = await run();
      expect(JSON.parse(result.stdout)).toEqual({
        error:
          'Observation failed: Stateful source "guard-source" returned no baseline state.',
      });
      expect(result.stderr).toBe('');
      expect(process.exitCode).toBe(1);
      expect(observe).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects missing state in text without announcing a baseline', async () => {
    observe.mockResolvedValue({ observations: [] });
    const result = await run('text');
    expect(result.stdout).toBe(
      'Testing monitor "Guard" (source: guard-source)...',
    );
    expect(result.stderr).toBe(
      'Error: Observation failed: Stateful source "guard-source" returned no baseline state.',
    );
    expect(process.exitCode).toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it.each([0, false, '', { ref: 'source-owned' }])(
    'accepts non-null source-owned state %s',
    async (nextState) => {
      observe.mockResolvedValue({ observations: [], nextState });
      const result = await run();
      expect(JSON.parse(result.stdout)).toEqual({
        monitor: 'Guard',
        source: 'guard-source',
        baseline: true,
        observations: [],
      });
      expect(observe).toHaveBeenCalledTimes(2);
      expect(observe.mock.calls[1]?.[1].previousState).toEqual(nextState);
      expect(process.exitCode).not.toBe(1);
    },
  );

  it('preserves no-files-matched precedence over absent baseline state', async () => {
    observe.mockResolvedValue({
      observations: [],
      outcome: 'no-files-matched',
    });
    const result = await run();
    expect(JSON.parse(result.stdout)).toEqual({
      monitor: 'Guard',
      source: 'guard-source',
      baseline: false,
      outcome: 'no-files-matched',
      observations: [],
      error: `No files matched this monitor's globs. Check watch.globs and watch.cwd relative to workspace: ${root}`,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it.each(['text', 'json'])(
    'reports a failed followup truthfully in %s',
    async (format) => {
      observe
        .mockResolvedValueOnce({ observations: [], nextState: 0 })
        .mockRejectedValueOnce(new Error('temporarily unavailable'));
      const result = await run(format);
      expect(process.exitCode).toBe(1);
      expect(observe).toHaveBeenCalledTimes(2);
      if (format === 'json') {
        expect(JSON.parse(result.stdout)).toEqual({
          error: 'Observation failed: temporarily unavailable',
        });
        expect(result.stderr).toBe('');
      } else {
        expect(result.stdout).toContain('Baseline established.');
        expect(result.stdout).not.toContain('No changes detected');
        expect(result.stdout).not.toContain('configured correctly');
        expect(result.stderr).toBe(
          'Error: Observation failed: temporarily unavailable',
        );
      }
    },
  );
});

// A controlled plugin exercises the real command action without public test-only APIs.
const { observe } = vi.hoisted(() => ({
  observe:
    vi.fn<
      (
        config: Record<string, unknown>,
        context: ObservationContext,
      ) => Promise<ObservationResult>
    >(),
}));
vi.mock('../sources.js', () => ({
  registerCoreSources(registry: SourceRegistry) {
    registry.register({
      name: 'guard-source',
      stateful: true,
      scopeSchema: {},
      observe,
    });
  },
}));

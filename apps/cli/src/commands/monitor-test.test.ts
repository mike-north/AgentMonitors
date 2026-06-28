import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
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

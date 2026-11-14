/** Test cleanup must require a group-creation receipt and current identity continuity. */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  parseOwnedCaptureGroup,
  cleanupOwnedCaptureGroup,
  recordOwnedCaptureGroup,
} from './fixtures/owned-capture-group.mjs';

const receipt =
  '100\nps\n100 100 Thu Nov 12 10:00:00 2026\n101 100 Thu Nov 12 10:00:01 2026\n';
it('rejects a wrapper that inherited another process group before cleanup can signal', () => {
  expect(() =>
    parseOwnedCaptureGroup(receipt.replace('100 100', '100 50')),
  ).toThrow(/did not create/);
});
it('does nothing for an empty formerly owned group, without a negative-PGID signal', async () => {
  const signal = vi.fn();
  await cleanupOwnedCaptureGroup(parseOwnedCaptureGroup(receipt), {
    readTable: async () => ({ supported: true, processes: [] }),
    signal,
  });
  expect(signal).not.toHaveBeenCalled();
});
it('refuses a recycled group containing no matching recorded incarnation', async () => {
  const signal = vi.fn();
  await expect(
    cleanupOwnedCaptureGroup(parseOwnedCaptureGroup(receipt), {
      readTable: async () => ({
        supported: true,
        processes: [{ pid: 100, pgid: 100, startTime: 'new' }],
      }),
      isTerminated: () => false,
      signal,
    }),
  ).rejects.toThrow(/continuity/);
  expect(signal).not.toHaveBeenCalled();
});
it('signals only individually verified members while a recorded owned anchor still confirms the group', async () => {
  const member = { pid: 101, pgid: 100, startTime: 'Thu Nov 12 10:00:01 2026' };
  const signal = vi.fn(async () => ({ status: 'sent' }));
  await cleanupOwnedCaptureGroup(parseOwnedCaptureGroup(receipt), {
    readTable: async () => ({ supported: true, processes: [member] }),
    isTerminated: () => false,
    signal,
  });
  expect(signal).toHaveBeenCalledExactlyOnceWith(member);
});
it('accepts a group containing only proven terminal remnants after its recorded anchor exits', async () => {
  const remnant = { pid: 102, pgid: 100, startTime: 'later' };
  const signal = vi.fn();
  const isTerminated = vi.fn(() => true);
  await cleanupOwnedCaptureGroup(parseOwnedCaptureGroup(receipt), {
    readTable: async () => ({ supported: true, processes: [remnant] }),
    isTerminated,
    signal,
  });
  expect(isTerminated).toHaveBeenCalledExactlyOnceWith(remnant.pid);
  expect(signal).not.toHaveBeenCalled();
});
it('withholds every signal when terminal evidence is unavailable', async () => {
  const signal = vi.fn();
  await expect(
    cleanupOwnedCaptureGroup(parseOwnedCaptureGroup(receipt), {
      readTable: async () => ({
        supported: true,
        processes: [
          { pid: 101, pgid: 100, startTime: 'Thu Nov 12 10:00:01 2026' },
          { pid: 102, pgid: 100, startTime: 'later' },
        ],
      }),
      isTerminated: (pid: number) => {
        if (pid === 102) throw new Error('terminal evidence unavailable');
        return false;
      },
      signal,
    }),
  ).rejects.toThrow('terminal evidence unavailable');
  expect(signal).not.toHaveBeenCalled();
});

it('records every initial member so a watchdog still authorizes cleanup after other anchors exit', async () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), 'capture-receipt-')),
    'owned',
  );
  const group = 424242;
  const watchdog = { pid: 424243, pgid: group, startTime: 'watchdog-start' };
  const records = [
    { pid: group, pgid: group, startTime: 'leader-start' },
    { pid: process.pid, pgid: group, startTime: 'recorder-start' },
    watchdog,
  ];
  await recordOwnedCaptureGroup(filename, group, {
    readTable: async () => ({ supported: true, processes: records }),
  });
  const recorded = parseOwnedCaptureGroup(readFileSync(filename, 'utf8'));
  expect(recorded.records).toEqual(records);
  const signal = vi.fn(async () => ({ status: 'sent' }));
  await cleanupOwnedCaptureGroup(recorded, {
    readTable: async () => ({ supported: true, processes: [watchdog] }),
    isTerminated: () => false,
    signal,
  });
  expect(signal).toHaveBeenCalledExactlyOnceWith(watchdog);
});

it('refuses a receipt when the recorder is not in the expected fixture group', async () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), 'capture-unowned-')),
    'owned',
  );
  await expect(
    recordOwnedCaptureGroup(filename, 424242, {
      readTable: async () => ({
        supported: true,
        processes: [
          { pid: process.pid, pgid: 999, startTime: 'recorder-start' },
        ],
      }),
    }),
  ).rejects.toThrow(/exclusive|group/);
  expect(existsSync(filename)).toBe(false);
});

/** Test cleanup must require a group-creation receipt and current identity continuity. */
import { expect, it, vi } from 'vitest';
import {
  parseOwnedCaptureGroup,
  cleanupOwnedCaptureGroup,
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

/** Group completion requires terminal evidence, with no hidden permission/read failures. */
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { waitForOwnedGroupTermination } from './owned-test-group.mjs';
const { list, stat } = vi.hoisted(() => ({
  list: vi.fn<() => Promise<string[]>>(),
  stat: vi.fn<() => Promise<string>>(),
}));
vi.mock('node:fs/promises', () => ({ readdir: list, readFile: stat }));
vi.mock('node:os', () => ({ platform: () => 'linux' }));
afterEach(() => vi.restoreAllMocks());

it('waits for a pending-kill worker to reach terminal state', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  list.mockResolvedValue(['123']);
  stat
    .mockResolvedValueOnce('123 (owned) R 1 456 0')
    .mockResolvedValue('123 (owned) Z 1 456 0');
  await waitForOwnedGroupTermination(456, Date.now() + 1_000);
  expect(stat).toHaveBeenCalledTimes(2);
});

it.each(['EPERM', 'EACCES'])(
  'does not hide %s during group confirmation',
  async (code) => {
    const error = Object.assign(new Error('denied'), { code });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (code === 'EPERM') throw error;
      return true;
    });
    list.mockResolvedValue(['123']);
    stat.mockRejectedValue(error);
    await expect(
      waitForOwnedGroupTermination(456, Date.now() + 1_000),
    ).rejects.toThrow('denied');
  },
);

it('fails within the existing deadline if a worker is not terminal', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  list.mockResolvedValue(['123']);
  stat.mockResolvedValue('123 (owned) R 1 456 0');
  await expect(
    waitForOwnedGroupTermination(456, Date.now() - 1),
  ).rejects.toThrow('not terminated');
});

it('does not equate a disappearing proc entry with group termination', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  list.mockResolvedValue(['123']);
  stat.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
  await expect(
    waitForOwnedGroupTermination(456, Date.now() - 1),
  ).rejects.toThrow('not terminated');
});

it('rejects a terminal proc result that arrives after the absolute deadline', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  list.mockResolvedValue(['123']);
  stat.mockImplementation(async () => {
    now = 1_020;
    return '123 (owned) Z 1 456 0';
  });
  await expect(waitForOwnedGroupTermination(456, 1_010)).rejects.toThrow(
    'deadline',
  );
});

it('stops a sequential proc scan when its budget expires', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  list.mockResolvedValue(['123', '124']);
  stat.mockClear().mockImplementation(async () => {
    now = 1_020;
    return '123 (other) Z 1 999 0';
  });
  await expect(waitForOwnedGroupTermination(456, 1_010)).rejects.toThrow(
    'deadline',
  );
  expect(stat).toHaveBeenCalledTimes(1);
});

it('does not begin a query after its deadline even if the group is gone', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_020);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  await expect(waitForOwnedGroupTermination(456, 1_010)).rejects.toThrow(
    'deadline',
  );
  expect(kill).not.toHaveBeenCalled();
});

it('returns a deadline error for a pending query and starts no later proc reads', async () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  let release!: (entries: string[]) => void;
  const gate = new Promise<string[]>((resolve) => {
    release = resolve;
  });
  list.mockImplementationOnce(() => gate);
  stat.mockClear().mockResolvedValue('123 (owned) Z 1 456 0');
  const operation = waitForOwnedGroupTermination(456, Date.now() + 50).then(
    () => 'success',
    (error) =>
      error instanceof Error && /deadline/.test(error.message)
        ? 'deadline'
        : 'other error',
  );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve('hung'), 100);
      }),
    ]);
    expect(result).toBe('deadline');
  } finally {
    clearTimeout(watchdog);
    release(['123']);
    await operation;
    await setImmediate();
  }
  expect(stat).not.toHaveBeenCalled();
});

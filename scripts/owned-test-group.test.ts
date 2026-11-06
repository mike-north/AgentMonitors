/** Group completion requires terminal evidence, with no hidden permission/read failures. */
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

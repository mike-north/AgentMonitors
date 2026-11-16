/** Watchdog metadata can withhold cleanup but never replaces the life nonce. */
import { readFile, stat } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { readCommandMarks } from './command-process-marks.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
  stat: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each(['watchdog', 'command', ''])(
  'reads Linux role %s beside the unchanged life mark',
  async (role) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    // The ownership reader consumes only uid from this filesystem fixture.
    vi.mocked(stat).mockResolvedValue({ uid: process.getuid?.() } as Awaited<
      ReturnType<typeof stat>
    >);
    vi.mocked(readFile).mockResolvedValue(
      `AGENTMONITORS_COMMAND_LIFE=life\0AGENTMONITORS_COMMAND_ROLE=${role}\0`,
    );
    const result = await readCommandMarks([4242]);
    expect(result.supported && result.marks.get(4242)).toBe('life');
    expect(result.supported && result.watchdogs?.has(4242)).toBe(
      role === 'watchdog',
    );
  },
);

it('keeps unreadable Linux ownership uncertain rather than inventing a role', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.mocked(stat).mockResolvedValue({ uid: process.getuid?.() } as Awaited<
    ReturnType<typeof stat>
  >);
  vi.mocked(readFile).mockRejectedValue(
    Object.assign(new Error('unreadable'), { code: 'EACCES' }),
  );
  const result = await readCommandMarks([4242]);
  expect(result.supported && result.unreadable).toEqual([4242]);
  expect(result.supported && result.watchdogs?.size).toBe(0);
});

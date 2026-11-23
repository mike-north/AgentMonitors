/** Termination accepts proven Linux zombies, never live workers or unreadable evidence. */
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { ownedWorkerTerminated } from './owned-worker-terminated.mjs';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
vi.mock('node:os', () => ({ platform: () => 'linux' }));

afterEach(() => vi.restoreAllMocks());

it.each(['Z', 'X', 'x'])(
  'accepts a proven terminated Linux worker in state %s',
  (state) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      `Name:\towned\nState:\t${state} (terminated)\n`,
    );
    expect(ownedWorkerTerminated(123)).toBe(true);
  },
);

it.each(['R', 'S', 'T'])(
  'rejects a live or suspended worker in state %s',
  (state) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(`State:\t${state} (live)\n`);
    expect(ownedWorkerTerminated(123)).toBe(false);
  },
);

it('accepts ESRCH as termination', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  expect(ownedWorkerTerminated(123)).toBe(true);
});

it('does not hide signal permission errors', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  expect(() => ownedWorkerTerminated(123)).toThrow('denied');
});

it.each(['EACCES', 'ENOENT'])(
  'does not accept unreadable proc evidence while the worker still exists: %s',
  (code) => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('proc unavailable'), { code });
    });
    expect(() => ownedWorkerTerminated(123)).toThrow('proc unavailable');
  },
);

it('requires a recognizable proc state', () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue('no state');
  expect(() => ownedWorkerTerminated(123)).toThrow('state');
});

it('accepts a proc-read disappearance only after confirming ESRCH', () => {
  vi.spyOn(process, 'kill')
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
  vi.mocked(readFileSync).mockImplementation(() => {
    throw Object.assign(new Error('proc disappeared'), { code: 'ENOENT' });
  });
  expect(ownedWorkerTerminated(123)).toBe(true);
});

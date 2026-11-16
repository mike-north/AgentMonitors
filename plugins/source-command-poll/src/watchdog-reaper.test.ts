/** Wait authority comes only from a reported watchdog's exact adopted-zombie identity. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatchdogReaper } from './watchdog-reaper.js';

/** Linux stat field 22 pins a PID lifetime; comm may contain spaces and parentheses. */
function stat({
  pid = 401,
  state = 'Z',
  parent = 100,
  group = 300,
  session = 300,
  start = '987654',
} = {}): string {
  const fields = Array<string>(20).fill('0');
  fields[0] = state;
  fields[1] = String(parent);
  fields[2] = String(group);
  fields[3] = String(session);
  fields[19] = start;
  return `${String(pid)} (watchdog ) name) ${fields.join(' ')}`;
}

/** No unit fixture creates or signals a real process; all PIDs are protocol data. */
function fixture({ platform = 'linux', pid = 100, subreaper = true } = {}) {
  vi.useFakeTimers();
  const readStat = vi.fn(() => stat({ parent: pid }));
  const waitpid = vi.fn(
    (target: number, _status: Buffer, _flags: number) => target,
  );
  const isSubreaper = vi.fn(() => subreaper);
  const track = createWatchdogReaper({
    platform,
    pid,
    readStat,
    waitpid,
    isSubreaper,
  });
  return { track, readStat, waitpid, isSubreaper };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('adopted watchdog wait authority', () => {
  it('waits only for the reported zombie with WNOHANG and releases its timer', () => {
    const f = fixture();
    f.track(401, '987654', 300);
    expect(f.waitpid).toHaveBeenCalledExactlyOnceWith(
      401,
      expect.any(Buffer),
      1,
    );
    expect(f.readStat.mock.invocationCallOrder[0]).toBeLessThan(
      f.waitpid.mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows PID 1 without querying subreaper state', () => {
    const f = fixture({ pid: 1, subreaper: false });
    f.track(401, '987654', 300);
    expect(f.waitpid).toHaveBeenCalledWith(401, expect.any(Buffer), 1);
    expect(f.isSubreaper).not.toHaveBeenCalled();
  });

  it.each(['R', 'S', 'T', 'X'])(
    'does not wait on a %s child until it becomes a zombie',
    (state) => {
      const f = fixture();
      f.readStat.mockReturnValue(stat({ state }));
      f.track(401, '987654', 300);
      expect(f.waitpid).not.toHaveBeenCalled();
      f.readStat.mockReturnValue(stat());
      vi.advanceTimersByTime(100);
      expect(f.waitpid).toHaveBeenCalledExactlyOnceWith(
        401,
        expect.any(Buffer),
        1,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ['another parent', stat({ parent: 999 })],
    ['recycled PID', stat({ start: '987655' })],
    ['another group', stat({ group: 999 })],
    ['another session', stat({ session: 999 })],
    ['wrong stat PID', stat({ pid: 402 })],
    ['malformed stat', 'not a proc record'],
    ['truncated stat', '401 (watchdog) Z 100 300 300'],
  ])('never waits on %s and forgets the candidate', (_name, value) => {
    const f = fixture();
    f.readStat.mockReturnValue(value);
    f.track(401, '987654', 300);
    vi.advanceTimersByTime(100);
    expect(f.waitpid).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forgets vanished or unreadable processes without attempting a wait', () => {
    const f = fixture();
    f.readStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    f.track(401, '987654', 300);
    expect(f.waitpid).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { platform: 'darwin', pid: 1, subreaper: true },
    { platform: 'linux', pid: 100, subreaper: false },
  ])('does no proc reads or waits for an ineligible host: %j', (host) => {
    const f = fixture(host);
    f.track(401, '987654', 300);
    vi.advanceTimersByTime(100);
    expect(f.readStat).not.toHaveBeenCalled();
    expect(f.waitpid).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops reaping when subreaper status is revoked', () => {
    const f = fixture();
    f.readStat.mockReturnValue(stat({ state: 'S' }));
    f.track(401, '987654', 300);
    f.isSubreaper.mockReturnValue(false);
    f.readStat.mockReturnValue(stat());
    vi.advanceTimersByTime(100);
    expect(f.waitpid).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, 0, 1, 100, 1.5, NaN, Infinity])(
    'rejects invalid or self PID %s before inspecting proc',
    (pid) => {
      const f = fixture();
      f.track(pid, '987654', 300);
      expect(f.readStat).not.toHaveBeenCalled();
      expect(f.waitpid).not.toHaveBeenCalled();
    },
  );

  it('rechecks zombie identity before retrying a nonblocking wait', () => {
    const f = fixture();
    f.waitpid.mockReturnValueOnce(0);
    f.track(401, '987654', 300);
    f.readStat.mockReturnValue(stat({ start: 'reused' }));
    vi.advanceTimersByTime(100);
    expect(f.waitpid).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never inspects or waits on any unreported child', () => {
    const f = fixture();
    f.track(401, '987654', 300);
    vi.advanceTimersByTime(100);
    expect(f.readStat.mock.calls).toEqual([[401]]);
    expect(f.waitpid.mock.calls.map((call) => call[0])).toEqual([401]);
  });

  it('retries a nonblocking wait without widening its PID selector', () => {
    const f = fixture();
    f.waitpid.mockReturnValueOnce(0);
    f.track(401, '987654', 300);
    vi.advanceTimersByTime(100);
    expect(f.waitpid).toHaveBeenCalledTimes(2);
    for (const args of f.waitpid.mock.calls) {
      expect(args).toEqual([401, expect.any(Buffer), 1]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('withholds waits when subreaper eligibility cannot be read', () => {
    const f = fixture();
    f.isSubreaper.mockImplementation(() => {
      throw new Error('prctl unavailable');
    });
    f.track(401, '987654', 300);
    expect(f.readStat).not.toHaveBeenCalled();
    expect(f.waitpid).not.toHaveBeenCalled();
  });
  it('waits for a reported watchdog to become this observer own adopted zombie', () => {
    const f = fixture();
    f.readStat.mockReturnValue(stat({ parent: 350 }));
    f.track(401, '987654', 300, 350);
    expect(f.waitpid).not.toHaveBeenCalled();
    f.readStat.mockReturnValue(stat());
    vi.advanceTimersByTime(100);
    expect(f.waitpid).toHaveBeenCalledExactlyOnceWith(
      401,
      expect.any(Buffer),
      1,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forgets a registered lifetime if adoption goes to an unexpected parent', () => {
    const f = fixture();
    f.readStat.mockReturnValue(stat({ parent: 350 }));
    f.track(401, '987654', 300, 350);
    f.readStat.mockReturnValue(stat({ parent: 999 }));
    vi.advanceTimersByTime(100);
    expect(f.waitpid).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

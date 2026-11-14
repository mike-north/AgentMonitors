/** The standalone watchdog's timers and self-group signals have no daemon dependency. */
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { WATCHDOG_PROGRAM } from './self-bound.js';

/** Deterministic OS seams: this fixture cannot signal or launch a real process. */
function watchdogFixture(timeout = 1000) {
  let now = 0;
  let wall = 0;
  const timers = new Set<{
    at: number;
    run: () => void;
    unref: ReturnType<typeof vi.fn>;
  }>();
  const control = new EventEmitter();
  Object.assign(control, { destroy: vi.fn() });
  const kill = vi.fn();
  const send = vi.fn();
  runInNewContext(WATCHDOG_PROGRAM, {
    require: (name: string) => {
      if (name === 'node:net')
        return {
          Socket: function () {
            return control;
          },
        };
      throw new Error('Unexpected watchdog dependency: ' + name);
    },
    process: {
      hrtime: { bigint: () => BigInt(now) * 1000000n },
      pid: 11,
      argv: ['node', JSON.stringify({ deadline: timeout, grace: 5000 })],
      on: vi.fn(),
      kill,
      send,
      disconnect: vi.fn(),
    },
    Date: { now: () => wall },
    setTimeout: (run: () => void, delay: number) => {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(2147483647);
      const timer = { at: now + delay, run, unref: vi.fn() };
      timers.add(timer);
      return timer;
    },
  });
  return {
    timers,
    control,
    kill,
    send,
    moveWallClock(at: number) {
      wall = at;
    },
    advance(at: number) {
      wall += at - now;
      now = at;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
      }
    },
  };
}

describe('standalone watchdog', () => {
  it('keeps referenced timers after daemon EOF and signals only its current group', () => {
    const fixture = watchdogFixture();
    expect(fixture.send).toHaveBeenCalledWith('armed');
    for (const timer of fixture.timers)
      expect(timer.unref).not.toHaveBeenCalled();
    fixture.control.emit('end');
    fixture.control.emit('error', new Error('daemon gone'));
    fixture.advance(999);
    expect(fixture.kill).not.toHaveBeenCalled();
    fixture.advance(1000);
    expect(fixture.kill.mock.calls).toEqual([[0, 'SIGTERM']]);
    fixture.advance(6000);
    expect(fixture.kill.mock.calls).toEqual([
      [0, 'SIGTERM'],
      [0, 'SIGKILL'],
    ]);
  });

  for (const message of ['complete', 'cancel']) {
    it(`ends its current group on ${message} without guessing whether a late fork exists`, () => {
      const fixture = watchdogFixture();
      fixture.control.emit('data', Buffer.from(message + '\n'));
      expect(fixture.kill.mock.calls).toEqual([[0, 'SIGKILL']]);
    });
  }

  it('requires a complete control message before ending the group', () => {
    const fixture = watchdogFixture();
    fixture.control.emit('data', Buffer.from('comp'));
    expect(fixture.kill).not.toHaveBeenCalled();
    fixture.control.emit('data', Buffer.from('lete\n'));
    expect(fixture.kill.mock.calls).toEqual([[0, 'SIGKILL']]);
  });

  it('does not extend execution when the wall clock moves backwards', () => {
    const fixture = watchdogFixture();
    fixture.moveWallClock(-10000);
    fixture.advance(1000);
    expect(fixture.kill.mock.calls).toEqual([[0, 'SIGTERM']]);
    fixture.advance(6000);
    expect(fixture.kill.mock.calls).toEqual([
      [0, 'SIGTERM'],
      [0, 'SIGKILL'],
    ]);
  });

  it('does not overflow the maximum timeout when adding the kill grace', () => {
    const fixture = watchdogFixture(2147483647);
    fixture.advance(1);
    expect(fixture.kill).not.toHaveBeenCalled();
    fixture.advance(2147483647);
    expect(fixture.kill.mock.calls).toEqual([[0, 'SIGTERM']]);
    fixture.advance(2147488647);
    expect(fixture.kill.mock.calls).toEqual([
      [0, 'SIGTERM'],
      [0, 'SIGKILL'],
    ]);
  });
});

/** A watchdog must register its lifetime before a deadline can kill its intermediates. */
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LAUNCHER_PROGRAM, WATCHDOG_PROGRAM } from './self-bound.js';

/** Every OS surface is synthetic; even an elapsed deadline cannot signal a real process. */
function fixture({
  expired = false,
  unreadable = false,
  shortWrite = false,
} = {}) {
  const events: string[] = [];
  const output: Buffer[] = [];
  const control = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const fields = Array<string>(20).fill('0');
  fields[0] = 'R';
  fields[19] = '987654';
  const send = vi.fn((message: unknown, callback?: () => void) => {
    events.push(message === 'armed' ? 'armed' : 'error');
    callback?.();
  });
  const kill = vi.fn((pid: number, signal: string) => {
    // A mock records virtual group 0 only; it has no native signaling operation.
    expect(pid).toBe(0);
    events.push(signal);
  });
  const exit = vi.fn();
  runInNewContext(WATCHDOG_PROGRAM, {
    Buffer,
    require: (name: string) => {
      if (name === 'node:net')
        return {
          Socket: function () {
            return control;
          },
        };
      if (name === 'node:fs')
        return {
          readFileSync: (name: string) => {
            expect(name).toBe('/proc/self/stat');
            if (unreadable) throw new Error('Cannot read birth');
            return `401 (watchdog ) name) ${fields.join(' ')}`;
          },
          writeSync: (
            fd: number,
            bytes: Buffer,
            offset: number,
            length: number,
          ) => {
            expect(fd).toBe(5);
            events.push('write');
            const written = shortWrite ? Math.min(3, length) : length;
            output.push(Buffer.from(bytes.subarray(offset, offset + written)));
            return written;
          },
          closeSync: (fd: number) => {
            expect(fd).toBe(5);
            events.push('close');
          },
        };
      throw new Error('Unexpected dependency: ' + name);
    },
    process: {
      platform: 'linux',
      pid: 401,
      ppid: 350,
      argv: [
        'node',
        JSON.stringify({ deadline: expired ? 0 : 1000, grace: 5000 }),
      ],
      hrtime: { bigint: () => 0n },
      on: vi.fn(),
      send,
      kill,
      exit,
      disconnect: vi.fn(),
    },
    setTimeout: vi.fn(() => {
      events.push('timer');
    }),
  });
  return { events, output: Buffer.concat(output).toString(), send, kill, exit };
}

describe('watchdog adoption registration', () => {
  it.each([false, true])(
    'delivers a complete identity before arming, including short writes: %s',
    (shortWrite) => {
      const f = fixture({ shortWrite });
      expect(JSON.parse(f.output)).toEqual({
        kind: 'watchdog',
        pid: 401,
        parent: 350,
        startTime: '987654',
      });
      expect(f.events.indexOf('close')).toBeLessThan(f.events.indexOf('timer'));
      expect(f.events.indexOf('close')).toBeLessThan(f.events.indexOf('armed'));
    },
  );

  it('registers before an already elapsed deadline can terminate its parents', () => {
    const f = fixture({ expired: true });
    expect(f.events.indexOf('close')).toBeGreaterThanOrEqual(0);
    expect(f.events.indexOf('close')).toBeLessThan(f.events.indexOf('SIGTERM'));
  });

  it('refuses arming if its own birth identity cannot be read', () => {
    const f = fixture({ unreadable: true });
    expect(f.send).not.toHaveBeenCalledWith('armed');
    expect(f.events).not.toContain('timer');
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.exit).toHaveBeenCalledWith(1);
  });
});

it('reaps an unarmed watchdog before its Linux intermediate reports failure', () => {
  const child = new EventEmitter();
  const send = vi.fn((_message: unknown, callback: () => void) => callback());
  const exit = vi.fn();
  // Exercise the actual embedded intermediate, with no OS process or signal API.
  const start = LAUNCHER_PROGRAM.indexOf('function parentWatchdog()');
  const end = LAUNCHER_PROGRAM.indexOf('// A frame is a byte protocol:');
  runInNewContext(LAUNCHER_PROGRAM.slice(start, end) + '\nparentWatchdog();', {
    require: (name: string) => {
      expect(name).toBe('node:child_process');
      return { spawn: () => child };
    },
    process: {
      platform: 'linux',
      execPath: '/fixture/node',
      env: {},
      argv: [
        'node',
        JSON.stringify({ watchdog: 'fixture', deadline: 1000, grace: 5000 }),
      ],
      send,
      exit,
    },
  });
  child.emit('message', { kind: 'error', error: 'Cannot read birth' });
  expect(send).not.toHaveBeenCalled();
  child.emit('exit', 1, null);
  expect(send).not.toHaveBeenCalled();
  child.emit('close', 1, null);
  expect(send.mock.calls[0]?.[0]).toEqual({
    kind: 'error',
    error: 'Cannot read birth',
  });
  expect(exit).toHaveBeenCalledWith(1);
});

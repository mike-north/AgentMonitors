/** Failure-path contracts for the Docker smoke wrapper, without Docker. */
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => mocks);
import {
  runSmokeContainer,
  SMOKE_TEST_TIMEOUT_MS,
  reportContainerFailure,
  assertSmokeContainerSuccess,
} from './fixtures/smoke-container.js';
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
function client() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return true;
    }),
  });
  mocks.spawn.mockReturnValue(child);
  return child;
}
it('reports runaway output as output-limit rather than a deadline', async () => {
  vi.useFakeTimers();
  const child = client();
  const pending = runSmokeContainer('echo fixture');
  child.stdout.emit('data', Buffer.alloc(21 * 1024 * 1024));
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result).toMatchObject({
    timedOut: false,
    terminationReason: 'output-limit',
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    /* Failure output is asserted through the thrown diagnostic. */
  });
  try {
    expect(() => reportContainerFailure(result)).toThrow(/output.*limit/i);
  } finally {
    error.mockRestore();
  }
});
it('kills a pre-creation client and retries bounded container removal', async () => {
  vi.useFakeTimers();
  const child = client();
  const pending = runSmokeContainer('sleep forever');
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.timedOut).toBe(true);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  const removals = mocks.execFileSync.mock.calls.filter(
    (call) => call[1][0] === 'rm',
  );
  expect(removals.length).toBeGreaterThan(1);
  for (const call of removals)
    expect(call[2]).toMatchObject({ timeout: 10000, killSignal: 'SIGKILL' });
});
it('retains phase diagnostics and reports spawn errors', async () => {
  const child = client();
  const pending = runSmokeContainer('fixture');
  child.stderr.emit('data', Buffer.from('phase build-core: compile failure'));
  child.emit('error', new Error('spawn denied'));
  child.emit('close', null, null);
  const result = await pending;
  expect(result.stderr).toContain('phase build-core');
  expect(result.stderr).toContain('spawn denied');
});

it('rejects output-cap termination even when the client wins the race and exits zero', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    /* Expected failure diagnostics. */
  });
  try {
    expect(() =>
      assertSmokeContainerSuccess({
        code: 0,
        signal: null,
        stdout:
          'CLAUDE_VERSION=ok\nSTATUS_RUNNING=true\nEVENT_COUNT=1\nCLAIM_URGENCY=normal',
        stderr: '',
        timedOut: false,
        terminationReason: 'output-limit',
      }),
    ).toThrow(/output.*limit/);
  } finally {
    error.mockRestore();
  }
});

it.each(['deadline', 'output-limit'] as const)(
  'completes worst-case %s cleanup and actual failure reporting with a 30s reserve',
  async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const child = client();
    const started = Date.now();
    expect(SMOKE_TEST_TIMEOUT_MS).toBe(300_000);
    // Model each synchronous Docker client consuming its entire configured
    // bound. setSystemTime models blocking work without firing nested timers.
    mocks.execFileSync.mockImplementation((_command, _args, options) => {
      vi.setSystemTime(Date.now() + Number(options.timeout));
      throw new Error('bounded Docker client timeout');
    });
    const pending = runSmokeContainer('fixture');
    child.stderr.emit(
      'data',
      Buffer.from('phase build-core: retained diagnostic'),
    );
    if (reason === 'output-limit')
      child.stdout.emit('data', Buffer.alloc(21 * 1024 * 1024));
    await vi.runAllTimersAsync();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const result = await pending;
    expect(result.terminationReason).toBe(reason);
    expect(result.timedOut).toBe(reason === 'deadline');
    const calls = mocks.execFileSync.mock.calls;
    expect(calls.filter((call) => call[1][0] === 'exec')).toHaveLength(1);
    // Initial removal, close removal and all three late-creation retries stay.
    expect(calls.filter((call) => call[1][0] === 'rm')).toHaveLength(5);
    for (const call of calls)
      expect(call[2]).toMatchObject({
        timeout: call[1][0] === 'exec' ? 5000 : 10000,
        killSignal: 'SIGKILL',
      });
    let reportAt = Infinity;
    const report = vi.spyOn(console, 'error').mockImplementation(() => {
      reportAt = Date.now();
    });
    try {
      expect(() => assertSmokeContainerSuccess(result)).toThrow(
        reason === 'deadline' ? /deadline/ : /output limit/,
      );
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining('phase build-core: retained diagnostic'),
      );
      expect(reportAt - started).toBeLessThanOrEqual(270_000);
      expect(reportAt - started).toBe(reason === 'deadline' ? 270_000 : 59_500);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      report.mockRestore();
    }
  },
);

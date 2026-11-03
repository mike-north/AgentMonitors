/** Failure-path contracts for the Docker smoke wrapper, without Docker. */
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => mocks);
import {
  runSmokeContainer,
  reportContainerFailure,
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

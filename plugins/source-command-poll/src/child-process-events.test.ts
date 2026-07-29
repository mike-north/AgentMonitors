/**
 * Tests for the ChildProcess→event-channel adapter used by `command-poll`'s
 * Windows spawn path (003 §11.2, §11.5).
 *
 * These exist because CI has no Windows runner. The Windows branch of
 * `runCommand` is unreachable here, so its wiring was unprovable — and did in
 * fact ship broken in issue #472 review round 6: a bulk edit turned
 * `child.once('exit', …)` into `commandEvents.once('exit', …)`, which subscribed
 * to the channel and re-emitted onto it instead of forwarding the child's real
 * exit. Nothing ever emitted, so a Windows execution would have hung
 * `observe()` forever — including after the wall-clock kill, since the timeout
 * path resolves from the same event.
 *
 * Exporting the wiring makes the code Windows runs testable on POSIX: these
 * spawn real children and assert the adapter forwards what `runCommand`
 * consumes.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { _adaptChildProcessEvents } from './index.js';

/** Resolve when `events` emits `name`, with the emitted arguments. */
function nextEvent(
  events: EventEmitter,
  name: string,
  timeoutMs = 10_000,
): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for '${name}'`));
    }, timeoutMs);
    events.once(name, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

describe('_adaptChildProcessEvents', () => {
  it("forwards a clean exit as 'exit' with (code, signal)", async () => {
    const events = new EventEmitter();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    _adaptChildProcessEvents(child, events);

    expect(await nextEvent(events, 'exit')).toEqual([0, null]);
  });

  it("forwards the command's real exit code, not a fabricated success", async () => {
    const events = new EventEmitter();
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], {
      stdio: 'ignore',
    });
    _adaptChildProcessEvents(child, events);

    // A nonzero exit is a RESULT, not a failure (003 §11.2/§11.5), so the exact
    // code has to survive the hop.
    expect(await nextEvent(events, 'exit')).toEqual([7, null]);
  });

  it('forwards a signal death as (null, signal)', async () => {
    const events = new EventEmitter();
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30_000)'],
      {
        stdio: 'ignore',
      },
    );
    _adaptChildProcessEvents(child, events);
    child.kill('SIGKILL');

    expect(await nextEvent(events, 'exit')).toEqual([null, 'SIGKILL']);
  });

  it("forwards a spawn failure as 'error' carrying the real message", async () => {
    const events = new EventEmitter();
    const child = spawn('/definitely/not/a/real/binary', [], {
      stdio: 'ignore',
    });
    _adaptChildProcessEvents(child, events);

    const [error] = await nextEvent(events, 'error');
    // 003 §11.5: a spawn failure is an execution failure carrying the real
    // reason — never silently reshaped into an exit code.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/ENOENT/);
  });

  it('does not emit until the child actually settles', async () => {
    const events = new EventEmitter();
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30_000)'],
      {
        stdio: 'ignore',
      },
    );
    let emitted = false;
    events.once('exit', () => {
      emitted = true;
    });
    events.once('error', () => {
      emitted = true;
    });
    _adaptChildProcessEvents(child, events);

    // The self-subscribing regression looked exactly like this from the
    // outside — a channel nobody ever emits on — so pin that a live child
    // produces silence, and that the silence ends when it exits.
    await new Promise((r) => setTimeout(r, 250));
    expect(emitted).toBe(false);

    child.kill('SIGKILL');
    await nextEvent(events, 'exit');
    expect(emitted).toBe(true);
  });
});

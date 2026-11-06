/** Outermost completion must await terminal-state evidence, not only send SIGKILL. */
import { setImmediate } from 'node:timers/promises';
import type { SpawnOptions } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { runJqTestChild } from './run-jq-test-child.mjs';

// A real ignored-stdio worker keeps the group present after the parent exits.
const program =
  "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()";

const { wait, onClose } = vi.hoisted(() => ({
  wait: vi.fn(),
  onClose: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const child = actual.spawn(command, args, options);
      child.once('close', () => onClose());
      return child;
    },
  };
});
vi.mock('./owned-test-group.mjs', () => ({
  waitForOwnedGroupTermination: wait,
}));

it('does not complete while owned-group termination is unconfirmed', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const closed = new Promise<void>((resolve) =>
    onClose.mockImplementationOnce(resolve),
  );
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  wait.mockImplementation(async () => {
    enter();
    await gate;
  });
  let settled = false;
  const operation = runJqTestChild(['-e', program], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 1_000,
  }).then((result) => {
    settled = true;
    return result;
  });
  try {
    const first = await Promise.race([
      entered.then(() => 'checking'),
      operation.then(() => 'returned'),
    ]);
    expect(first).toBe('checking');
    await closed;
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    release();
    await operation;
  }
}, 5_000);

it('reports termination-confirmation failure instead of claiming successful cleanup', async () => {
  wait.mockRejectedValue(new Error('owned group is not terminated'));
  const result = await runJqTestChild(['-e', program], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 1_000,
  });
  expect(result.error?.message).toContain('not terminated');
});

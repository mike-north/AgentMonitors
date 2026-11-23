/** Query failure must release its own real process handle without claiming exit. */
import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForOwnedGroupTermination } from './owned-test-group.mjs';

interface IQueryControl {
  child: ChildProcess | undefined;
  requests: number;
  suppress: boolean;
  codes: string[];
}

const control = vi.hoisted<IQueryControl>(() => ({
  child: undefined,
  requests: 0,
  suppress: false,
  codes: [],
}));
vi.mock('node:os', () => ({ platform: () => 'darwin' }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  function execFile(
    file: string,
    _args: string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) {
    expect(file).toBe('/bin/ps');
    const code = control.codes.shift() ?? "console.log('123 456 Z')";
    const child = actual.execFile(
      process.execPath,
      ['-e', code],
      options,
      callback,
    );
    control.child = child;
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      if (
        control.suppress &&
        (signal === 'SIGKILL' || signal === 9 || signal === undefined)
      ) {
        control.requests++;
        // Model Node's successful request flag without claiming process exit.
        Object.defineProperty(child, 'killed', { value: true });
        return true;
      }
      return kill(signal);
    };
    return child;
  }
  // Preserve Node's promisified stdout/stderr shape when testing the original
  // implementation; do not replace its real query-child lifecycle with a mock.
  const { promisify } = await import('node:util');
  Object.defineProperty(execFile, promisify.custom, {
    value: (
      file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
    ) =>
      new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  });
  return { ...actual, execFile };
});

beforeEach(() => {
  control.child = undefined;
  control.requests = 0;
  control.suppress = false;
  control.codes = [];
});
afterEach(() => vi.restoreAllMocks());

/** Node exposes ref state only on its private handle; inspect it with runtime guards. */
function referenced(child: ChildProcess): boolean {
  const handle: unknown = Reflect.get(child, '_handle');
  if (!handle || typeof handle !== 'object') return false;
  const hasRef: unknown = Reflect.get(handle, 'hasRef');
  if (typeof hasRef !== 'function')
    throw new Error('query handle has no ref state');
  return Reflect.apply(hasRef, handle, []) === true;
}

it('releases a real pending Darwin query handle at its deadline before fixture cleanup', async () => {
  control.suppress = true;
  control.codes = [
    "console.error('query diagnostic');setInterval(()=>{},1000)",
  ];
  const start = Date.now();
  const operation = waitForOwnedGroupTermination(456, Date.now() + 200).then(
    () => 'success',
    (error) => error,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result: unknown = await Promise.race([
      operation,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 400);
      }),
    ]);
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) throw new Error('query missed deadline');
    expect(result.message).toMatch(/deadline/);
    expect(Date.now() - start).toBeLessThan(350);
    const child = control.child;
    if (!child?.pid) throw new Error('query was not spawned');
    expect(control.requests).toBeGreaterThanOrEqual(1);
    expect(process.kill(child.pid, 0)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(
      referenced(child),
      'owned query handle must not keep the caller alive',
    ).toBe(false);
    expect(child.stdin?.destroyed).toBe(true);
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
  } finally {
    clearTimeout(timer);
    const child = control.child;
    if (child?.pid && child.exitCode === null) {
      const close = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      process.kill(child.pid, 'SIGKILL');
      await close;
    }
    await operation;
    await setImmediate();
  }
});

it('accepts actual Darwin terminal membership after an earlier live query', async () => {
  control.codes = ["console.log('123 456 R')", "console.log('123 456 Z')"];
  await expect(
    waitForOwnedGroupTermination(456, Date.now() + 1_000),
  ).resolves.toBeUndefined();
  expect(control.codes).toHaveLength(0);
});

it('rejects malformed actual Darwin query output', async () => {
  control.codes = ["console.log('unreadable')"];
  await expect(
    waitForOwnedGroupTermination(456, Date.now() + 1_000),
  ).rejects.toThrow('Unreadable');
});

it('retains actual query failure diagnostics', async () => {
  control.codes = [
    "console.error('query permission diagnostic');process.exitCode=2",
  ];
  await expect(
    waitForOwnedGroupTermination(456, Date.now() + 1_000),
  ).rejects.toThrow('query permission diagnostic');
});

/** Outermost completion must await terminal-state evidence, not only send SIGKILL. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { runJqTestChild } from './run-jq-test-child.mjs';

// A real ignored-stdio worker keeps the group present after the parent exits.
const program =
  "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()";

const { wait, onClose, onSpawn } = vi.hoisted(() => ({
  wait: vi.fn(),
  onClose: vi.fn(),
  onSpawn: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const child = actual.spawn(command, args, options);
      onSpawn(child);
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

it('returns an async confirmation error while a real worker still holds both pipes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jq-held-error-pipes-'));
  const file = join(dir, 'worker.pid');
  const realKill = process.kill.bind(process);
  let group: number | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  onSpawn.mockImplementationOnce((child: ChildProcess) => {
    group = child.pid;
  });
  const signal = vi
    .spyOn(process, 'kill')
    .mockImplementation((target, kind) => {
      // Suppress only this registered group's SIGKILL to model failed cleanup.
      if (group !== undefined && target === -group && kind === 'SIGKILL')
        return true;
      return realKill(target, kind);
    });
  wait.mockImplementation(
    (_group: number, deadline: number) =>
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('owned confirmation deadline failure')),
          Math.max(1, deadline - Date.now() - 30),
        );
      }),
  );
  const code = `const worker=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(file)},String(worker.pid));console.log('owned child stdout');console.error('owned child stderr');worker.unref();`;
  const operation = runJqTestChild(['-e', code], {
    cwd: dir,
    env: process.env,
    timeout: 400,
  });
  try {
    const result = await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        watchdog = setTimeout(() => resolve(null), 650);
      }),
    ]);
    const worker = Number(readFileSync(file, 'utf8'));
    expect(realKill(worker, 0)).toBe(true);
    expect(
      result,
      'error result must not require external worker cleanup to unblock',
    ).not.toBeNull();
    if (result === null)
      throw new Error('confirmation rejection left held readers open');
    expect(result.error?.message).toBe('owned confirmation deadline failure');
    expect(result.stdout).toContain('owned child stdout');
    expect(result.stderr).toContain('owned child stderr');
  } finally {
    clearTimeout(watchdog);
    signal.mockRestore();
    if (group !== undefined) {
      try {
        realKill(-group, 'SIGKILL');
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
      }
    }
    await operation;
    rmSync(dir, { recursive: true, force: true });
  }
}, 5_000);

// Real process boundaries are required: a successful signal request does not
// imply an exit/close event, and inherited pipes can outlive the direct child.
it.each(['direct child alive', 'exited child with held pipes'])(
  'returns a deadline error before fixture cleanup with %s',
  async (phase) => {
    wait.mockClear();
    const realKill = process.kill.bind(process);
    let child: ChildProcess | undefined;
    let exited = false;
    let requests = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let release!: () => void;
    const confirmation = new Promise<void>((resolve, reject) => {
      release =
        phase === 'direct child alive'
          ? resolve
          : () => reject(new Error('late confirmation failure'));
    });
    wait.mockImplementation(() => confirmation);
    onSpawn.mockImplementationOnce((spawned: ChildProcess) => {
      child = spawned;
      child.once('exit', () => {
        exited = true;
      });
      if (phase === 'direct child alive') {
        const kill = child.kill.bind(child);
        child.kill = (signal) => {
          // Node's timeout can pass numeric 9. Control only this exact child.
          if (signal === 'SIGKILL' || signal === 9) {
            requests++;
            return true;
          }
          return kill(signal);
        };
      }
    });
    const signal = vi
      .spyOn(process, 'kill')
      .mockImplementation((target, kind) => {
        if (
          child?.pid !== undefined &&
          target === -child.pid &&
          kind === 'SIGKILL'
        )
          return true;
        return realKill(target, kind);
      });
    const code =
      phase === 'direct child alive'
        ? "console.log('direct stdout');console.error('direct stderr');setInterval(()=>{},1000)"
        : "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}).unref();console.log('direct stdout');console.error('direct stderr')";
    const start = Date.now();
    const operation = runJqTestChild(['-e', code], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 400,
    });
    try {
      const result = await Promise.race([
        operation,
        new Promise<null>((resolve) => {
          watchdog = setTimeout(() => resolve(null), 650);
        }),
      ]);
      expect(exited).toBe(phase !== 'direct child alive');
      if (phase === 'direct child alive') {
        expect(requests).toBeGreaterThanOrEqual(1);
        if (child?.pid === undefined)
          throw new Error('owned child did not spawn');
        expect(realKill(child.pid, 0)).toBe(true);
        expect(wait).not.toHaveBeenCalled();
      }
      expect(
        result,
        'deadline verdict must precede forced fixture cleanup',
      ).not.toBeNull();
      if (!result) throw new Error('helper exceeded its total deadline');
      expect(Date.now() - start).toBeLessThan(600);
      expect(result.error?.message).toMatch(/deadline/);
      expect(result.stdout).toContain('direct stdout');
      expect(result.stderr).toContain('direct stderr');
      if (phase === 'direct child alive') expect(result.status).toBeNull();
    } finally {
      clearTimeout(watchdog);
      signal.mockRestore();
      if (child?.pid !== undefined) {
        try {
          realKill(-child.pid, 'SIGKILL');
        } catch (error) {
          expect(error).toMatchObject({ code: 'ESRCH' });
        }
      }
      release?.();
      await operation;
    }
  },
  5_000,
);

it.each([0, 7])(
  'preserves natural child status %s and diagnostics',
  async (status) => {
    wait.mockResolvedValue(undefined);
    const result = await runJqTestChild(
      ['-e', `console.log('natural diagnostic');process.exitCode=${status}`],
      { cwd: process.cwd(), env: process.env, timeout: 1_000 },
    );
    expect(result.status).toBe(status);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('natural diagnostic');
  },
);

it('retains spawn failure without waiting for the deadline', async () => {
  const result = await runJqTestChild(['-e', ''], {
    cwd: '/nonexistent/agentmonitors-fixture-directory',
    env: process.env,
    timeout: 1_000,
  });
  expect(result.error).toMatchObject({ code: 'ENOENT' });
});

/** Probe stdin has no payload contract; authored reduction input must be delivered. */
import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jqAvailable, runJqCommand } from './run-jq-command.mjs';

interface IOwnedCommand {
  child: ChildProcess;
  closed: Promise<void>;
}
interface ITransportControl {
  rejectPayload: boolean;
  payloadWrites: number;
  holdCallback: boolean;
  releaseCallback: (() => void) | undefined;
  owned: IOwnedCommand[];
}
const transport = vi.hoisted<ITransportControl>(() => ({
  rejectPayload: false,
  payloadWrites: 0,
  holdCallback: false,
  releaseCallback: undefined,
  owned: [],
}));
// Keep imported driver timers on the test's clock; real executable I/O stays
// real. Without this seam, fake global time cannot advance node:timers bindings.
vi.mock('node:timers', () => ({
  setTimeout: (callback: () => void, ms: number) =>
    globalThis.setTimeout(callback, ms),
  clearTimeout: (timer: ReturnType<typeof setTimeout> | undefined) =>
    globalThis.clearTimeout(timer),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile(
      file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) {
      // Keep the actual host executable and result. Only the owned stdin transport
      // is controlled, so this fixture cannot manufacture positive jq evidence.
      expect(file).toBe('jq');
      const child = actual.execFile(
        file,
        args,
        options,
        (error, stdout, stderr) => {
          if (transport.holdCallback)
            transport.releaseCallback = () => callback(error, stdout, stderr);
          else callback(error, stdout, stderr);
        },
      );
      const closed = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      transport.owned.push({ child, closed });
      const stdin = child.stdin;
      if (transport.rejectPayload && stdin) {
        const end = stdin.end.bind(stdin);
        Object.defineProperty(stdin, 'end', {
          value: (chunk?: string | Buffer) => {
            if (chunk !== undefined) {
              transport.payloadWrites++;
              stdin.emit(
                'error',
                Object.assign(new Error('controlled write EPIPE'), {
                  code: 'EPIPE',
                  syscall: 'write',
                }),
              );
              return stdin;
            }
            return end();
          },
        });
      }
      return child;
    },
  };
});

// Locate the optional facility without executing a discovery-time probe under
// test. CI must still run/fail these cases if its required jq is absent.
const jqOnPath = (process.env.PATH ?? '').split(delimiter).some((dir) => {
  const file = join(dir, 'jq');
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
});

beforeEach(() => {
  transport.rejectPayload = false;
  transport.payloadWrites = 0;
  transport.holdCallback = false;
  transport.releaseCallback = undefined;
  transport.owned = [];
});
afterEach(async () => {
  for (const { child, closed } of transport.owned) {
    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
      }
    }
    await closed;
  }
  vi.restoreAllMocks();
});

describe.skipIf(!jqOnPath && !process.env.CI)(
  'real jq stdin transport (requires jq)',
  () => {
    it('accepts a no-input version probe without attempting a payload write', async () => {
      transport.rejectPayload = true;
      const result = await runJqCommand(['--version']);
      expect(result.stdout).toMatch(/^jq-/);
      expect(transport.payloadWrites).toBe(0);
    });

    it('reports real jq available when unused stdin rejects payload writes', async () => {
      transport.rejectPayload = true;
      await expect(jqAvailable()).resolves.toBe(true);
      expect(transport.payloadWrites).toBe(0);
    });

    it.each(['{"fixture":true}\n', ''])(
      'rejects a delivery EPIPE for explicitly supplied input %j',
      async (input) => {
        transport.rejectPayload = true;
        // -n can otherwise exit successfully without reading stdin. Its success
        // cannot override a delivery failure for input the caller explicitly supplied.
        await expect(runJqCommand(['-n', '[]'], input)).rejects.toMatchObject({
          code: 'EPIPE',
        });
        expect(transport.payloadWrites).toBe(1);
      },
    );

    it('enforces the exact 1000ms verdict budget before a late real-jq callback', async () => {
      // Keep real executable/lifecycle evidence while delaying only its callback.
      // Fake time proves the command budget independently of Vitest teardown.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(1_000);
      transport.holdCallback = true;
      let settled = false;
      const operation = runJqCommand(['--version']).then(
        () => {
          settled = true;
          return 'success';
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        const owned = transport.owned[0];
        if (!owned) throw new Error('real jq did not spawn');
        await owned.closed;
        expect(transport.releaseCallback).toBeTypeOf('function');
        await vi.advanceTimersByTimeAsync(999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(
          settled,
          'the existing command budget must settle at 1000ms',
        ).toBe(true);
        const result = await operation;
        expect(result).toBeInstanceOf(Error);
        if (!(result instanceof Error))
          throw new Error('late callback became success');
        expect(result.message).toMatch(/jq command deadline expired/);
      } finally {
        transport.releaseCallback?.();
        await operation;
        vi.useRealTimers();
      }
    });

    it('retains a natural nonzero no-input command result', async () => {
      await expect(runJqCommand(['-n', '-e', 'false'])).rejects.toMatchObject({
        code: 1,
      });
    });

    it('still delivers authored input to the actual filter', async () => {
      const result = await runJqCommand(
        ['-c', '.fixture'],
        '{"fixture":{"answer":42}}\n',
      );
      expect(JSON.parse(result.stdout)).toEqual({ answer: 42 });
    });
  },
);

/** The interpreter is an optional, bounded process boundary, never an ownership fallback. */
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  readDarwinCommandMarks,
  withDarwinCommandMarkReader,
} from './darwin-command-marks.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Simulate only our helper's pipe protocol; no inspected PID or OS signal is real. */
function helper(
  reply: (pids: number[]) => unknown = (pids) =>
    pids.map((pid) => [pid, null, false]),
) {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const requests: number[][] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const pids: number[] = JSON.parse(chunk.toString());
      requests.push(pids);
      queueMicrotask(() => stdout.write(`${JSON.stringify(reply(pids))}\n`));
      done();
    },
  });
  Object.defineProperties(child, {
    pid: { value: 4242 },
    stdin: { value: stdin, configurable: true },
    stdout: { value: stdout },
  });
  vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(child);
  return { child, requests };
}

it('uses one stock system interpreter for discovery batches and fresh signal-time requests', async () => {
  const { child, requests } = helper((pids) =>
    pids.map((pid) => [pid, pid === 4242 ? 'life' : null, pid === 4243]),
  );
  await withDarwinCommandMarkReader(async () => {
    const pids = Array.from({ length: 4097 }, (_, i) => 4242 + i);
    const result = await readDarwinCommandMarks(pids);
    expect(result.supported && [...result.marks]).toEqual([[4242, 'life']]);
    expect(result.supported && result.unreadable).toEqual([4243]);
    await readDarwinCommandMarks([4242]);
    expect(requests).toEqual([pids, [4242]]);
    expect(child.kill).not.toHaveBeenCalled();
  });
  expect(spawn).toHaveBeenCalledExactlyOnceWith(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', expect.any(String)],
    expect.any(Object),
  );
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('does not give the reader an inherited command ownership mark', async () => {
  vi.stubEnv('AGENTMONITORS_COMMAND_LIFE', 'previous-life');
  helper();
  await readDarwinCommandMarks([4242]);
  const options = vi.mocked(spawn).mock.calls[0]?.[2];
  expect(options?.env).toBeDefined();
  expect(options?.env?.['AGENTMONITORS_COMMAND_LIFE']).toBeUndefined();
  vi.unstubAllEnvs();
});

it('never sends helper cleanup through an already reaped child handle', async () => {
  const { child } = helper();
  await withDarwinCommandMarkReader(async () => {
    await readDarwinCommandMarks([4242]);
    child.exitCode = 0;
  });
  expect(child.kill).not.toHaveBeenCalled();
});

it.each(
  [
    [
      [4242, null, false],
      [4242, null, false],
    ],
    [[9999, 'life', false]],
    [],
    [[4242, 42, false]],
  ].map((rows) => ({ rows })),
)(
  'fails closed on incomplete, duplicate, foreign or malformed evidence: $rows',
  async ({ rows }) => {
    helper(() => rows);
    const result = await readDarwinCommandMarks([4242]);
    expect(result).toEqual({
      supported: false,
      reason: expect.stringMatching(/invalid evidence/),
    });
  },
);

it('withholds ownership if the helper cannot start', async () => {
  const { child } = helper();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() =>
      child.emit(
        'error',
        Object.assign(new Error('unavailable'), { code: 'ENOENT' }),
      ),
    );
    return child;
  });
  const result = await readDarwinCommandMarks([4242]);
  expect(result).toEqual({
    supported: false,
    reason: expect.stringMatching(/could not start.*ENOENT/),
  });
});

it('bounds a silent helper and retains unavailability rather than relaunching it', async () => {
  vi.useFakeTimers();
  const { child } = helper();
  Object.defineProperty(child, 'stdin', {
    value: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });
  const operation = withDarwinCommandMarkReader(async () => {
    const first = await readDarwinCommandMarks([4242]);
    expect(first).toEqual({
      supported: false,
      reason: expect.stringMatching(/timed out/),
    });
    expect((await readDarwinCommandMarks([4243])).supported).toBe(false);
  });
  const settled = operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(await settled).toBeUndefined();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('serializes concurrent requests without losing a reply or launching extra helpers', async () => {
  const { requests } = helper();
  await withDarwinCommandMarkReader(async () => {
    const results = await Promise.all([
      readDarwinCommandMarks([4242]),
      readDarwinCommandMarks([4243]),
    ]);
    expect(results.every((result) => result.supported)).toBe(true);
  });
  expect(requests).toEqual([[4242], [4243]]);
  expect(spawn).toHaveBeenCalledTimes(1);
});

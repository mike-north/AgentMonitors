/**
 * Regression tests for the stale-descriptor double close behind the intermittent
 * `spawn EBADF`, `write EBADF` and `write ECANCELED` failures in
 * `hook-deliver-commit-ordering.test.ts` (issues #506 and #548).
 *
 * The old setup called `closeSync(fd)` and then gave that number to a
 * `WriteStream`, whose `destroy()` closed it again on the thread pool. These
 * tests pin the two properties that make that impossible, deterministically,
 * rather than trying to win the thread-pool race.
 *
 * @see https://github.com/nodejs/node/issues/35862 raw-fd streams and fd reuse
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/functions/write.html EBADF for a fd not open for writing
 */
import fs, { fstatSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUnwritableFileStream } from './unwritable-file-stream.test-support.js';

/**
 * Writes to the stream and resolves with what each failure signal reported, once
 * the write callback has run and the paired 'error' event has fired.
 */
async function failWrite(
  stream: NodeJS.WritableStream,
): Promise<(Error | null | undefined)[]> {
  const errorEvent = new Promise<Error>((resolve) => {
    stream.once('error', resolve);
  });
  const writeCallback = new Promise<Error | null | undefined>((resolve) => {
    stream.write('hello', resolve);
  });
  return Promise.all([writeCallback, errorEvent]);
}

describe('openUnwritableFileStream (stale-descriptor double close, issue #548)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails the write with EBADF while the descriptor stays allocated, so its number cannot be reused', async () => {
    const { stream, fd, dispose } = openUnwritableFileStream();
    try {
      const errors = await failWrite(stream);
      expect(
        errors.map((error) => (error as NodeJS.ErrnoException | null)?.code),
      ).toEqual(['EBADF', 'EBADF']);

      // A number already closed at this point could be handed to the next
      // spawn or open before the stream closes it again.
      expect(() => fstatSync(fd)).not.toThrow();
    } finally {
      await dispose();
    }
  });

  it('dispose closes the descriptor exactly once, successfully, before it resolves', async () => {
    // A second close of the number reports EBADF, or succeeds against whatever
    // reused it; recording the results catches the former deterministically.
    const closeResults: (NodeJS.ErrnoException | null)[] = [];
    const realClose = fs.close;
    vi.spyOn(fs, 'close').mockImplementation(((
      fd: number,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      realClose(fd, (error) => {
        closeResults.push(error);
        callback(error);
      });
    }) as typeof fs.close);

    const { stream, dispose } = openUnwritableFileStream();
    try {
      await failWrite(stream);
    } finally {
      await dispose();
    }

    expect(closeResults).toEqual([null]);
  });
});

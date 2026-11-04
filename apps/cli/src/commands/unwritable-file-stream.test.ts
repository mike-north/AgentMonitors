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

/** Resolves once the stream has both failed the write and emitted its paired 'error' event. */
function failWrite(stream: NodeJS.WritableStream): Promise<Error[]> {
  return new Promise((resolve) => {
    const errors: Error[] = [];
    stream.once('error', (error) => {
      errors.push(error);
      resolve(errors);
    });
    stream.write('hello', (error) => {
      if (error) errors.push(error);
    });
  });
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
        errors.map((error) => (error as NodeJS.ErrnoException).code),
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
    await failWrite(stream);
    await dispose();

    expect(closeResults).toEqual([null]);
  });
});

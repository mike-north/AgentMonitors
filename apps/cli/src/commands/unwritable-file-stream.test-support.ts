/**
 * Test support: a real `fs.WriteStream` whose writes genuinely fail.
 *
 * Tests of `writeStreamChunk` need an actual Node `Writable` that pairs a write
 * callback error with a later `'error'` event, which single-signal fakes cannot
 * reproduce.
 *
 * The descriptor stays open for the stream's whole life, opened read-only so
 * that `write(2)` fails with EBADF. It must never be closed before being handed
 * to the stream: a `WriteStream` closes its fd on `destroy()` even with
 * `autoClose: false`, through the libuv thread pool, so a number closed earlier
 * would be closed a second time at an arbitrary moment. By then the process may
 * have handed that number to something else, such as the socketpair of the next
 * `spawn()`, which then fails with `spawn EBADF` or loses its stdin. Holding the
 * fd open keeps the number from being reused until the stream's single close.
 */
import {
  createWriteStream,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A write-failing stream and the means to tear it down.
 *
 * @internal
 */
export interface UnwritableFileStream {
  /** Fails every write with EBADF, as both a callback error and an `'error'` event. */
  stream: WriteStream;
  /** The open read-only descriptor the stream owns and closes exactly once. */
  fd: number;
  /**
   * Destroys the stream and resolves after its close has finished, so that no
   * close is still queued when the next test starts. Removes the temp directory.
   */
  dispose: () => Promise<void>;
}

/**
 * Opens a new temp file read-only and wraps the descriptor in a `WriteStream`.
 *
 * @internal
 */
export function openUnwritableFileStream(): UnwritableFileStream {
  const dir = mkdtempSync(join(tmpdir(), 'am-unwritable-file-stream-'));
  const target = join(dir, 'target.txt');
  writeFileSync(target, '');
  const fd = openSync(target, 'r');
  const stream = createWriteStream('', { fd, autoClose: false });

  return {
    stream,
    fd,
    dispose: async () => {
      const closed = new Promise<void>((resolve) => {
        stream.once('close', () => {
          resolve();
        });
      });
      stream.destroy();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

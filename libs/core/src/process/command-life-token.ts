/**
 * A journal-owned vnode ties restricted macOS work to one daemon life. Files
 * outlive their admitting daemon; only committed tuples are ownership evidence.
 * Creation belongs to once-per-life durable admission; per-command opens belong
 * to the disposable asynchronous launcher.
 */
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ensurePrivateDir } from '../security/local-permissions.js';

/** Exact regular-file identity inherited by commands of one durable life. @public */
export interface CommandLifeToken {
  /** Journaled daemon-life nonce; an orphaned file alone grants no authority. */
  readonly life: string;
  /** Canonical pathname reserved until the journal safely retires this life. */
  readonly path: string;
  /** Unsigned native device value, encoded exactly as decimal text. */
  readonly device: string;
  /** Native vnode serial number, kept exact beyond JavaScript's safe integer range. */
  readonly inode: string;
}

/** Reject malformed stored tuples before any per-PID native query uses them. @internal */
export const commandLifeTokenSchema = z.object({
  life: z.uuid(),
  path: z.string().startsWith('/').max(1023),
  device: z
    .string()
    .max(10)
    .refine(
      (value) =>
        /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 0xffffffffn,
    ),
  inode: z
    .string()
    .max(20)
    .refine(
      (value) =>
        /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 0xffffffffffffffffn,
    ),
});

/** Pin the file and directory before the FULL-sync row can authorize spawn. @internal */
export function createCommandLifeToken(
  directory: string,
  life: string,
): CommandLifeToken {
  ensurePrivateDir(directory);
  const container = lstatSync(directory);
  if (
    !container.isDirectory() ||
    container.uid !== process.getuid?.() ||
    (container.mode & 0o077) !== 0
  )
    throw new Error(
      'Command life token directory must be owner-only and not a symlink',
    );
  syncDirectory(path.dirname(directory));
  const filename = path.join(realpathSync(directory), `${life}.token`);
  const fd = openSync(
    filename,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_RDWR,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile())
      throw new Error('Command life token is not a regular file');
    fsyncSync(fd);
    syncDirectory(directory);
    return {
      life,
      path: filename,
      device: String(stat.dev),
      inode: String(stat.ino),
    };
  } finally {
    closeSync(fd);
  }
}

/** Missing, replaced or symlinked tokens cannot justify an old life's ownership. @internal */
export async function commandLifeTokenPresent(
  token: CommandLifeToken,
): Promise<boolean> {
  try {
    const stat = await lstat(token.path, { bigint: true });
    return (
      stat.isFile() &&
      String(stat.dev) === token.device &&
      String(stat.ino) === token.inode &&
      (await realpath(token.path)) === token.path
    );
  } catch {
    return false;
  }
}

/** Remove only the exact safely retired file after the caller revokes its journal authority. @internal */
export function retireCommandLifeToken(token: CommandLifeToken): void {
  try {
    const stat = lstatSync(token.path, { bigint: true });
    if (
      stat.isFile() &&
      String(stat.dev) === token.device &&
      String(stat.ino) === token.inode
    ) {
      unlinkSync(token.path);
      syncDirectory(path.dirname(token.path));
    }
  } catch {
    // Failed file cleanup can leak an unjournaled token, never signal authority.
  }
}

/** Persist a pathname reservation before any row can refer to its vnode. */
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

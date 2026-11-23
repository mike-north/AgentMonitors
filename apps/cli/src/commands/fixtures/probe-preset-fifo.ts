/**
 * Owned, bounded fixture for EOF ownership: the writer closes stderr but stays
 * alive, so the reader must complete before the command process exits. This
 * tests FIFO descriptor lifetime independently of source health notifications.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

/** Exercise the actual shell program in a dedicated owned group. @internal */
export async function probePresetFifo(
  directory: string,
  commandProgram: string,
  shell = 'sh',
): Promise<{
  wrapperFifoWriters: number | undefined;
  writtenBytes: number;
  totalBytes: number | undefined;
  tailBytes: number | undefined;
  completedWhileCommandAlive: boolean;
}> {
  const tail = path.join(directory, 'stderr');
  const total = path.join(directory, 'total');
  const written = path.join(directory, 'written');
  const ready = path.join(directory, 'ready');
  const producer = `process.stderr.write(Buffer.alloc(4097, 'x'), () => require('node:fs').writeFileSync(process.env.AM_FIFO_WRITTEN, '4097'));`;
  const writer =
    '"$AM475_NODE" -e "$1"; exec 2>/dev/null; while [ ! -f "$AM475_TOTAL" ]; do sleep 0.01; done; printf ready >"$AM_FIFO_READY"; sleep 60';
  const child = spawn(
    shell,
    [
      '-c',
      commandProgram,
      'capture-probe',
      shell,
      '-c',
      writer,
      'writer',
      producer,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        AM475_NODE: process.execPath,
        AM475_READER: path.join(
          import.meta.dirname,
          'capture-preset-stderr.ts',
        ),
        AM475_STDERR: tail,
        AM475_TOTAL: total,
        AM475_EXIT: path.join(directory, 'exit'),
        AM_FIFO_WRITTEN: written,
        AM_FIFO_READY: ready,
      },
    },
  );
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => {
      resolve();
    });
    child.once('error', reject);
  });
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    let wrapperFifoWriters: number | undefined;
    if (process.platform === 'linux' && child.pid) {
      const fds = `/proc/${String(child.pid)}/fd`;
      wrapperFifoWriters = readdirSync(fds).filter((fd) => {
        if (readlinkSync(path.join(fds, fd)) !== `${tail}.pipe`) return false;
        const flags = /flags:\s*([0-7]+)/.exec(
          readFileSync(`/proc/${String(child.pid)}/fdinfo/${fd}`, 'utf8'),
        )?.[1];
        return flags !== undefined && (Number.parseInt(flags, 8) & 3) !== 0;
      }).length;
    }
    return {
      wrapperFifoWriters,
      writtenBytes: existsSync(written)
        ? Number(readFileSync(written, 'utf8'))
        : 0,
      totalBytes: existsSync(total)
        ? Number(readFileSync(total, 'utf8'))
        : undefined,
      tailBytes: existsSync(tail) ? statSync(tail).size : undefined,
      completedWhileCommandAlive: existsSync(ready) && child.exitCode === null,
    };
  } finally {
    if (child.pid) {
      // The detached group was launched by this probe; no process-name cleanup.
      killOwnedProbeGroup(child.pid);
    }
    await closed;
  }
}

/** Only accepts the group leader launched with detached:true by this fixture. */
function killOwnedProbeGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ESRCH'
    )
      throw error;
  }
}

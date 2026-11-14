/** Kernel ownership evidence must never confuse diagnostic arguments with envp. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { readCommandMarks } from './command-process-marks.js';
import { CommandProcessJournal } from './command-process-journal.js';

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

it.skipIf(process.platform !== 'darwin').each([false, true])(
  'reads only envp with Homebrew absent and abstains on empty argv (%s)',
  async (emptyArgument) => {
    const nonce = '00000000-0000-4000-8000-000000000618';
    const pids: number[] = [];
    for (const marked of [false, true]) {
      const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
      delete env['AGENTMONITORS_COMMAND_LIFE'];
      if (marked) env['AGENTMONITORS_COMMAND_LIFE'] = nonce;
      const child = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(()=>{},1000);process.send("ready")',
          ...(emptyArgument ? [''] : []),
          `AGENTMONITORS_COMMAND_LIFE=${nonce}`,
        ],
        {
          cwd: process.env.TMPDIR,
          env,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      children.push(child);
      await once(child, 'message');
      if (child.pid === undefined) throw new Error('Missing owned fixture PID');
      pids.push(child.pid);
    }
    const original = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    try {
      const reading = await readCommandMarks(pids);
      expect(reading.supported).toBe(true);
      if (!reading.supported) throw new Error(reading.reason);
      expect([...reading.marks]).toEqual(
        emptyArgument ? [] : [[pids[1], nonce]],
      );
      expect(reading.unreadable).toEqual(emptyArgument ? pids : []);
    } finally {
      process.env.PATH = original;
    }
  },
);

it.skipIf(process.platform !== 'darwin').each(['retitled', 'empty-argv0'])(
  'accounts for a real %s marked worker as owned or explicitly unreadable',
  async (layout) => {
    const root = mkdtempSync(path.join(tmpdir(), 'title-'));
    const db = path.join(root, 'db');
    const journal = CommandProcessJournal.open(db, root);
    try {
      const env = await journal.environment();
      const child = spawn(
        process.execPath,
        [
          '-e',
          `${layout === 'retitled' ? 'process.title="worker";' : ''}setInterval(()=>{},1000);process.send("ready")`,
        ],
        {
          cwd: root,
          ...(layout === 'empty-argv0' ? { argv0: '' } : {}),
          detached: true,
          // A skipped empty argv[0] must not consume the ownership entry as argv.
          env: { ...env, ...process.env, ...env },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      children.push(child);
      await once(child, 'message');
      if (child.pid === undefined) throw new Error('Missing owned fixture PID');
      const reading = await readCommandMarks([child.pid]);
      expect(reading.supported).toBe(true);
      if (!reading.supported) throw new Error(reading.reason);
      expect(
        reading.marks.get(child.pid) === env['AGENTMONITORS_COMMAND_LIFE'] ||
          reading.unreadable?.includes(child.pid),
      ).toBe(true);
      // Deliberately omit numeric hints: discovery itself must retain uncertainty
      // rather than silently losing a worker with an ambiguous argv layout.
      const sql = new Database(`${db}.commands.sqlite`);
      try {
        sql.prepare('UPDATE command_lives SET owner=?').run(
          JSON.stringify({
            pid: 2147483647,
            pgid: 2147483647,
            startTime: 'dead',
          }),
        );
      } finally {
        sql.close();
      }
      const restarted = CommandProcessJournal.open(db, root);
      let receipt;
      try {
        receipt = await restarted.sweep();
      } finally {
        restarted.close();
      }
      expect(receipt.outcomes).toContainEqual(
        expect.objectContaining({
          pid: child.pid,
          ...(reading.marks.has(child.pid)
            ? { status: 'reaped' }
            : {
                status: 'abstained',
                reason: expect.stringMatching(/environment|ownership/i),
              }),
        }),
      );
    } finally {
      journal.close();
    }
  },
);

/** Every executable-path residue must retain ownership through durable restart discovery. */
it.skipIf(process.platform !== 'darwin')(
  'reaps aligned native paths at every residue and abstains on empty argv0',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'align-'));
    const db = path.join(root, 'db');
    const journal = CommandProcessJournal.open(db, root);
    try {
      const life = await journal.environment();
      const ordinary: number[] = [];
      const empty: number[] = [];
      for (let residue = 0; residue < 8; residue++) {
        const executable = path.join(root, 'n' + 'x'.repeat(residue));
        copyFileSync(process.execPath, executable);
        for (const emptyFirst of [false, true]) {
          const child = spawn(
            executable,
            ['-e', 'setInterval(()=>{},1000);process.send("ready")'],
            {
              cwd: root,
              argv0: emptyFirst ? '' : executable,
              detached: true,
              env: { ...life, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            },
          );
          children.push(child);
          await once(child, 'message');
          if (child.pid === undefined)
            throw new Error('Missing aligned fixture PID');
          (emptyFirst ? empty : ordinary).push(child.pid);
        }
      }
      const reading = await readCommandMarks([...ordinary, ...empty]);
      expect(reading.supported).toBe(true);
      if (!reading.supported) throw new Error(reading.reason);
      expect([...reading.marks.keys()].sort()).toEqual([...ordinary].sort());
      expect(reading.unreadable?.sort()).toEqual([...empty].sort());
      const sql = new Database(`${db}.commands.sqlite`);
      try {
        sql.prepare('UPDATE command_lives SET owner=?').run(
          JSON.stringify({
            pid: 2147483647,
            pgid: 2147483647,
            startTime: 'dead',
          }),
        );
      } finally {
        sql.close();
      }
      const restarted = CommandProcessJournal.open(db, root);
      try {
        const receipt = await restarted.sweep();
        for (const pid of ordinary)
          expect(receipt.outcomes).toContainEqual(
            expect.objectContaining({ pid, status: 'reaped' }),
          );
        for (const pid of empty)
          expect(receipt.outcomes).toContainEqual(
            expect.objectContaining({
              pid,
              status: 'abstained',
              reason: expect.stringMatching(/environment|ownership/i),
            }),
          );
      } finally {
        restarted.close();
      }
    } finally {
      journal.close();
    }
  },
  30_000,
);

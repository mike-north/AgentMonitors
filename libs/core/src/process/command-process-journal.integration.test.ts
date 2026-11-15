/** Real owned pre-watchdog admission: a marked Node and unreadable Apple shell share one group. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CommandProcessJournal } from './command-process-journal.js';
import { readProcessTable } from './process-table.js';
import {
  readCommandMarks,
  readCommandTerminal,
} from './command-process-marks.js';
import { sendVerifiedSignal } from './process-identity.js';

it.skipIf(process.platform !== 'darwin')(
  'reaps a real verified pre-watchdog command despite its unreadable shell child',
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'am-old-'));
    const db = path.join(dir, 'inbox.db');
    const admission = CommandProcessJournal.open(db, dir);
    let journal: CommandProcessJournal | undefined;
    const env = await admission.environment();
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    const sh = require('node:child_process').spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do /bin/sleep 1; done'], {stdio:'ignore'});
    process.send({shell: sh.pid});
    setInterval(()=>{},1000);
  `,
      ],
      {
        cwd: dir,
        env: { ...process.env, ...env },
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    if (!child.pid) throw new Error('Missing fixture pid');
    const group = child.pid;
    /** Teardown signals only freshly identified members of this exclusively owned fixture. */
    async function cleanup(): Promise<void> {
      // Keep the direct child unreaped while identifying its exclusively owned group.
      // Only positive per-process targets are used, never a negative group identifier.
      for (let pass = 0; pass < 2; pass++) {
        const reading = await readProcessTable();
        if (!reading.supported) throw new Error(reading.reason);
        const members = reading.processes.filter(
          (p) => p.pgid === group && p.pid !== group,
        );
        for (const record of members)
          await sendVerifiedSignal(
            { kind: 'recorded-process', record },
            'SIGKILL',
            { action: 'owned no-watchdog fixture teardown' },
          );
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      journal?.close();
      admission.close();
      const remaining = await readProcessTable();
      if (!remaining.supported) throw new Error(remaining.reason);
      for (const record of remaining.processes.filter(
        (p) => p.pgid === group,
      )) {
        expect(await readCommandTerminal(record)).toBe('terminated');
      }
    }
    try {
      const [{ shell }] = await once(child, 'message');
      admission.spawned(group);
      const sql = new Database(`${db}.commands.sqlite`);
      sql.prepare('UPDATE command_lives SET owner = ?').run(
        JSON.stringify({
          pid: 2147483647,
          pgid: 2147483647,
          startTime: 'dead',
        }),
      );
      sql.close();
      const marks = await readCommandMarks([group, shell]);
      if (!marks.supported) throw new Error(marks.reason);
      expect(marks.marks.get(group)).toBe(env.AGENTMONITORS_COMMAND_LIFE);
      expect(marks.unreadable).toContain(shell);
      journal = CommandProcessJournal.open(db, dir);
      const result = await journal.sweep();
      console.log(
        'REAL_NO_WATCHDOG',
        JSON.stringify({
          group,
          shell,
          outcomes: result.outcomes.filter(
            (outcome) => outcome.pid === group || outcome.pid === shell,
          ),
        }),
      );
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ pid: group, status: 'reaped' }),
      );
    } finally {
      await cleanup();
    }
  },
  15000,
);

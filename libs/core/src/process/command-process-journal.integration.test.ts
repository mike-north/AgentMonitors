/** Real owned pre-watchdog admission: a marked Node and unreadable Apple shell share one group. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CommandProcessJournal } from './command-process-journal.js';
import {
  readProcessTable,
  type ProcessIdentityRecord,
} from './process-table.js';
import {
  readCommandMarks,
  readCommandTerminal,
} from './command-process-marks.js';
import { sendVerifiedSignal } from './process-identity.js';

/** Only a surviving owned incarnation can establish membership in a numeric group. */
function fixtureCleanupCandidates(
  group: number,
  known: ReadonlyMap<number, ProcessIdentityRecord>,
  current: readonly ProcessIdentityRecord[],
): readonly ProcessIdentityRecord[] {
  const anchored = current.some((record) => {
    const prior = known.get(record.pid);
    return (
      record.pgid === group &&
      prior?.pgid === group &&
      prior.startTime === record.startTime
    );
  });
  // Without an owned anchor, retry only saved identities through their existing
  // per-process gates. A recycled group cannot supply any new cleanup targets.
  if (!anchored) return [...known.values()];
  const candidates = new Map(known);
  for (const record of current) {
    if (record.pgid === group) candidates.set(record.pid, record);
  }
  return [...candidates.values()];
}

it('does not adopt an unrelated fixture group after every known incarnation is gone', () => {
  const old = { pid: 4242, pgid: 4242, startTime: 'owned' };
  const replacement = { ...old, startTime: 'unrelated' };
  const stranger = { pid: 4243, pgid: 4242, startTime: 'unrelated-child' };
  // Original records can only be retried through their own identity gate; the
  // reused numeric group supplies no authority to adopt the replacement tree.
  expect(
    fixtureCleanupCandidates(4242, new Map([[old.pid, old]]), [
      replacement,
      stranger,
    ]),
  ).toEqual([old]);
});

it('discovers late fixture members only while a saved incarnation anchors their group', () => {
  const owner = { pid: 4242, pgid: 4242, startTime: 'owned' };
  const late = { pid: 4243, pgid: 4242, startTime: 'late' };
  const stranger = { pid: 4244, pgid: 9999, startTime: 'unrelated' };
  expect(
    fixtureCleanupCandidates(4242, new Map([[owner.pid, owner]]), [
      owner,
      late,
      stranger,
    ]),
  ).toEqual([owner, late]);
});

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
    const known = new Map<number, ProcessIdentityRecord>();
    /** Teardown signals only freshly identified members of this exclusively owned fixture. */
    async function cleanup(): Promise<void> {
      // An unreaped spawned handle can bootstrap ownership if setup failed before
      // the initial snapshot. After it exits, only saved incarnations can anchor
      // discovery. Every target still passes its own positive identity gate.
      for (let pass = 0; pass < 2; pass++) {
        const reading = await readProcessTable();
        if (!reading.supported) throw new Error(reading.reason);
        if (
          known.size === 0 &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          const parent = reading.processes.find(
            (record) => record.pid === group && record.pgid === group,
          );
          if (parent) known.set(parent.pid, parent);
        }
        const members = fixtureCleanupCandidates(
          group,
          known,
          reading.processes,
        ).filter((record) => record.pid !== group);
        for (const record of members) {
          known.set(record.pid, record);
          await sendVerifiedSignal(
            { kind: 'recorded-process', record },
            'SIGKILL',
            { action: 'owned no-watchdog fixture teardown' },
          );
        }
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
      for (const record of remaining.processes.filter((record) => {
        const prior = known.get(record.pid);
        return (
          prior?.pgid === record.pgid && prior.startTime === record.startTime
        );
      })) {
        expect(await readCommandTerminal(record)).toBe('terminated');
      }
    }
    try {
      const [{ shell }] = await once(child, 'message');
      const owned = await readProcessTable();
      if (!owned.supported) throw new Error(owned.reason);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      for (const record of owned.processes) {
        if (record.pgid === group) known.set(record.pid, record);
      }
      expect(known.has(group)).toBe(true);
      expect(known.has(shell)).toBe(true);
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

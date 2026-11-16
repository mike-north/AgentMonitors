/** Restart-time containment proves both cleanup and the stronger never-wrong-kill boundary. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readProcessTable,
  sendVerifiedSignal,
  type ProcessIdentityRecord,
} from '@agentmonitors/core';
import { waitForOwnedGroupTermination } from '../../../../scripts/owned-test-group.mjs';
import { ownedWorkerTerminated } from '../../../../scripts/owned-worker-terminated.mjs';

const CLI = path.resolve(import.meta.dirname, '../../dist/index.cjs');
let workspace: string;
let db: string;
let monitors: string;
const children: ChildProcess[] = [];
const groups = new Set<number>();
/** Exact fixture identities survive authored exit, including local-server teardown. */
const fixtureMembers: ProcessIdentityRecord[] = [];

/** Dispose the deadline timer whether an owned process exits or an operation fails. */
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every subprocess and orphan is exclusively owned by this test, including on assertion failure. */
afterEach(async () => {
  const anchors = new Set(
    children
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .flatMap((child) => (child.pid === undefined ? [] : [child.pid])),
  );
  const file = path.join(workspace, 'pids.json');
  if (existsSync(file)) {
    const pids: { parent: number; child: number; detached: boolean } =
      JSON.parse(readFileSync(file, 'utf8'));
    for (const pid of [pids.parent, pids.child]) {
      if (!ownedWorkerTerminated(pid)) anchors.add(pid);
    }
    groups.add(pids.parent);
    if (pids.detached) groups.add(pids.child);
  }
  // A completed watchdog may already have ended its group. Capture live,
  // fixture-anchored membership before cleanup, then verify each recorded
  // incarnation at delivery. Never signal a bare, possibly reaped group ID.
  const owned: ProcessIdentityRecord[] = fixtureMembers.splice(0);
  const snapshot = await readProcessTable();
  if (!snapshot.supported) throw new Error(snapshot.reason);
  for (const group of groups) {
    const members = snapshot.processes.filter(
      (member) => member.pgid === group,
    );
    if (members.some((member) => anchors.has(member.pid)))
      owned.push(...members);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await bounded(exited, 'owned child exit');
    }
  }
  for (const record of owned) {
    await sendVerifiedSignal({ kind: 'recorded-process', record }, 'SIGKILL', {
      action: 'owned command fixture teardown',
    });
  }
  for (const group of groups) {
    await waitForOwnedGroupTermination(group, Date.now() + 5_000);
  }
  groups.clear();
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'am-sweep-'));
  db = path.join(workspace, 'inbox.db');
  monitors = path.join(workspace, 'monitors');
  mkdirSync(monitors);
});

/** Read durable diagnostics instead of inferring a successful sweep from daemon readiness. */
function diagnostics():
  | {
      outcomes: {
        status: string;
        pid?: number;
        reason?: string;
        life?: string;
        evidence?: unknown;
      }[];
      status: string;
    }
  | undefined {
  if (!existsSync(`${db}.commands.sqlite`)) return undefined;
  const sql = new Database(`${db}.commands.sqlite`);
  try {
    const row = sql
      .prepare('SELECT result FROM restart_sweeps ORDER BY id DESC LIMIT 1')
      .get();
    if (
      typeof row !== 'object' ||
      row === null ||
      !('result' in row) ||
      typeof row.result !== 'string'
    )
      return undefined;
    return JSON.parse(row.result);
  } finally {
    sql.close();
  }
}

/** Uses the production foreground command, with isolated workspace data and a short OS-temp socket. */
async function start(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      CLI,
      'daemon',
      'run',
      monitors,
      '--workspace',
      workspace,
      '--socket',
      path.join(workspace, 'd.sock'),
      '--poll-ms',
      '50',
      '--reap-after-ms',
      '0',
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        AGENTMONITORS_DB: db,
        XDG_DATA_HOME: path.join(workspace, 'data'),
        HOME: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'config'),
        XDG_STATE_HOME: path.join(workspace, 'state'),
        XDG_CACHE_HOME: path.join(workspace, 'cache'),
        TMPDIR: workspace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  await expect
    .poll(
      () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(output);
        return output.includes('daemon listening');
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return child;
}

/** A real orphan tree; independent sessions either preserve or deliberately erase the inherited mark. */
function monitor(
  mode: 'tree' | 'detached' | 'escaped' | 'group-unmarked',
  timeout = '5m',
  closeStreams = false,
  exitLeader = false,
  inheritLeafStreams = false,
): void {
  const leaf = `
    let armed=false;
    process.on('disconnect',()=>{if(!armed)process.exit(0)});
    process.on('message',()=>{armed=true;process.send('armed');process.disconnect()});
    process.on('SIGTERM',()=>{});
    setInterval(()=>{},1000);process.send('ready');
  `;
  const fixture = `
    const fs=require('node:fs');
    if (${closeStreams}) { process.stdout.destroy(); process.stderr.destroy(); }
    const env={...process.env};
    if (${JSON.stringify(mode)}==='escaped'||${JSON.stringify(mode)}==='group-unmarked') delete env.AGENTMONITORS_COMMAND_LIFE;
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{env,detached:${mode === 'detached' || mode === 'escaped'},stdio:['ignore',${inheritLeafStreams ? "'inherit','inherit'" : "'ignore','ignore'"},'ipc']});
    fs.writeFileSync('pids.json',JSON.stringify({parent:process.pid,child:child.pid,life:process.env.AGENTMONITORS_COMMAND_LIFE,detached:${mode === 'detached' || mode === 'escaped'}}));
    child.on('message',(message)=>{if(message==='ready')child.send('arm');else if(message==='armed'){fs.writeFileSync('ready','ready');if(${exitLeader})process.exit(0)}});
    setInterval(()=>{},1000);
  `;
  const dir = path.join(monitors, 'command');
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    `---\nname: Restart cleanup\nwatch:\n  type: command-poll\n  command: ${JSON.stringify([process.execPath, '-e', fixture])}\n  timeout: ${timeout}\n  interval: 1h\nurgency: normal\n---\nInspect changes.\n`,
  );
}

/** Crash only after process readiness, then disable new work so a restart cannot mask leftovers. */
async function orphan(
  mode: 'tree' | 'detached' | 'escaped' | 'group-unmarked',
): Promise<{ parent: number; child: number; watchdog: number; life: string }> {
  monitor(mode);
  const daemon = await start();
  await expect
    .poll(() => existsSync(path.join(workspace, 'ready')), { timeout: 10_000 })
    .toBe(true);
  const pids: { parent: number; child: number; life: string } = JSON.parse(
    readFileSync(path.join(workspace, 'pids.json'), 'utf8'),
  );
  // Discover the one remaining member of this owned fixture's original group.
  // Authored Node preloads cannot observe or instrument the isolated watchdog.
  const table = await readProcessTable();
  if (!table.supported) throw new Error(table.reason);
  const watchdogs = table.processes.filter(
    (member) =>
      member.pgid === pids.parent &&
      member.pid !== pids.parent &&
      member.pid !== pids.child,
  );
  expect(watchdogs).toHaveLength(1);
  const watchdog = watchdogs[0];
  if (!watchdog) throw new Error('Owned watchdog is missing');
  const exit = once(daemon, 'exit');
  daemon.kill('SIGKILL');
  await bounded(exit, 'owned daemon crash');
  rmSync(path.join(monitors, 'command'), { recursive: true });
  expect(ownedWorkerTerminated(pids.parent)).toBe(false);
  expect(ownedWorkerTerminated(pids.child)).toBe(false);
  return { ...pids, watchdog: watchdog.pid };
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'restart sweep',
  () => {
    it.skipIf(process.platform !== 'darwin')(
      'reaps stock sh and its sleep child using each process own vnode after daemon SIGKILL',
      async () => {
        const dir = path.join(monitors, 'command');
        mkdirSync(dir);
        // A retained shell and a long-lived stock child must both be killed by
        // restart reconciliation, well before their independent lifetime bound.
        writeFileSync(
          path.join(dir, 'MONITOR.md'),
          `---\nname: Shell restart\nwatch:\n  type: command-poll\n  command: ${JSON.stringify(['/bin/sh', '-c', 'echo $$ > shell.pid; /bin/sleep 300 & echo $! > child.pid; wait'])}\n  timeout: 5m\n  interval: 1h\nurgency: normal\n---\nInspect changes.\n`,
        );
        const daemon = await start();
        await expect
          .poll(() => existsSync(path.join(workspace, 'child.pid')), {
            timeout: 5000,
          })
          .toBe(true);
        const command = Number(
          readFileSync(path.join(workspace, 'shell.pid'), 'utf8').trim(),
        );
        const child = Number(
          readFileSync(path.join(workspace, 'child.pid'), 'utf8').trim(),
        );
        groups.add(command);
        writeFileSync(
          path.join(workspace, 'pids.json'),
          JSON.stringify({ parent: command, child, detached: false }),
        );
        const exit = once(daemon, 'exit');
        daemon.kill('SIGKILL');
        await bounded(exit, 'owned daemon crash');
        rmSync(dir, { recursive: true });
        expect(ownedWorkerTerminated(command)).toBe(false);
        expect(ownedWorkerTerminated(child)).toBe(false);
        await start();
        for (const pid of [command, child]) {
          expect(diagnostics()?.outcomes).toContainEqual(
            expect.objectContaining({
              pid,
              status: 'reaped',
              evidence: expect.objectContaining({ via: 'inherited-vnode' }),
            }),
          );
          expect(ownedWorkerTerminated(pid)).toBe(true);
        }
        await waitForOwnedGroupTermination(command, Date.now() + 1000);
      },
      25_000,
    );

    it.skipIf(process.platform !== 'darwin')(
      'reaps stock curl using its own vnode after daemon SIGKILL',
      async () => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
        server.listen(0, '127.0.0.1');
        await bounded(once(server, 'listening'), 'local curl server');
        try {
          const address = server.address();
          if (address === null || typeof address === 'string')
            throw new Error('Missing local listener');
          const dir = path.join(monitors, 'command');
          mkdirSync(dir);
          writeFileSync(
            path.join(dir, 'MONITOR.md'),
            `---\nname: Curl restart\nwatch:\n  type: command-poll\n  command: ${JSON.stringify(['/usr/bin/curl', '--silent', '--max-time', '300', `http://127.0.0.1:${address.port}/`])}\n  timeout: 5m\n  interval: 1h\nurgency: normal\n---\nInspect changes.\n`,
          );
          const daemon = await start();
          await expect.poll(() => sockets.size, { timeout: 5000 }).toBe(1);
          const sql = new Database(`${db}.commands.sqlite`);
          let command: number;
          try {
            const row = sql.prepare('SELECT pid FROM command_pids').get();
            if (
              typeof row !== 'object' ||
              row === null ||
              !('pid' in row) ||
              typeof row.pid !== 'number'
            )
              throw new Error('Missing curl suspicion');
            command = row.pid;
          } finally {
            sql.close();
          }
          groups.add(command);
          const table = await readProcessTable();
          if (!table.supported) throw new Error(table.reason);
          // The live, unreaped curl pins its original group while we capture
          // the bound. Saved incarnations, never bare group IDs, authorize cleanup.
          fixtureMembers.push(
            ...table.processes.filter((member) => member.pgid === command),
          );
          writeFileSync(
            path.join(workspace, 'pids.json'),
            JSON.stringify({
              parent: command,
              child: command,
              detached: false,
            }),
          );
          const exit = once(daemon, 'exit');
          daemon.kill('SIGKILL');
          await bounded(exit, 'owned daemon crash');
          rmSync(dir, { recursive: true });
          expect(ownedWorkerTerminated(command)).toBe(false);
          await start();
          expect(diagnostics()?.outcomes).toContainEqual(
            expect.objectContaining({
              pid: command,
              status: 'reaped',
              evidence: expect.objectContaining({ via: 'inherited-vnode' }),
            }),
          );
          expect(ownedWorkerTerminated(command)).toBe(true);
          await waitForOwnedGroupTermination(command, Date.now() + 1000);
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
      25_000,
    );

    it.skipIf(process.platform !== 'darwin')(
      'preserves a stock shell watchdog when committed vnode metadata is unavailable',

      async () => {
        const dir = path.join(monitors, 'command');
        mkdirSync(dir);
        // Stock Apple sh hides envp. Shell builtins keep the original command
        // alive, and ignoring TERM exercises the watchdog's full kill grace.
        writeFileSync(
          path.join(dir, 'MONITOR.md'),
          `---\nname: Shell bound\nwatch:\n  type: command-poll\n  command: ${JSON.stringify(['/bin/sh', '-c', 'trap "" TERM; echo $$ > shell.pid; while :; do /bin/sleep 1; done'])}\n  timeout: 10s\n  interval: 1h\nurgency: normal\n---\nInspect changes.\n`,
        );
        const admittedAt = Date.now();
        const daemon = await start();
        await expect
          .poll(() => existsSync(path.join(workspace, 'shell.pid')), {
            timeout: 5000,
          })
          .toBe(true);
        const command = Number(
          readFileSync(path.join(workspace, 'shell.pid'), 'utf8').trim(),
        );
        groups.add(command);
        writeFileSync(
          path.join(workspace, 'pids.json'),
          JSON.stringify({ parent: command, child: command, detached: false }),
        );
        const table = await readProcessTable();
        if (!table.supported) throw new Error(table.reason);
        // sleep is an authored child; the remaining Node process is the bound.
        const members = table.processes.filter(
          (member) => member.pgid === command && member.pid !== command,
        );
        // Identify the Node companion by its readable inherited life mark.
        const { readCommandMarks } =
          await import('../../../../libs/core/src/process/command-process-marks.js');
        const marks = await readCommandMarks([
          command,
          ...members.map((member) => member.pid),
        ]);
        if (!marks.supported) throw new Error(marks.reason);
        expect(marks.unreadable).toContain(command);
        const bound = members.find((member) => marks.marks.has(member.pid));
        if (!bound) throw new Error('Missing readable watchdog');
        const exited = once(daemon, 'exit');
        daemon.kill('SIGKILL');
        await bounded(exited, 'owned daemon crash');
        rmSync(dir, { recursive: true });
        expect(ownedWorkerTerminated(command)).toBe(false);
        // A legacy or incomplete life row cannot authorize fallback proof, even
        // while its command still holds the exact token's inherited descriptor.
        const sql = new Database(`${db}.commands.sqlite`);
        try {
          sql.prepare('UPDATE command_lives SET vnode = NULL').run();
        } finally {
          sql.close();
        }
        await start();
        const outcomes = diagnostics()?.outcomes.filter(
          (outcome) => outcome.pid === command || outcome.pid === bound.pid,
        );
        expect(outcomes).toContainEqual(
          expect.objectContaining({
            pid: command,
            status: 'abstained',
            reason: expect.stringMatching(/unreadable/i),
          }),
        );
        expect(outcomes).toContainEqual(
          expect.objectContaining({
            pid: bound.pid,
            status: 'abstained',
            reason: expect.stringMatching(/group.*bound/i),
          }),
        );
        expect(ownedWorkerTerminated(bound.pid)).toBe(false);
        expect(ownedWorkerTerminated(command)).toBe(false);
        // Admission, timeout, fixed grace and a small scheduling margin share
        // one absolute test deadline; restart latency cannot extend this wait.
        await waitForOwnedGroupTermination(command, admittedAt + 17_000);
        expect(ownedWorkerTerminated(command)).toBe(true);
        expect(ownedWorkerTerminated(bound.pid)).toBe(true);
      },
      25_000,
    );

    // Deadline enforcement must survive loss of the daemon and of inherited stdio.
    for (const closeStreams of [false, true]) {
      it(`bounds a real command group after SIGKILL (closed stdio: ${String(closeStreams)})`, async () => {
        monitor('tree', '1s', closeStreams);
        const daemon = await start();
        await expect
          .poll(() => existsSync(path.join(workspace, 'ready')), {
            timeout: 5_000,
          })
          .toBe(true);
        const pids: { parent: number; child: number; life: string } =
          JSON.parse(readFileSync(path.join(workspace, 'pids.json'), 'utf8'));
        const exit = once(daemon, 'exit');
        daemon.kill('SIGKILL');
        await bounded(exit, 'owned daemon crash');
        expect(daemon.signalCode).toBe('SIGKILL');
        // The timeout starts before readiness; the grace is the production 5 seconds.
        await waitForOwnedGroupTermination(pids.parent, Date.now() + 6_000);
        expect(ownedWorkerTerminated(pids.parent)).toBe(true);
        expect(ownedWorkerTerminated(pids.child)).toBe(true);
      }, 15_000);
    }

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      it(`ends in-flight command groups before graceful ${signal} shutdown`, async () => {
        monitor('tree', '30s');
        const daemon = await start();
        await expect
          .poll(() => existsSync(path.join(workspace, 'ready')), {
            timeout: 5_000,
          })
          .toBe(true);
        const pids: { parent: number; child: number; life: string } =
          JSON.parse(readFileSync(path.join(workspace, 'pids.json'), 'utf8'));
        const exit = once(daemon, 'exit');
        daemon.kill(signal);
        await bounded(exit, 'graceful daemon exit');
        expect(ownedWorkerTerminated(pids.parent)).toBe(true);
        expect(ownedWorkerTerminated(pids.child)).toBe(true);
        await waitForOwnedGroupTermination(pids.parent, Date.now() + 1_000);
      }, 15_000);
    }

    it('cleans a still-live group on shutdown after its command leader exits during output capture', async () => {
      monitor('tree', '30s', false, true, true);
      const daemon = await start();
      await expect
        .poll(() => existsSync(path.join(workspace, 'ready')), {
          timeout: 5000,
        })
        .toBe(true);
      const pids: { parent: number; child: number; life: string } = JSON.parse(
        readFileSync(path.join(workspace, 'pids.json'), 'utf8'),
      );
      await expect.poll(() => ownedWorkerTerminated(pids.parent)).toBe(true);
      // Allow the completed observation to settle while its child remains alive.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ownedWorkerTerminated(pids.child)).toBe(false);
      const exit = once(daemon, 'exit');
      daemon.kill('SIGTERM');
      await bounded(exit, 'graceful completed-group cleanup');
      expect(ownedWorkerTerminated(pids.child)).toBe(true);
      await waitForOwnedGroupTermination(pids.parent, Date.now() + 1000);
    }, 15000);

    it('ends background work when a completed observation releases its group', async () => {
      monitor('tree', '30s', true, true);
      await start();
      await expect
        .poll(() => existsSync(path.join(workspace, 'ready')), {
          timeout: 5000,
        })
        .toBe(true);
      const pids: { parent: number; child: number; life: string } = JSON.parse(
        readFileSync(path.join(workspace, 'pids.json'), 'utf8'),
      );
      await waitForOwnedGroupTermination(pids.parent, Date.now() + 3000);
      expect(ownedWorkerTerminated(pids.parent)).toBe(true);
      expect(ownedWorkerTerminated(pids.child)).toBe(true);
    }, 15000);

    for (const mode of ['tree', 'detached', 'group-unmarked'] as const) {
      it(`reconciles a killed daemon's ${mode} command and descendant with honest identity diagnostics`, async () => {
        const pids = await orphan(mode);
        await start();
        await expect
          .poll(
            () =>
              diagnostics()?.outcomes.filter((o) => o.status === 'reaped')
                .length,
          )
          .toBe(3);
        // Command, descendant and watchdog are three independently identified
        // processes. The watchdog's inherited mark uses the unchanged gate.
        for (const pid of [pids.parent, pids.child, pids.watchdog]) {
          await expect.poll(() => ownedWorkerTerminated(pid)).toBe(true);
          expect(diagnostics()?.outcomes).toContainEqual(
            expect.objectContaining({
              pid,
              status: 'reaped',
              life: pids.life,
              evidence: expect.objectContaining({ mark: pids.life }),
            }),
          );
        }
        expect(diagnostics()?.outcomes).toContainEqual(
          expect.objectContaining({
            pid: pids.watchdog,
            status: 'reaped',
            evidence: expect.objectContaining({
              pgid: pids.parent,
              via: 'inherited-mark',
            }),
          }),
        );
        await waitForOwnedGroupTermination(pids.parent, Date.now() + 1000);
      }, 30_000);
    }

    it.skipIf(process.platform !== 'linux')(
      'leaves a detached mark-erased escape alone without a diagnostic warning',
      async () => {
        const pids = await orphan('escaped');
        await start();
        await expect
          .poll(() => diagnostics()?.status)
          .toMatch(/^(complete|incomplete)$/);
        const receipt = diagnostics();
        if (receipt === undefined)
          throw new Error('Missing finished sweep receipt');
        const evidence = JSON.stringify(receipt);
        expect(ownedWorkerTerminated(pids.parent), evidence).toBe(true);
        expect(ownedWorkerTerminated(pids.child), evidence).toBe(false);
        expect(receipt.outcomes, evidence).toContainEqual(
          expect.objectContaining({ pid: pids.parent, status: 'reaped' }),
        );
        expect(
          receipt.outcomes.some((o) => o.pid === pids.child),
          evidence,
        ).toBe(false);
        expect(
          receipt.outcomes.some((o) => o.status === 'failed'),
          evidence,
        ).toBe(false);
        // A shared host may have other unreadable environments. Their explicitly
        // named abstentions cannot turn a readable, mark-erased escape into owned
        // work or require the entire host's discovery to be complete.
        if (receipt.status === 'incomplete') {
          const abstentions = receipt.outcomes.filter(
            (o) => o.status === 'abstained',
          );
          expect(abstentions.length, evidence).toBeGreaterThan(0);
          for (const outcome of abstentions) {
            expect(outcome, evidence).toMatchObject({
              pid: expect.any(Number),
              reason:
                'Same-user ownership mark could not be read; command attribution is unknown',
            });
            expect([pids.parent, pids.child], evidence).not.toContain(
              outcome.pid,
            );
          }
        }
      },
      30_000,
    );

    for (const scenario of [
      'unmarked',
      'previous-boot',
      'argv-only',
    ] as const) {
      const previousBoot = scenario === 'previous-boot';
      it(`abstains from an unrelated identifier (${scenario})`, async () => {
        // Initialize through production startup, then simulate a stale dead-life record
        // pointing at an owned, responsive unrelated process. No OS PID churn is required.
        // A life is admitted only by actual command execution, not an idle startup.
        await orphan('tree');
        const prior = new Database(`${db}.commands.sqlite`);
        const lifeRow = prior
          .prepare('SELECT life FROM command_lives LIMIT 1')
          .get();
        prior.close();
        if (
          typeof lifeRow !== 'object' ||
          lifeRow === null ||
          !('life' in lifeRow) ||
          typeof lifeRow.life !== 'string'
        )
          throw new Error('Missing durable daemon life');
        const unrelated = spawn(
          process.execPath,
          [
            '-e',
            "process.on('message',()=>process.send('alive'));process.send('ready')",
            ...(scenario === 'argv-only'
              ? [`AGENTMONITORS_COMMAND_LIFE=${lifeRow.life}`]
              : []),
          ],
          {
            env: {
              ...process.env,
              ...(previousBoot
                ? { AGENTMONITORS_COMMAND_LIFE: lifeRow.life }
                : {}),
            },
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
        children.push(unrelated);
        if (unrelated.pid !== undefined) groups.add(unrelated.pid);
        await once(unrelated, 'message');
        const table = await readProcessTable();
        if (!table.supported) throw new Error(table.reason);
        const identity = table.processes.find((p) => p.pid === unrelated.pid);
        expect(identity).toBeDefined();
        const sql = new Database(`${db}.commands.sqlite`);
        try {
          sql
            .prepare(
              'UPDATE command_lives SET owner = ?, boot = CASE WHEN ? THEN ? ELSE boot END',
            )
            .run(
              JSON.stringify({
                pid: 2147483647,
                pgid: 2147483647,
                startTime: 'dead',
              }),
              previousBoot ? 1 : 0,
              'previous-boot',
            );
          sql
            .prepare(
              'INSERT INTO command_pids(life, pid) SELECT life, ? FROM command_lives',
            )
            .run(unrelated.pid);
        } finally {
          sql.close();
        }
        await start();
        await expect
          .poll(() =>
            diagnostics()?.outcomes.some(
              (o) => o.pid === unrelated.pid && o.status === 'abstained',
            ),
          )
          .toBe(true);
        expect(diagnostics()?.outcomes).toContainEqual(
          expect.objectContaining({
            pid: unrelated.pid,
            status: 'abstained',
            reason: expect.stringMatching(
              previousBoot ? /boot/i : /mark|environment/i,
            ),
          }),
        );
        const response = once(unrelated, 'message');
        unrelated.send('ping');
        expect((await bounded(response, 'unrelated process response'))[0]).toBe(
          'alive',
        );
      }, 30_000);
    }

    it('records that a clean start ran a sweep with no candidates', async () => {
      await start();
      await expect
        .poll(() => diagnostics())
        .toEqual(expect.objectContaining({ status: 'complete', outcomes: [] }));
    });
  },
);

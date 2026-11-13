/** Restart-time containment proves both cleanup and the stronger never-wrong-kill boundary. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
import { readProcessTable } from '@agentmonitors/core';
import { waitForOwnedGroupTermination } from '../../../../scripts/owned-test-group.mjs';
import { ownedWorkerTerminated } from '../../../../scripts/owned-worker-terminated.mjs';

const CLI = path.resolve(import.meta.dirname, '../../dist/index.cjs');
let workspace: string;
let db: string;
let monitors: string;
const children: ChildProcess[] = [];
const groups = new Set<number>();

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
  const file = path.join(workspace, 'pids.json');
  if (existsSync(file)) {
    const pids: { parent: number; child: number; detached: boolean } =
      JSON.parse(readFileSync(file, 'utf8'));
    groups.add(pids.parent);
    if (pids.detached) groups.add(pids.child);
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await bounded(exited, 'owned child exit');
    }
  }
  for (const group of groups) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
      )
        throw error;
    }
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
): void {
  const leaf = `
    let armed=false;
    process.on('disconnect',()=>{if(!armed)process.exit(0)});
    process.on('message',()=>{armed=true;process.send('armed');process.disconnect()});
    setInterval(()=>{},1000);process.send('ready');
  `;
  const fixture = `
    const fs=require('node:fs');
    const env={...process.env};
    if (${JSON.stringify(mode)}==='escaped'||${JSON.stringify(mode)}==='group-unmarked') delete env.AGENTMONITORS_COMMAND_LIFE;
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{env,detached:${mode === 'detached' || mode === 'escaped'},stdio:['ignore','ignore','ignore','ipc']});
    fs.writeFileSync('pids.json',JSON.stringify({parent:process.pid,child:child.pid,detached:${mode === 'detached' || mode === 'escaped'}}));
    child.on('message',(message)=>{if(message==='ready')child.send('arm');else if(message==='armed')fs.writeFileSync('ready','ready')});
    setInterval(()=>{},1000);
  `;
  const dir = path.join(monitors, 'command');
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, 'MONITOR.md'),
    `---\nname: Restart cleanup\nwatch:\n  type: command-poll\n  command: ${JSON.stringify([process.execPath, '-e', fixture])}\n  timeout: 5m\n  interval: 1h\nurgency: normal\n---\nInspect changes.\n`,
  );
}

/** Crash only after process readiness, then disable new work so a restart cannot mask leftovers. */
async function orphan(
  mode: 'tree' | 'detached' | 'escaped' | 'group-unmarked',
): Promise<{ parent: number; child: number }> {
  monitor(mode);
  const daemon = await start();
  await expect
    .poll(() => existsSync(path.join(workspace, 'ready')), { timeout: 10_000 })
    .toBe(true);
  const pids: { parent: number; child: number } = JSON.parse(
    readFileSync(path.join(workspace, 'pids.json'), 'utf8'),
  );
  const exit = once(daemon, 'exit');
  daemon.kill('SIGKILL');
  await bounded(exit, 'owned daemon crash');
  rmSync(path.join(monitors, 'command'), { recursive: true });
  expect(ownedWorkerTerminated(pids.parent)).toBe(false);
  expect(ownedWorkerTerminated(pids.child)).toBe(false);
  return pids;
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'restart sweep',
  () => {
    for (const mode of ['tree', 'detached', 'group-unmarked'] as const) {
      it(`reconciles a killed daemon's ${mode} command and descendant with honest identity diagnostics`, async () => {
        const pids = await orphan(mode);
        await start();
        if (process.platform === 'darwin') {
          // The shipped macOS reader has no environment-only evidence. Preserve
          // both owned fixtures and require honest abstentions at readiness.
          expect(diagnostics()?.status).toBe('incomplete');
          for (const pid of [pids.parent, pids.child]) {
            expect(ownedWorkerTerminated(pid)).toBe(false);
            expect(diagnostics()?.outcomes).toContainEqual(
              expect.objectContaining({
                pid,
                status: 'abstained',
                reason: expect.stringMatching(/environments.*argv.*unproven/),
              }),
            );
          }
          expect(
            diagnostics()?.outcomes.some((o) => o.status === 'reaped'),
          ).toBe(false);
          return;
        }
        await expect
          .poll(
            () =>
              diagnostics()?.outcomes.filter((o) => o.status === 'reaped')
                .length,
          )
          .toBe(2);
        for (const pid of [pids.parent, pids.child]) {
          await expect.poll(() => ownedWorkerTerminated(pid)).toBe(true);
          expect(diagnostics()?.outcomes).toContainEqual(
            expect.objectContaining({
              pid,
              status: 'reaped',
              life: expect.any(String),
              evidence: expect.any(Object),
            }),
          );
        }
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

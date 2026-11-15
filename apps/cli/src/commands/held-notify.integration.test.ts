/**
 * User-facing diagnosis of accepted observations awaiting notify release (005).
 * A real file source and daemon create the hold; no store seeding substitutes
 * for acceptance. Quiet ticks and rejected definitions must not hide that work.
 * The shared test boundary owns the workspace and removes it after child exit.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { writeLocalState } from '../local-state.js';
import type { HeldNotifyWork, MonitorExplainReport } from '@agentmonitors/core';

/** The published command bundle, built by Nx before this serial suite runs. */
const cli = path.resolve(import.meta.dirname, '../../dist/index.cjs');

/** One isolated daemon route, with bounded CLI invocations and owned shutdown. */
async function fixture(strategy: 'debounce' | 'rollup') {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('The test boundary must supply an isolated HOME.');
  }
  const workspace = path.join(home, 'held-work');
  const dir = path.join(workspace, '.claude/monitors');
  const definition = path.join(dir, 'held/MONITOR.md');
  const socket = path.join(workspace, 'd.sock');
  const db = path.join(workspace, 'db.sqlite');
  mkdirSync(path.dirname(definition), { recursive: true });
  writeFileSync(path.join(workspace, 'watched.txt'), 'baseline');
  // February 31 never opens a rollup window; debounce stays settled far beyond
  // the test lifetime. Both let diagnosis observe a stable accepted batch.
  const valid = `---
name: Held files
watch:
  type: file-fingerprint
  globs: [watched.txt]
  cwd: ${JSON.stringify(workspace)}
  interval: 1s
urgency: normal
notify:
  strategy: ${strategy}
${strategy === 'debounce' ? '  settle-for: 1h' : "  window: '0 0 31 2 *'"}
---
Inspect the changed file.
`;
  writeFileSync(definition, valid);
  writeLocalState(workspace, { enabled: true, socket, db });
  const env = { ...process.env, AGENTMONITORS_DB: db };
  const child = spawn(
    process.execPath,
    [
      cli,
      'daemon',
      'run',
      dir,
      '--workspace',
      workspace,
      '--socket',
      socket,
      '--poll-ms',
      '100',
    ],
    { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let diagnostic = '';
  child.stdout.on('data', (data: Buffer) => {
    diagnostic += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    diagnostic += data.toString();
  });
  /** Always name the owned route; diagnostic failures may legitimately exit 1. */
  function run(command: string[], format: 'text' | 'json' = 'json') {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        ...command,
        '--workspace',
        workspace,
        '--dir',
        dir,
        '--socket',
        socket,
        '--format',
        format,
      ],
      { cwd: workspace, env, encoding: 'utf8', timeout: 10_000 },
    );
    if (result.error) {
      throw result.error;
    }
    expect(
      [0, ...(command[0] === 'doctor' ? [1] : [])],
      result.stdout + result.stderr,
    ).toContain(result.status);
    return result.stdout;
  }
  /** Poll observable outcomes, rather than depending on a guessed tick delay. */
  async function until(check: () => boolean) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(diagnostic);
      }
      if (check()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Daemon outcome did not arrive: ${diagnostic}`);
  }
  /** Reap only this fixture's child, even if startup or an assertion fails. */
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.kill('SIGTERM');
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await until(() => diagnostic.includes('AgentMon daemon listening'));
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    run,
    until,
    explain: () =>
      JSON.parse(run(['monitor', 'explain', 'held'])) as MonitorExplainReport,
    change: () =>
      writeFileSync(path.join(workspace, 'watched.txt'), 'accepted change'),
    reject: () =>
      writeFileSync(
        definition,
        valid.replace('interval: 1s', 'interval: invalid'),
      ),
    parseReject: () => writeFileSync(definition, '---\nwatch: [\n---\n'),
    restore: () => writeFileSync(definition, valid),
    release: () =>
      writeFileSync(
        definition,
        valid
          .replace('settle-for: 1h', 'settle-for: 1s')
          .replace("window: '0 0 31 2 *'", "window: '* * * * *'"),
      ),
    stop,
  };
}

for (const strategy of ['debounce', 'rollup'] as const) {
  it(`reports rejected-definition ${strategy} work in explain and doctor, then releases after repair`, async () => {
    const f = await fixture(strategy);
    try {
      await f.until(() =>
        f
          .explain()
          .observations.some(
            (row) => row.result === 'no-change' || row.result === 'rebaselined',
          ),
      );
      f.change();
      await f.until(() =>
        f
          .explain()
          .stages.some(
            (stage) =>
              stage.id === 'notify' && stage.details?.['observations'] === 1,
          ),
      );
      f.reject();
      await f.until(() => f.explain().stages[0]?.status === 'failure');
      for (const rejection of ['scope', 'parse']) {
        if (rejection === 'parse') {
          f.parseReject();
        }
        const report = f.explain();
        expect(report.verdict.stage).toBe('definition');
        const notify = report.stages.find((stage) => stage.id === 'notify');
        expect(notify).toMatchObject({
          status: 'pending',
          details: {
            strategy,
            observations: 1,
            blockedByDefinition: true,
            releaseBarrier: 'definition-rejected',
          },
        });
        expect(notify?.reason).toContain('Fix the definition');
        const text = f.run(['monitor', 'explain', 'held'], 'text');
        expect(text).toContain(`${strategy} is holding 1 observation(s)`);
        expect(text).toContain('Fix the definition');
        expect(text).toContain(notify?.reason);
        const doctor: {
          daemon: { running: boolean };
          heldNotifyWork: HeldNotifyWork[];
        } = JSON.parse(f.run(['doctor']));
        expect(doctor.daemon.running).toBe(true);
        expect(doctor.heldNotifyWork).toEqual([
          expect.objectContaining({
            monitorId: 'held',
            strategy,
            observations: 1,
            blockedByDefinition: true,
            releaseBarrier: 'definition-rejected',
          }),
        ]);
        expect(doctor.heldNotifyWork[0]?.reason).toBe(notify?.reason);
        const doctorText = f.run(['doctor'], 'text');
        expect(doctorText).toContain(`${strategy} is holding 1 observation(s)`);
        expect(doctorText).toContain('Fix the definition');
      }
      f.restore();
      // Repair alone restores eligibility, preserving the original pacing.
      await f.until(() => f.explain().stages[0]?.status === 'ok');
      const repaired: { heldNotifyWork: HeldNotifyWork[] } = JSON.parse(
        f.run(['doctor']),
      );
      expect(repaired.heldNotifyWork).toEqual([
        expect.objectContaining({
          observations: 1,
          blockedByDefinition: false,
          releaseBarrier: 'none',
        }),
      ]);
      // A valid policy edit releases the accepted batch without waiting an hour
      // or a calendar window (002 §4.6); diagnosis must then stop counting it.
      f.release();
      await f.until(() => f.explain().events.length === 1);
      const doctor: { heldNotifyWork: unknown[] } = JSON.parse(
        f.run(['doctor']),
      );
      expect(doctor.heldNotifyWork).toEqual([]);
    } finally {
      await f.stop();
    }
  });
}

it('keeps downstream stages pending for held work despite a quiet latest tick', async () => {
  const f = await fixture('debounce');
  try {
    await f.until(() => f.explain().observations.length > 0);
    f.change();
    await f.until(() =>
      f
        .explain()
        .stages.some(
          (stage) =>
            stage.id === 'notify' && stage.details?.['observations'] === 1,
        ),
    );
    await f.until(() => f.explain().observations[0]?.result === 'no-change');
    const report = f.explain();
    for (const id of ['materialization', 'delivery']) {
      expect(report.stages.find((stage) => stage.id === id)).toMatchObject({
        status: 'pending',
      });
    }
    const text = f.run(['monitor', 'explain', 'held'], 'text');
    expect(text).toContain('debounce is holding 1 observation(s)');
    expect(text).not.toContain(
      'Nothing to deliver — the source observed no changes',
    );
    const doctor: { heldNotifyWork: unknown[] } = JSON.parse(f.run(['doctor']));
    expect(doctor.heldNotifyWork).toEqual([
      expect.objectContaining({
        monitorId: 'held',
        strategy: 'debounce',
        observations: 1,
        blockedByDefinition: false,
        releaseBarrier: 'none',
      }),
    ]);
    expect(f.run(['doctor'], 'text')).toContain(
      'debounce is holding 1 observation(s)',
    );
  } finally {
    await f.stop();
  }
});

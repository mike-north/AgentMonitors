/**
 * The positive jq control must respect the outer host's optional local
 * facility contract. Select only that control in a separate Vitest process;
 * this suite is never selected in the child, so execution cannot recurse.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';
import { ownedWorkerTerminated } from './owned-worker-terminated.mjs';
import { runJqTestChild } from './run-jq-test-child.mjs';

const root = resolve(import.meta.dirname, '..');

it.each(['local', 'CI'])(
  'handles an outer %s host without jq',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'jq-outer-host-'));
    try {
      symlinkSync(process.execPath, join(dir, 'node'));
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: dir };
      delete env.CI;
      if (mode === 'CI') env.CI = 'true';
      const report = join(dir, 'report.json');
      const result = await runJqTestChild(
        [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'scripts/vitest.config.ts',
          'scripts/jq-coverage.test.ts',
          '-t',
          'reports actual jq coverage: present',
          '--reporter=json',
          `--outputFile=${report}`,
        ],
        {
          cwd: root,
          env,
          timeout: 25_000,
        },
      );
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      const summary = JSON.parse(readFileSync(report, 'utf8'));
      if (mode === 'CI') {
        expect(result.status).not.toBe(0);
        expect(JSON.stringify(summary)).toContain('jq');
      } else {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(summary.numPassedTests).toBe(0);
        expect(summary.numPendingTests).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

it('bounds an owned child and cleans up workers that inherit its pipes', async () => {
  const result = await runJqTestChild(
    [
      '-e',
      "const {spawn}=require('node:child_process'); const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(worker.pid); setInterval(()=>{},1000);",
    ],
    { cwd: root, env: process.env, timeout: 1_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBeNull();
  expect(result.stdout.trim()).toMatch(/^\d+$/);
  const workerPid = Number(result.stdout.trim());
  // A killed worker may remain an unreaped Linux zombie under PID 1.
  // Require termination, not reaping by a process outside this fixture.
  await expect.poll(() => ownedWorkerTerminated(workerPid)).toBe(true);
}, 10_000);

/**
 * Optional local jq coverage must be reported as omitted, while CI requires
 * the real preset reductions. Exercise Vitest registration in child processes
 * so discovery observes each facility/environment combination independently.
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { expect, it } from 'vitest';
import { runJqTestChild } from './run-jq-test-child.mjs';

const root = resolve(import.meta.dirname, '..');

// Probe the outer host, not just the private child PATH. Only the positive
// control needs host jq; missing-facility controls must always execute.
const hostHasJq =
  spawnSync('jq', ['--version'], { timeout: 1_000 }).status === 0;

for (const mode of ['local missing', 'CI missing', 'present']) {
  it.skipIf(mode === 'present' && !hostHasJq && !process.env.CI)(
    `reports actual jq coverage: ${mode}`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jq-coverage-'));
      try {
        // A private PATH containing only Node cannot accidentally find host jq.
        symlinkSync(process.execPath, join(dir, 'node'));
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: mode === 'present' ? process.env.PATH : dir,
        };
        delete env.CI;
        if (mode === 'CI missing' || (mode === 'present' && process.env.CI)) {
          env.CI = 'true';
        }
        const report = join(dir, 'report.json');
        const result = await runJqTestChild(
          [
            join(root, 'node_modules/vitest/vitest.mjs'),
            'run',
            'src/commands/pr-alerting-presets.test.ts',
            '-t',
            'the presets’ jq reduction over raw gh output',
            '--reporter=json',
            `--outputFile=${report}`,
          ],
          {
            cwd: join(root, 'apps/cli'),
            env,
            // Bound the owned child below the enclosing test deadline. A private
            // process group also cleans up surviving Vitest workers on exit.
            timeout: 20_000,
          },
        );
        expect(result.error, result.stdout + result.stderr).toBeUndefined();
        const summary = JSON.parse(readFileSync(report, 'utf8'));
        if (mode === 'CI missing') {
          expect(result.status).not.toBe(0);
          expect(JSON.stringify(summary)).toContain('jq was not found on PATH');
        } else if (mode === 'local missing') {
          expect(result.status).toBe(0);
          expect(summary.numPassedTests).toBe(0);
          expect(summary.numPendingTests).toBeGreaterThan(0);
          expect(JSON.stringify(summary)).toContain('omitted');
        } else {
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(summary.numPassedTests).toBeGreaterThan(1);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
}

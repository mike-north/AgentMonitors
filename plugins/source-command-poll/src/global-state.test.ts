/** A timed-out nested case must not leak PATH or a global spy into its successor. */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('restores PATH and instrumentation after an actual test timeout', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'global-restoration-'));
  const output = path.join(dir, 'result.json');
  const timeoutReceipt = path.join(dir, 'timeout.txt');
  const helper = path.resolve(
    import.meta.dirname,
    'global-state.test-support.ts',
  );
  writeFileSync(
    path.join(dir, 'timeout.test.ts'),
    `
    import {expect, it, vi} from 'vitest';
    import {writeFileSync} from 'node:fs';
    import {restoreProcessGlobalsAfterEach} from ${JSON.stringify(helper)};
    restoreProcessGlobalsAfterEach();
    const originalPath = process.env.PATH;
    const originalWrite = process.stderr.write;
    it('times out with globals changed', async ({signal}) => {
      signal.addEventListener('abort', () => writeFileSync(${JSON.stringify(timeoutReceipt)}, String(signal.reason?.message)));
      process.env.PATH = '/fixture-with-no-tools';
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await new Promise(() => {});
    }, 50);
    it('sees the original globals', () => {
      expect(process.env.PATH).toBe(originalPath);
      expect(process.stderr.write).toBe(originalWrite);
    });
  `,
  );
  // Resolve the package executable before launching with a temporary root.
  const vitest = path.join(
    path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
    'vitest.mjs',
  );
  let failed = false;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        vitest,
        'run',
        '--root',
        dir,
        '--maxWorkers=1',
        '--reporter=json',
        '--outputFile=' + output,
      ],
      {
        cwd: dir,
        env: { ...process.env },
        timeout: 10_000,
      },
    );
  } catch (error) {
    // The intentional timeout must make the nested runner fail, not time out
    // our subprocess budget or conceal an infrastructure failure.
    expect(error).toMatchObject({ code: 1, killed: false });
    failed = true;
  }
  expect(failed).toBe(true);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  expect(readFileSync(timeoutReceipt, 'utf8')).toMatch(/timed out/i);
  expect(report.numFailedTests).toBe(1);
  expect(report.numPassedTests).toBe(1);
  expect(report.testResults[0].assertionResults).toEqual([
    expect.objectContaining({
      title: 'times out with globals changed',
      status: 'failed',
    }),
    expect.objectContaining({
      title: 'sees the original globals',
      status: 'passed',
    }),
  ]);
}, 15_000);

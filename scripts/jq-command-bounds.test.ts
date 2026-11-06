/** Negative facility phases must fail visibly and leave their owned jq terminal. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { JsonTestResults } from 'vitest/reporters';
import { ownedWorkerTerminated } from './owned-worker-terminated.mjs';
import { waitForOwnedGroupTermination } from './owned-test-group.mjs';

const root = resolve(import.meta.dirname, '..');

// Measured cold/contended Vitest launch/import/report work approaches 3s. Give
// that framework work its own 4s allowance plus the independently proven 1s jq
// verdict; framework scheduling does not extend jq's execution deadline.
const FRAMEWORK_ALLOWANCE = 4_000;
const NEGATIVE_PHASE_ALLOWANCE = FRAMEWORK_ALLOWANCE + 1_000;

/**
 * Close only this fixture's detached Vitest driver group within its reserved
 * cleanup deadline. A signal request/error is not terminal evidence. Query and
 * process-close evidence are required for successful cleanup. Owned readers/ref
 * are released even when cleanup fails, without claiming termination.
 */
async function finishNegativeJqDriver(
  child: ChildProcess,
  completion: Promise<number | null>,
  cleanupDeadline: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signalFailure: unknown;
  try {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        // Group disappearance can race Node's close event. Retain a failed
        // redundant signal if independent close/terminal confirmation fails.
        if (
          !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
        )
          signalFailure = error;
      }
    }
    await Promise.race([
      Promise.all([
        completion,
        child.pid === undefined
          ? Promise.resolve()
          : waitForOwnedGroupTermination(child.pid, cleanupDeadline),
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Owned negative-test driver cleanup deadline expired'),
            ),
          Math.max(1, cleanupDeadline - Date.now()),
        );
      }),
    ]);
  } catch (error) {
    throw signalFailure ?? error;
  } finally {
    clearTimeout(timer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
}

// A private negative executable models a broken facility only. Positive controls
// continue to execute host jq against programs extracted from canonical templates.
it.each([
  ['jq-coverage.test.ts', 'version'],
  ['jq-direct-presets.test.ts', 'version'],
  ['jq-direct-presets.test.ts', 'filter'],
])(
  'bounds actual %s %s execution before forced fixture cleanup',
  async (file, mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'jq-command-deadline-'));
    const pids = join(dir, 'pids');
    const jq = join(dir, 'jq');
    const phases = join(dir, 'phases.jsonl');
    const reportFile = join(dir, 'phase-result.json');
    writeFileSync(
      jq,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(phases)},JSON.stringify({phase:process.argv.includes('--version')?'version':'filter',pid:process.pid,at:Date.now()})+'\\n');if(process.argv.includes('--version')&&${JSON.stringify(mode)}==='filter'){console.log('jq-negative-fixture');process.exit(0)};require('node:fs').appendFileSync(${JSON.stringify(pids)},String(process.pid)+'\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    );
    const args = [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'scripts/vitest.config.ts',
      `scripts/${file}`,
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${reportFile}`,
    ];
    if (file === 'jq-coverage.test.ts')
      args.push('-t', 'reports actual jq coverage: present');
    // Exercise one real canonical filter's timeout; selecting the whole file
    // would spend two command budgets inside this single phase's watchdog.
    if (mode === 'filter')
      args.push(
        '-t',
        'executes the actual pr-review program on authored fixtures$',
      );
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    let closed = false;
    let closeStatus: number | null = null;
    let launchError: Error | undefined;
    child.on('error', (error) => {
      launchError = error;
    });
    const completion = new Promise<number | null>((resolve) => {
      child.once('close', (status) => {
        closed = true;
        closeStatus = status;
        resolve(status);
      });
    });
    let phaseFailure: unknown;
    let cleanupFailure: unknown;
    try {
      let phaseReport: JsonTestResults | undefined;
      let status: 'reported' | 'blocked' | number | null = 'blocked';
      // Vitest's JSON reporter publishes only at onTestRunEnd. Process close
      // also includes reporter/pool teardown, which is not the jq verdict.
      const phaseDeadline = started + NEGATIVE_PHASE_ALLOWANCE;
      while (Date.now() < phaseDeadline) {
        if (existsSync(reportFile)) {
          try {
            phaseReport = JSON.parse(readFileSync(reportFile, 'utf8'));
            if (Date.now() >= phaseDeadline) break;
            status = 'reported';
            break;
          } catch (error) {
            // A fresh report can be observed during its single file write.
            // Incomplete JSON is not evidence of a completed phase.
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
        if (launchError) throw launchError;
        if (closed) {
          status = closeStatus;
          break;
        }
        await delay(Math.min(10, Math.max(1, phaseDeadline - Date.now())));
      }
      const phaseEvidence = existsSync(phases)
        ? readFileSync(phases, 'utf8')
        : 'No jq phase began';
      const evidence = `${output}\nComplete phase report: ${JSON.stringify(phaseReport)}\nDriver started: ${started}\nDriver elapsed: ${Date.now() - started}ms\nFramework/command phase allowance: ${NEGATIVE_PHASE_ALLOWANCE}ms\nOwned phases:\n${phaseEvidence}`;
      const registeredPids = existsSync(pids)
        ? readFileSync(pids, 'utf8').trim().split('\n').map(Number)
        : [];
      expect(
        registeredPids.every((pid) => Number.isInteger(pid) && pid > 0),
        evidence,
      ).toBe(true);
      // The reporter publishes the whole intended run, not the first error in
      // a multi-test file. Verify the selected phase and its terminal command.
      expect(phaseReport, evidence).toBeDefined();
      if (!phaseReport) throw new Error(evidence);
      expect(phaseReport.success, evidence).toBe(false);
      expect(phaseReport.numPendingTestSuites, evidence).toBe(0);
      expect(phaseReport.testResults, evidence).toHaveLength(1);
      const module = phaseReport.testResults[0];
      if (!module) throw new Error(evidence);
      expect(module.name, evidence).toBe(join(root, 'scripts', file));
      expect(module.status, evidence).toBe('failed');
      if (mode === 'version') {
        expect(phaseReport.numTotalTests, evidence).toBe(0);
        expect(module.assertionResults, evidence).toHaveLength(0);
        expect(module.message, evidence).toMatch(/jq command deadline expired/);
      } else {
        expect(phaseReport.numFailedTests, evidence).toBe(1);
        expect(phaseReport.numPassedTests, evidence).toBe(0);
        expect(phaseReport.numTotalTests, evidence).toBe(2);
        expect(module.assertionResults, evidence).toHaveLength(2);
        expect(
          module.assertionResults
            .filter((result) => result.status !== 'skipped')
            .map((result) => result.title),
          evidence,
        ).toEqual([
          'executes the actual pr-review program on authored fixtures',
        ]);
        const failures = module.assertionResults.filter(
          (result) => result.status === 'failed',
        );
        expect(
          failures.map((result) => result.title),
          evidence,
        ).toEqual([
          'executes the actual pr-review program on authored fixtures',
        ]);
        expect(failures[0]?.failureMessages?.join('\n'), evidence).toMatch(
          /jq command deadline expired/,
        );
      }
      expect(registeredPids, evidence).toHaveLength(1);
      for (const pid of registeredPids) {
        expect(
          ownedWorkerTerminated(pid),
          `owned jq ${pid} still live\n${evidence}`,
        ).toBe(true);
      }
      expect(status, evidence).toBe('reported');
      expect(Date.now(), evidence).toBeLessThan(phaseDeadline);
    } catch (error) {
      phaseFailure = error;
    } finally {
      // Reserve 1s for cleanup after the 5s framework/command phase, with 1s
      // harness margin in the 7s test. Natural reporter exit is not the verdict.
      try {
        await finishNegativeJqDriver(child, completion, Date.now() + 1_000);
      } catch (error) {
        cleanupFailure = error;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // Cleanup cannot erase a failed phase or silently succeed when it is denied.
    if (phaseFailure && cleanupFailure)
      throw new AggregateError(
        [phaseFailure, cleanupFailure],
        'Negative jq phase and owned driver cleanup failed',
      );
    if (phaseFailure) throw phaseFailure;
    if (cleanupFailure) throw cleanupFailure;
  },
  7_000,
);

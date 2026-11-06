/** Negative facility phases must fail visibly and leave their owned jq terminal. */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ownedWorkerTerminated } from './owned-worker-terminated.mjs';

const root = resolve(import.meta.dirname, '..');

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
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([
        completion,
        new Promise<'blocked'>((resolve) => {
          timer = setTimeout(() => resolve('blocked'), 4_000);
        }),
      ]);
      const phaseEvidence = existsSync(phases)
        ? readFileSync(phases, 'utf8')
        : 'No jq phase began';
      const evidence = `${output}\nDriver elapsed: ${Date.now() - started}ms\nOwned phases:\n${phaseEvidence}`;
      const registeredPids = existsSync(pids)
        ? readFileSync(pids, 'utf8').trim().split('\n').map(Number)
        : [];
      expect(
        registeredPids.every((pid) => Number.isInteger(pid) && pid > 0),
        evidence,
      ).toBe(true);
      expect(
        status,
        `actual jq module must finish before forced fixture cleanup\n${evidence}`,
      ).not.toBe('blocked');
      // One negative command is sufficient to prove this phase's deadline.
      // Positive canonical controls still run both authored reductions.
      expect(registeredPids, evidence).toHaveLength(1);
      expect(status, evidence).not.toBe(0);
      expect(output).toMatch(/jq.*deadline/i);
      for (const pid of registeredPids) {
        expect(ownedWorkerTerminated(pid), `owned jq ${pid} still live`).toBe(
          true,
        );
      }
    } finally {
      clearTimeout(timer);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          expect(error).toMatchObject({ code: 'ESRCH' });
        }
      }
      await completion;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  6_000,
);

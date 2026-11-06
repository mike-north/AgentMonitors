/** Nested helper work must terminate inside the outer owner's cleanup boundary. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ownedWorkerTerminated } from './owned-worker-terminated.mjs';
import { runJqTestChild } from './run-jq-test-child.mjs';

const root = resolve(import.meta.dirname, '..');

it.each(['timeout', 'natural exit'])(
  'cleans nested descendants on outer %s',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'jq-nested-owner-'));
    const pidFile = join(dir, 'worker.pid');
    const liveFile = join(dir, 'live-control');
    let pid: number | undefined;
    try {
      const loop = 'setInterval(()=>{},1000)';
      const inner =
        mode === 'timeout'
          ? `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('node:fs').writeFileSync(${JSON.stringify(liveFile)},String(process.kill(process.pid,0)));${loop}`
          : `const worker=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(loop)}],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(worker.pid));require('node:fs').writeFileSync(${JSON.stringify(liveFile)},String(process.kill(worker.pid,0)));worker.unref();`;
      const middle = `import {runJqTestChild} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/run-jq-test-child.mjs')).href)};const result=await runJqTestChild(['-e',${JSON.stringify(inner)}],{cwd:${JSON.stringify(dir)},env:{},timeout:20000});if(result.error)throw result.error;if(result.status!==0)throw new Error('nested child did not exit naturally');`;
      const result = await runJqTestChild(
        ['--input-type=module', '-e', middle],
        {
          cwd: dir,
          env: process.env,
          timeout: mode === 'timeout' ? 1_000 : 5_000,
        },
      );
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(readFileSync(liveFile, 'utf8')).toBe('true');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === 'timeout' ? null : 0);
      const workerPid = pid;
      await expect.poll(() => ownedWorkerTerminated(workerPid)).toBe(true);
    } finally {
      // The negative proof must not leak the exact worker it deliberately exposes.
      if (pid === undefined) {
        try {
          pid = Number(readFileSync(pidFile, 'utf8'));
        } catch {
          /* No worker was registered. */
        }
      }
      if (pid) {
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, 'SIGKILL');
          } catch (error) {
            expect(error).toMatchObject({ code: 'ESRCH' });
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10_000,
);

/** Linux PID 1 must retire adopted watchdogs without an external reaping init. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** A stopped Docker daemon is a reported skip, never permission to start it. */
function hasDocker(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The published source is the smallest real bounded-observation entry point.
 * Node itself is PID 1: no shell, --init, database, installation or helper init
 * can accidentally reap the watchdogs on the application's behalf.
 */
const program = String.raw`
import source from '/workspace/plugins/source-command-poll/dist/index.js';
import {readFileSync, readdirSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
if (process.pid !== 1) throw new Error('Expected Node as namespace PID 1');
function zombies() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = readFileSync('/proc/' + name + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[0] === 'Z' ? [{pid: Number(name), parent: Number(fields[1])}] : [];
    } catch { return []; }
  });
}
const counts = [];
for (let i = 0; i < 12; i++) {
  const code = 23 + i % 5;
  const result = await source.observe({
    command: [process.execPath, '-e', 'process.stdout.write("bounded");process.exit(' + code + ')'],
    timeout: '3s',
  }, {now: new Date()});
  if (result.nextState?.health !== 'ok' || result.nextState.exitCode !== code)
    throw new Error('Authored exit status lost: ' + JSON.stringify(result));
  await delay(50);
  counts.push(zombies().length);
}
// Completion writes the watchdog control pipe asynchronously. Allow that owned
// watchdog and the bounded reaper to settle before asserting the steady state.
const until = Date.now() + 2000;
while (zombies().length > 0 && Date.now() < until) await delay(25);
const remaining = zombies();
console.log(JSON.stringify({pid: process.pid, observations: 12, counts, remaining}));
if (remaining.length !== 0) throw new Error('Zombie watchdogs remain after bounded observations');
`;

describe.skipIf(!hasDocker())('Linux adopted watchdog lifecycle', () => {
  it('leaves zero zombies after repeated bounded observations as PID 1 without init', () => {
    const name = `am-pid1-${String(process.pid)}-${randomUUID()}`;
    const repo = path.resolve(import.meta.dirname, '../../..');
    try {
      const stdout = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'none',
          '--pids-limit',
          '128',
          '-v',
          `${repo}:/workspace:ro`,
          '-w',
          '/workspace',
          'node:24-bookworm-slim',
          'node',
          '--input-type=module',
          '-e',
          program,
        ],
        {
          encoding: 'utf8',
          timeout: 90_000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        },
      );
      // Keep the population history in CI even on success so accumulation and
      // eventual cleanup can be assessed independently of the test's exit code.
      console.log(stdout.trim());
      expect(stdout).toContain('"observations":12');
      expect(stdout).toContain('"remaining":[]');
    } catch (error) {
      // Preserve /proc population counts when the expected regression throws.
      if (error instanceof Error && 'stdout' in error) {
        console.error(String(error.stdout));
      }
      throw error;
    } finally {
      // Removal targets only this test's uniquely named container. It also
      // cleans up after an assertion or a bounded Docker-client failure.
      try {
        execFileSync('docker', ['rm', '-f', name], {
          stdio: 'ignore',
          timeout: 5_000,
          killSignal: 'SIGKILL',
        });
      } catch {
        /* --rm normally removed the completed container already. */
      }
    }
  }, 100_000);
});

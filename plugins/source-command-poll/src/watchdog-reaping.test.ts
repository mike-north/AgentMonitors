/** A real Linux subreaper exercises native waits without a Docker daemon. */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Only this disposable, detached process becomes a subreaper. The test runner's
 * child ownership and libuv wait table remain unchanged. The unrelated child
 * must retain its own exit status while adopted watchdogs are being retired.
 */
const program = String.raw`
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const native = createRequire(import.meta.url)(process.argv[1]);
const prctl = native.load(null).func('int prctl(int option, ...)');
if (prctl(36, 'unsigned long', 1, 'unsigned long', 0, 'unsigned long', 0, 'unsigned long', 0) !== 0)
  throw new Error('Cannot enable fixture subreaper');
const {default: source} = await import(process.argv[2]);
const other = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(42), 400)'], {detached: true, stdio: 'ignore'});
const otherExit = new Promise((resolve, reject) => { other.once('exit', resolve); other.once('error', reject); });
const counts = [];
function zombies() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const stat = readFileSync('/proc/' + name + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[0] === 'Z' && Number(fields[1]) === process.pid ? [Number(name)] : [];
    } catch { return []; }
  });
}
for (let i = 0; i < 12; i++) {
  const result = await source.observe({command: [process.execPath, '-e', 'process.stdout.write("bounded");process.exit(23)'], timeout: '3s'}, {now: new Date()});
  if (result.nextState?.health !== 'ok' || result.nextState.exitCode !== 23)
    throw new Error('Lost authored exit status: ' + JSON.stringify(result));
  counts.push(zombies().length);
}
if (await otherExit !== 42) throw new Error('Lost unrelated libuv exit status');
// Failed native exec and an admission deadline must not leak unregistered
// watchdogs either. The VM registration cases separately force a deadline
// that has already elapsed before watchdog arming.
const failed = await source.observe({command: ['/missing-adoption-fixture'], timeout: '3s'}, {now: new Date()});
if (failed.nextState?.health !== 'failing') throw new Error('Expected exec refusal');
const expired = await source.observe({command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeout: '2s'}, {now: new Date()});
if (expired.nextState?.health !== 'failing') throw new Error('Expected admission/command timeout');
for (let i = 0; i < 280 && zombies().length; i++) await delay(25);
const remaining = zombies();
console.log(JSON.stringify({counts, remaining, authoredExit: 23, unrelatedExit: 42}));
if (remaining.length) throw new Error('Adopted zombies remain');
`;

describe.skipIf(process.platform !== 'linux')(
  'native Linux adopted watchdogs',
  () => {
    it('reaps adopted watchdogs while preserving authored and unrelated libuv exit statuses', () => {
      const native = fileURLToPath(
        new URL('../vendor/koffi/load.cjs', import.meta.url),
      );
      const source = new URL('../dist/index.js', import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', program, native, source],
        {
          detached: true,
          cwd: tmpdir(),
          encoding: 'utf8',
          timeout: 60_000,
          killSignal: 'SIGKILL',
        },
      );
      console.log(result.stdout.trim());
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"remaining":[]');
      expect(result.stdout).toContain('"unrelatedExit":42');
    }, 70_000);
  },
);

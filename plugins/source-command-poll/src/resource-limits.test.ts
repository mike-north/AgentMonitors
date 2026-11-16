/** Native commands must inherit the caller's limits rather than Node helper startup limits. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { beforeAll, describe, expect, it } from 'vitest';

/** getrlimit observes native state before any authored runtime can adjust it. */
const PROBE = String.raw`
#include <sys/resource.h>
#include <stdio.h>
int main(void) {
  struct rlimit value;
  for (int resource = 0; resource < RLIM_NLIMITS; resource++) {
    if (getrlimit(resource, &value) != 0) return 1;
    printf("%d %llu %llu\n", resource,
      (unsigned long long)value.rlim_cur, (unsigned long long)value.rlim_max);
  }
  return 0;
}
`;

/** Drain both descriptors and bound the fixture independently of command admission. */
async function runParent(program: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program], {
      cwd,
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_PATH: fileURLToPath(new URL('../node_modules', import.meta.url)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`Limit fixture failed: ${code}/${signal}: ${stderr}`));
    });
  });
}

describe.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'native resource limits',
  () => {
    let dir: string;
    let binary: string;
    let bundle: string;
    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'limits-'));
      binary = path.join(dir, 'probe');
      const file = path.join(dir, 'probe.c');
      writeFileSync(file, PROBE);
      execFileSync('cc', [file, '-o', binary], { timeout: 15_000 });
      // Bundle current source into the isolated parent's fixture. Never depend on
      // a stale dist/ result, and never change resource limits in the test runner.
      const outDir = path.join(dir, 'dist');
      mkdirSync(outDir);
      symlinkSync(
        fileURLToPath(new URL('../vendor', import.meta.url)),
        path.join(dir, 'vendor'),
      );
      await build({
        entry: { index: fileURLToPath(new URL('./index.ts', import.meta.url)) },
        outDir,
        format: ['cjs'],
        platform: 'node',
        config: false,
        splitting: false,
        silent: true,
        dts: false,
      });
      bundle = path.join(outDir, 'index.cjs');
    }, 30_000);

    it.each(['load', 'getrlimit'])(
      'refuses NOFILE capture %s failure before spawn and preserves ownership admission',
      async (fault) => {
        const output = await runParent(
          `
          const {createCommandPollSource} = require(${JSON.stringify(bundle)});
          const cp = require('node:child_process');
          const originalSpawn = cp.spawn;
          let spawned = 0, loads = 0, committed = 0, recorded = 0, exited = 0;
          cp.spawn = (...args) => { spawned++; return originalSpawn(...args); };
          const Module = require('node:module');
          const originalLoad = Module._load;
          Module._load = function(id, ...args) {
            if (!id.endsWith('/load.cjs')) return originalLoad.call(this, id, ...args);
            loads++;
            if (${JSON.stringify(fault)} === 'load') throw Object.assign(new Error('fixture native load: ERR_DLOPEN_FAILED'), {code: 'ERR_DLOPEN_FAILED'});
            const koffi = originalLoad.call(this, id, ...args);
            return {...koffi, load(...args) {
              const lib = koffi.load(...args);
              return {...lib, func(declaration) {
                if (declaration.includes(' getrlimit(')) return () => { koffi.errno(koffi.os.errno.EPERM); return -1; };
                return lib.func(declaration);
              }};
            }};
          };
          const owner = {
            async environment() { committed++; return {AGENTMONITORS_COMMAND_LIFE: 'fixture'}; },
            spawned() { recorded++; }, exited() { exited++; },
          };
          const previousState = {stdout: 'baseline', exitCode: 7, truncated: false, health: 'ok', baselined: true};
          createCommandPollSource(owner).observe({command: ['/bin/echo', 'capture'], timeout: '1s'}, {now: new Date(), previousState})
            .then(result => console.log(JSON.stringify({result, spawned, loads, committed, recorded, exited})))
            .catch(error => {console.error(error); process.exitCode = 1;});
        `,
          dir,
        );
        const receipt = JSON.parse(output);
        expect(receipt.result.nextState).toEqual({
          stdout: 'baseline',
          exitCode: 7,
          truncated: false,
          health: 'failing',
          baselined: true,
        });
        expect(receipt.spawned).toBe(0);
        expect(receipt.loads).toBe(1);
        expect(receipt.committed).toBe(1);
        expect(receipt.recorded).toBe(0);
        expect(receipt.exited).toBe(0);
        const error = receipt.result.observations[0]?.payload.error;
        expect(error).toContain('RLIMIT_NOFILE');
        expect(error).toContain(
          fault === 'load' ? 'could not be loaded' : 'getrlimit: EPERM (1)',
        );
        expect(error).toContain(
          fault === 'load' ? 'ERR_DLOPEN_FAILED' : 'operation not permitted',
        );
      },
    );

    it('captures NOFILE without reports or writes and caches the native function', async () => {
      // Instrument the daemon, not its disposable helpers. Even a deleted report
      // is a forbidden write; two observations must share one native binding.
      const output = await runParent(
        `
        const source = require(${JSON.stringify(bundle)}).default;
        const fs = require('node:fs'), fsp = require('node:fs/promises');
        let reports = 0, writes = 0, loads = 0, declarations = 0, calls = 0;
        process.report.getReport = () => { reports++; throw new Error('no diagnostic reports'); };
        process.report.writeReport = () => { reports++; throw new Error('no diagnostic reports'); };
        for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'writeSync', 'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'write', 'createWriteStream']) {
          fs[name] = () => { writes++; throw new Error('no capture writes: ' + name); };
        }
        for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp']) {
          fsp[name] = async () => { writes++; throw new Error('no capture writes: ' + name); };
        }
        const Module = require('node:module'), originalLoad = Module._load;
        Module._load = function(id, ...args) {
          const loaded = originalLoad.call(this, id, ...args);
          if (!id.endsWith('/load.cjs')) return loaded;
          loads++;
          return {...loaded, load(...args) {
            const lib = loaded.load(...args);
            return {...lib, func(declaration) {
              const fn = lib.func(declaration);
              if (!declaration.includes(' getrlimit(')) return fn;
              declarations++;
              return (...args) => {calls++; return fn(...args);};
            }};
          }};
        };
        (async () => {
          const results = [];
          for (let i = 0; i < 2; i++) results.push(await source.observe({command: ['/bin/echo', 'capture'], timeout: '1s'}, {now: new Date()}));
          console.log(JSON.stringify({results, reports, writes, loads, declarations, calls}));
        })().catch(error => {console.error(error); process.exitCode = 1;});
      `,
        dir,
      );
      const receipt = JSON.parse(output);
      for (const result of receipt.results)
        expect(result.nextState).toMatchObject({
          health: 'ok',
          stdout: 'capture\n',
        });
      expect(receipt).toMatchObject({
        reports: 0,
        writes: 0,
        loads: 1,
        declarations: 1,
        calls: 2,
      });
    });

    it('captures NOFILE promptly with a link-local UDP peer, 1100 handles and a busy worker', async () => {
      // A worker deliberately cannot service report interrupts. Capture must
      // remain bounded by its own fixed native read, independent of daemon state.
      const output = await runParent(
        `
        const source = require(${JSON.stringify(bundle)}).default;
        const {Worker, MessageChannel} = require('node:worker_threads');
        const udp = require('node:dgram').createSocket('udp4');
        const started = new Int32Array(new SharedArrayBuffer(4));
        const worker = new Worker('const {workerData} = require("node:worker_threads"); Atomics.store(workerData, 0, 1); Atomics.notify(workerData, 0); const end = Date.now() + 6000; while (Date.now() < end) {}', {eval: true, workerData: started});
        const handles = Array.from({length: 1100}, () => new MessageChannel());
        for (const {port1, port2} of handles) {port1.on('message', () => {}); port2.on('message', () => {});}
        udp.connect(9, '169.254.254.254', async () => {
          Atomics.wait(started, 0, 0, 2000);
          if (Atomics.load(started, 0) !== 1) throw new Error('worker never started');
          const start = performance.now();
          const result = await source.observe({command: ['/bin/echo', 'prompt'], timeout: '1s'}, {now: new Date()});
          console.log(JSON.stringify({elapsed: performance.now() - start, result, handles: handles.length * 2}));
          udp.close();
          for (const {port1, port2} of handles) {port1.close(); port2.close();}
          await worker.terminate();
        });
      `,
        dir,
      );
      const receipt = JSON.parse(output);
      expect(receipt.handles).toBeGreaterThan(1000);
      expect(receipt.result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'prompt\n',
      });
      expect(receipt.elapsed).toBeLessThan(1000);
    }, 15_000);

    it.each([
      { soft: '512', hard: 'inherited' },
      { soft: '512', hard: '4096' },
      ...(process.platform === 'darwin'
        ? [
            ...[
              '9007199254740993',
              '9007199254740992',
              '9223372036854775806',
            ].map((hard) => ({ soft: '512', hard })),
            ...[
              '9007199254740993',
              '9007199254740992',
              '9223372036854775806',
            ].map((soft) => ({ soft, hard: soft })),
            { soft: 'unlimited', hard: 'inherited' },
            { soft: '9007199254740993', hard: 'inherited' },
            { soft: '9223372036854775806', hard: 'inherited' },
            { soft: '9007199254740992', hard: '9007199254740993' },
          ]
        : []),
    ])(
      'verifies native resource limits for soft $soft / hard $hard',
      async ({ soft, hard: hardLimit }) => {
        const native = fileURLToPath(
          new URL('../vendor/koffi/load.cjs', import.meta.url),
        );
        const output = await runParent(
          `
      const source = require(${JSON.stringify(bundle)}).default;
      const koffi = require(${JSON.stringify(native)});
      const libc = koffi.load(null);
      const get = libc.func('int getrlimit(int resource, void *value)');
      const set = libc.func('int setrlimit(int resource, const void *value)');
      const nofile = process.platform === 'darwin' ? 8 : 7;
      const value = Buffer.alloc(16);
      if (get(nofile, value) !== 0) throw new Error('fixture getrlimit failed');
      if (${JSON.stringify(hardLimit)} !== 'inherited') value.writeBigUInt64LE(BigInt(${JSON.stringify(hardLimit)}), 8);
      const hard = value.readBigUInt64LE(8).toString();
      value.writeBigUInt64LE(${JSON.stringify(soft)} === 'unlimited' ? (1n << 63n) - 1n : BigInt(${JSON.stringify(soft)}));
      if (set(nofile, value) !== 0) throw new Error('fixture setrlimit failed');
      const nativeSoft = value.readBigUInt64LE().toString();
      const previousState = { stdout: 'baseline', exitCode: 7, truncated: false, health: 'ok', baselined: true };
      const {spawn} = require('node:child_process');
      (async () => {
        const plain = await new Promise((resolve, reject) => {
          const child = spawn(${JSON.stringify(binary)}, [], {detached: true, stdio: ['ignore', 'pipe', 'pipe']});
          let stdout = '';
          child.stdout.on('data', bytes => stdout += bytes);
          child.stderr.resume();
          child.once('error', reject);
          child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error('plain spawn failed: ' + code)));
        });
        // Count only source admission, after the plain-spawn comparison.
        let spawned = 0;
        require('node:child_process').spawn = (...args) => { spawned++; return spawn(...args); };
        const command = [${JSON.stringify(binary)}];
        const bounded = await source.observe({command, timeout: '5s'}, {now: new Date(), previousState});
        console.log(JSON.stringify({platform: process.platform, nofile, nativeSoft, hard, plain, bounded, spawned}));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
          dir,
        );
        const receipt = JSON.parse(output);
        console.log(JSON.stringify(receipt));
        const limits = receipt.plain
          .trim()
          .split('\n')
          .find((row: string) => row.startsWith(`${receipt.nofile} `));
        expect(limits).toBe(
          `${receipt.nofile} ${receipt.nativeSoft} ${receipt.hard}`,
        );
        expect(receipt.spawned).toBe(1);
        expect(receipt.bounded.nextState).toMatchObject({
          health: 'ok',
          exitCode: 0,
          stdout: receipt.plain,
        });
      },
      20_000,
    );
  },
);

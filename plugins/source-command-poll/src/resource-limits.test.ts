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

    it.each(['inherited', '4096'])(
      'matches every plain-spawn soft and hard limit with lowered NOFILE and %s hard limit',
      async (hardLimit) => {
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
      value.writeBigUInt64LE(512n);
      if (set(nofile, value) !== 0) throw new Error('fixture setrlimit failed');
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
        const bounded = await source.observe({command: [${JSON.stringify(binary)}], timeout: '5s'}, {now: new Date()});
        console.log(JSON.stringify({platform: process.platform, nofile, hard, plain, bounded}));
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
        expect(limits).toBe(`${receipt.nofile} 512 ${receipt.hard}`);
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

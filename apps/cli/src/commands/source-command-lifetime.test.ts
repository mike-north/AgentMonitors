/** Built source consumers retain module resolution and finite caller lifetimes. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** Live handles are cleanup authority if a failing observation strands its caller. */
const callers = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of callers) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  callers.clear();
});

describe.skipIf(process.platform === 'win32')(
  'command observation caller lifetime',
  () => {
    it.each(['ESM', 'CJS'])(
      'supports the built %s export from a CommonJS eval caller',
      async (format) => {
        const entry = new URL(
          `../../../../plugins/source-command-poll/dist/index.${format === 'ESM' ? 'js' : 'cjs'}`,
          import.meta.url,
        );
        // CommonJS eval exposes a global [eval] filename. An imported ESM source
        // must still resolve its native dependency relative to its own module URL.
        const load =
          format === 'ESM'
            ? `(await import(${JSON.stringify(entry.href)})).default`
            : `require(${JSON.stringify(fileURLToPath(entry))}).default`;
        const program = `
        (async () => {
          const source = ${load};
          const result = await source.observe({command:['/bin/echo', 'bridge'], timeout:'2s'}, {now:new Date()});
          console.log(JSON.stringify(result.nextState));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `;
        const child = spawn(
          process.execPath,
          ['--input-type=commonjs', '-e', program],
          {
            cwd: tmpdir(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        callers.add(child);
        let output = '';
        let diagnostics = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          diagnostics += chunk.toString();
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        expect(code, diagnostics).toBe(0);
        expect(JSON.parse(output)).toMatchObject({
          stdout: 'bridge\n',
          exitCode: 0,
          health: 'ok',
        });
      },
    );

    it('exits promptly after timeout while the independent watchdog retains its kill grace', async () => {
      const entry = new URL(
        '../../../../plugins/source-command-poll/dist/index.js',
        import.meta.url,
      ).href;
      const program = `
      const source = (await import(${JSON.stringify(entry)})).default;
      const started = performance.now();
      const result = await source.observe({command:[process.execPath,'-e','setInterval(()=>{},1000)'],timeout:'1s'}, {now:new Date()});
      if (result.nextState.health !== 'failing') throw new Error('Expected timeout');
      console.log(JSON.stringify({settled:performance.now()-started}));
    `;
      const started = performance.now();
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', program],
        {
          cwd: tmpdir(),
          // Resolve the built package from this workspace, while command fixtures
          // and their current directory remain inside the owned test namespace.
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      callers.add(child);
      let output = '';
      let diagnostics = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(code, diagnostics).toBe(0);
      const elapsed = performance.now() - started;
      const receipt: { settled: number } = JSON.parse(output);
      expect(receipt.settled).toBeLessThan(2000);
      expect(elapsed - receipt.settled).toBeLessThan(1500);
    }, 10_000);
  },
);

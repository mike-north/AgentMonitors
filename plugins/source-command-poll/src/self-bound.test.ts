/** Self-bounding admission is asynchronous, ordered before user work, and fails closed. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import source, { createCommandPollSource } from './index.js';

import { restoreProcessGlobalsAfterEach } from './global-state.test-support.js';

// Helper fault injection is a module seam: authored NODE_OPTIONS must never
// instrument admission helpers or mutate their timers.
const injected = vi.hoisted(() => ({
  watchdog: '',
  launcher: '',
  replacement: '',
}));
vi.mock('./self-bound.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./self-bound.js')>();
  return {
    ...actual,
    get WATCHDOG_PROGRAM() {
      return injected.watchdog + actual.WATCHDOG_PROGRAM;
    },
    get LAUNCHER_PROGRAM() {
      return (
        injected.replacement || injected.launcher + actual.LAUNCHER_PROGRAM
      );
    },
  };
});
restoreProcessGlobalsAfterEach();
const intervalTimers = new Set<ReturnType<typeof setInterval>>();
afterEach(() => {
  for (const timer of intervalTimers) clearInterval(timer);
  intervalTimers.clear();
  injected.watchdog = '';
  injected.launcher = '';
  injected.replacement = '';
});

describe.skipIf(process.platform === 'win32')(
  'self-bounding command admission',
  () => {
    // Reuse the review's real fd-5 fault cases at the maintained helper seam.
    // A prior successful result must survive every incomplete admission protocol.
    it.each([
      [
        'truncated frame',
        '{"kind":"armed"}\n{"kind":"error","error":"incomplete',
      ],
      [
        'invalid error schema',
        '{"kind":"armed"}\n{"kind":"error","error":42}\n',
      ],
      ['unknown frame', '{"kind":"armed"}\n{"kind":"unexpected"}\n'],
      ['invalid armed schema', '{"kind":"armed","error":42}\n'],
      ['null frame', '{"kind":"armed"}\nnull\n'],
      ['missing frame', ''],
    ])('retains the baseline after %s', async (_name, payload) => {
      injected.replacement = `require('node:fs').readFile(4, () => {
        require('node:fs').write(5, ${JSON.stringify(payload)}, () => process.exit(1));
      });`;
      const previousState = {
        stdout: 'good-baseline',
        exitCode: 7,
        truncated: false,
        health: 'ok',
        baselined: true,
      };
      const result = await source.observe(
        { command: ['/bin/echo', 'unused'], timeout: '2s' },
        { now: new Date(), previousState },
      );
      expect(result.nextState).toEqual({ ...previousState, health: 'failing' });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringMatching(/acknowledgement|status/),
      });
    });

    it('accepts a valid armed frame split across separate reads', async () => {
      injected.replacement = `require('node:fs').readFile(4, () => {
        const fs = require('node:fs');
        fs.write(5, '{"ki', () => setTimeout(() => fs.write(5, 'nd":"armed"}\\n', () => process.exit(7)), 20));
      });`;
      const result = await source.observe(
        { command: ['/bin/echo', 'unused'], timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: '',
        exitCode: 7,
      });
    });

    it.each(['error', 'armed'])(
      'writes the complete %s frame after short writes',
      async (kind) => {
        // The original review shortened the error to 24 bytes. Support both write
        // overloads so this exercises actual partial I/O after the writer is fixed.
        injected.launcher = `const originalWrite = require('node:fs').write;
        require('node:fs').write = (fd, data, ...args) => {
          const callback = args.at(-1);
          const bytes = Buffer.isBuffer(data) ? data.subarray(args[0], args[0] + args[1]) : Buffer.from(data);
          const short = fd === 5 && (${JSON.stringify(kind)} === 'armed' || bytes.includes(Buffer.from('"kind":"error"')));
          return originalWrite(fd, short ? bytes.subarray(0, ${kind === 'error' ? 24 : 4}) : bytes, callback);
        };`;
        const dir = mkdtempSync(path.join(tmpdir(), 'short-'));
        const file = path.join(dir, 'bad');
        writeFileSync(file, '#!/missing-review-624-interpreter\n', {
          mode: 0o700,
        });
        const previousState = {
          stdout: 'good-baseline',
          exitCode: 7,
          truncated: false,
          health: 'ok',
          baselined: true,
        };
        const result = await source.observe(
          {
            command: kind === 'error' ? [file] : ['/bin/echo', 'complete'],
            timeout: '2s',
          },
          { now: new Date(), previousState },
        );
        expect(result.nextState).toMatchObject(
          kind === 'error'
            ? { ...previousState, health: 'failing' }
            : { stdout: 'complete\n', exitCode: 0, health: 'ok' },
        );
        if (kind === 'error')
          expect(result.observations[0]?.payload).toMatchObject({
            error: expect.stringContaining('ENOENT'),
          });
      },
    );

    it.each(['zero', 'error'])(
      'retains the baseline when the error frame write makes %s progress',
      async (fault) => {
        // A completely lost error frame must not turn the helper's own exit into
        // an authored exit-code result after a valid armed acknowledgement.
        injected.launcher = `const originalWrite = require('node:fs').write;
        require('node:fs').write = (fd, data, ...args) => {
          if (fd === 5 && Buffer.from(data).includes(Buffer.from('"kind":"error"'))) {
            const callback = args.at(-1);
            process.nextTick(() => callback(${fault === 'error' ? "new Error('fixture: status unavailable')" : 'null'}, 0));
            return;
          }
          return originalWrite(fd, data, ...args);
        };`;
        const dir = mkdtempSync(path.join(tmpdir(), 'lost-'));
        const file = path.join(dir, 'bad');
        writeFileSync(file, '#!/missing-review-624-interpreter\n', {
          mode: 0o700,
        });
        const previousState = {
          stdout: 'good-baseline',
          exitCode: 7,
          truncated: false,
          health: 'ok',
          baselined: true,
        };
        const result = await source.observe(
          { command: [file], timeout: '2s' },
          { now: new Date(), previousState },
        );
        expect(result.nextState).toEqual({
          ...previousState,
          health: 'failing',
        });
      },
    );

    it('explains native support load failure and retains its underlying detail', async () => {
      injected.launcher = `const originalLoad = require('node:module')._load;
        require('node:module')._load = function(id, ...args) {
          if (id.includes('koffi')) throw new Error('Cannot find the native Koffi module; did you bundle it correctly?');
          return originalLoad.call(this, id, ...args);
        };`;
      const result = await source.observe(
        { command: ['/bin/echo', 'unused'], timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'failing',
        baselined: false,
      });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining(
          'Native exec support for this platform could not be loaded',
        ),
      });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining('Cannot find the native Koffi module'),
      });
    });

    it('arms without PATH utilities and preserves literal argv, exit status, and command PID', async () => {
      process.env.PATH = '/does-not-exist';
      let recorded: number | undefined;
      const owned = createCommandPollSource({
        environment: async () => ({ AGENTMONITORS_COMMAND_LIFE: 'bound-test' }),
        spawned: (pid) => {
          recorded = pid;
        },
        exited: () => {
          /* This fixture has no persistent numeric hints to retire. */
        },
      });
      const result = await owned.observe(
        {
          command: [
            process.execPath,
            '-e',
            'process.stdout.write(JSON.stringify({pid:process.pid,argv:process.argv.slice(1),mark:process.env.AGENTMONITORS_COMMAND_LIFE}));process.exit(7)',
            '$(touch forbidden); *',
          ],
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({ health: 'ok', exitCode: 7 });
      const state = result.nextState as { stdout: string };
      expect(JSON.parse(state.stdout)).toEqual({
        pid: recorded,
        argv: ['$(touch forbidden); *'],
        mark: 'bound-test',
      });
    });

    it('executes a PATH command whose filename begins with a shell option', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bound-option-name-'));
      writeFileSync(path.join(dir, '-n'), '#!/bin/sh\nprintf \'%s\' "$1"\n', {
        mode: 0o700,
      });
      const result = await source.observe(
        { command: ['-n', 'literal'], env: { PATH: dir }, timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'literal',
        exitCode: 0,
      });
    });

    // Kernel traversal of symlink/.. must choose the same executable as spawn.
    it.each(['explicit', 'PATH'])(
      'preserves symlink traversal in %s executable names',
      async (lookup) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'bound-link-'));
        mkdirSync(path.join(dir, 'target', 'nested'), { recursive: true });
        symlinkSync('target/nested', path.join(dir, 'alias'));
        writeFileSync(path.join(dir, 'probe'), '#!/bin/sh\nprintf wrong', {
          mode: 0o700,
        });
        writeFileSync(
          path.join(dir, 'target', 'probe'),
          '#!/bin/sh\nprintf intended',
          { mode: 0o700 },
        );
        const result = await source.observe(
          {
            command: [lookup === 'explicit' ? './alias/../probe' : 'probe'],
            cwd: dir,
            env: { PATH: './alias/..' },
            timeout: '2s',
          },
          { now: new Date() },
        );
        expect(result.nextState).toMatchObject({
          health: 'ok',
          stdout: 'intended',
          exitCode: 0,
        });
      },
    );

    it('preserves the good baseline when the executable has a missing shebang interpreter', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bound-exec-'));
      const file = path.join(dir, 'probe');
      writeFileSync(file, '#!/missing-review-624-interpreter\n', {
        mode: 0o700,
      });
      const previousState = {
        stdout: 'good-baseline',
        exitCode: 7,
        truncated: false,
        health: 'ok',
        baselined: true,
      };
      const result = await source.observe(
        { command: [file], cwd: dir, timeout: '2s' },
        { now: new Date(), previousState },
      );
      expect(result.nextState).toMatchObject({
        ...previousState,
        health: 'failing',
      });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining('ENOENT'),
      });
    });

    it.each(['authored', 'inherited'])(
      'pins helper module mode with %s NODE_OPTIONS while retaining command mode',
      async (origin) => {
        if (origin === 'inherited')
          process.env.NODE_OPTIONS = '--input-type=module';
        const env =
          origin === 'authored' ? { NODE_OPTIONS: '--input-type=module' } : {};
        for (const command of [
          [
            process.execPath,
            '-e',
            'export {}; process.stdout.write("module-ok")',
          ],
          ['/bin/echo', 'native-ok'],
        ]) {
          const result = await source.observe(
            { command, env, timeout: '2s' },
            { now: new Date() },
          );
          expect(result.nextState).toMatchObject({
            health: 'ok',
            stdout:
              command[0] === process.execPath ? 'module-ok' : 'native-ok\n',
            exitCode: 0,
          });
        }
      },
    );

    it('passes every authored environment value through without shell rewrites', async () => {
      const env = {
        PWD: 'authored-value',
        OLDPWD: 'old-value',
        SHLVL: '47',
        IFS: 'literal-ifs',
        PS1: 'literal-prompt',
        _: 'literal-underscore',
        'fixture-key': 'literal-value',
      };
      const result = await source.observe(
        {
          command: [
            process.execPath,
            '-e',
            'process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(key => [key, process.env[key]]))))',
            JSON.stringify(Object.keys(env)),
          ],
          env,
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({ health: 'ok', exitCode: 0 });
      expect(
        JSON.parse((result.nextState as { stdout: string }).stdout),
      ).toEqual(env);
    });

    it('keeps the native execution clock when a host virtualizes its scheduling clock', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const result = await source.observe(
        {
          command: [
            process.execPath,
            '-e',
            'process.stdout.write("native-clock")',
          ],
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'native-clock',
        exitCode: 0,
      });
    });

    it('finishes promptly when command output closes while the watchdog channel stays open', async () => {
      const started = performance.now();
      const result = await source.observe(
        {
          command: [process.execPath, '-e', 'process.stdout.write("fast")'],
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({ health: 'ok', stdout: 'fast' });
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('keeps the event loop responsive while command admission is pending', async () => {
      let turns = 0;
      const timer = setInterval(() => {
        turns++;
      }, 1);
      intervalTimers.add(timer);
      try {
        const pending = source.observe(
          {
            command: [process.execPath, '-e', 'process.stdout.write("done")'],
            timeout: '2s',
          },
          { now: new Date() },
        );
        const before = turns;
        const result = await pending;
        expect(turns - before).toBeGreaterThan(0);
        expect(result.nextState).toMatchObject({
          stdout: 'done',
          health: 'ok',
        });
      } finally {
        clearInterval(timer);
      }
    });

    it('contains no synchronous subprocess or filesystem arming operation on observe', () => {
      // Check shipped admission code rather than a mocked successful execution: a
      // fast synchronous mkfifo/open would evade a coarse wall-clock measurement.
      const implementation = readFileSync(
        new URL('./index.ts', import.meta.url),
        'utf8',
      );
      expect(implementation).not.toMatch(
        /\b(?:execFileSync|execSync|spawnSync|openSync|mkfifo)\b/,
      );
      expect(
        readFileSync(new URL('./self-bound.ts', import.meta.url), 'utf8'),
      ).not.toMatch(/\b(?:execFileSync|execSync|spawnSync|openSync|mkfifo)\b/);
    });

    it('waits for watchdog timer registration before running authored work', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bound-order-'));
      const armed = path.join(dir, 'armed');
      injected.watchdog = `
        const original = global.setTimeout;
        global.setTimeout = (...args) => {
          const timer = original(...args);
          require('node:fs').writeFileSync(${JSON.stringify(armed)}, 'armed');
          return timer;
        };
      `;
      const result = await source.observe(
        {
          command: ['/bin/sh', '-c', `test -f '${armed}' && printf ordered`],
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'ordered',
        exitCode: 0,
      });
    });

    it('fails closed when the watchdog cannot register its timer', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bound-arm-fail-'));
      const marker = path.join(dir, 'ran');
      injected.watchdog = `global.setTimeout = () => { throw new Error('fixture: timer unavailable'); };`;
      const result = await source.observe(
        {
          command: ['/bin/sh', '-c', `echo ran > '${marker}'`],
          timeout: '1s',
        },
        { now: new Date() },
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.nextState).toMatchObject({
        health: 'failing',
        baselined: false,
      });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining('fixture: timer unavailable'),
      });
    });

    it('rejects an admission aborted while durable ownership is being acquired', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bound-cancel-'));
      const marker = path.join(dir, 'ran');
      const shutdown = new AbortController();
      let admit: ((value: Record<string, string>) => void) | undefined;
      const owned = createCommandPollSource(
        {
          environment: () =>
            new Promise((resolve) => {
              admit = resolve;
            }),
          spawned: () => {
            throw new Error('An aborted admission must not spawn');
          },
          exited: () => {
            /* This fixture has no persistent numeric hints to retire. */
          },
        },
        shutdown.signal,
      );
      const pending = owned.observe(
        { command: ['/bin/sh', '-c', `echo ran > '${marker}'`], timeout: '1s' },
        { now: new Date() },
      );
      shutdown.abort();
      expect(admit).toBeDefined();
      admit?.({ AGENTMONITORS_COMMAND_LIFE: 'cancelled' });
      const result = await pending;
      expect(existsSync(marker)).toBe(false);
      expect(result.nextState).toMatchObject({
        health: 'failing',
        baselined: false,
      });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining('shutdown'),
      });
    });

    it('does not run an authored command when launcher startup fails', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bound-fail-'));
      const marker = path.join(dir, 'ran');
      injected.launcher = `throw new Error('fixture: launcher unavailable');`;
      const result = await source.observe(
        {
          command: ['/bin/sh', '-c', `echo ran > '${marker}'`],
          timeout: '1s',
        },
        { now: new Date() },
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.nextState).toMatchObject({
        health: 'failing',
        baselined: false,
      });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringMatching(/bound|arm|launch/i),
      });
    });
  },
);

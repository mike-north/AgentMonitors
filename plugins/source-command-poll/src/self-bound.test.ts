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

restoreProcessGlobalsAfterEach();
const intervalTimers = new Set<ReturnType<typeof setInterval>>();
afterEach(() => {
  for (const timer of intervalTimers) clearInterval(timer);
  intervalTimers.clear();
});

describe.skipIf(process.platform === 'win32')(
  'self-bounding command admission',
  () => {
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
        error: expect.stringContaining('SIGABRT'),
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
      const preload = path.join(dir, 'timer-proof.cjs');
      writeFileSync(
        preload,
        `
      if (process.argv[1] && !JSON.parse(process.argv[1]).command) {
        const original = global.setTimeout;
        global.setTimeout = (...args) => {
          const timer = original(...args);
          require('node:fs').writeFileSync(${JSON.stringify(armed)}, 'armed');
          return timer;
        };
      }
    `,
      );
      const result = await source.observe(
        {
          command: ['/bin/sh', '-c', `test -f '${armed}' && printf ordered`],
          env: { NODE_OPTIONS: '--require=' + preload },
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
      const preload = path.join(dir, 'break-timer.cjs');
      writeFileSync(
        preload,
        `
      if (process.argv[1] && !JSON.parse(process.argv[1]).command) {
        global.setTimeout = () => { throw new Error('fixture: timer unavailable'); };
      }
    `,
      );
      const result = await source.observe(
        {
          command: ['/bin/sh', '-c', `echo ran > '${marker}'`],
          env: { NODE_OPTIONS: '--require=' + preload },
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
      const result = await source.observe(
        {
          command: ['/bin/sh', '-c', `echo ran > '${marker}'`],
          env: { NODE_OPTIONS: `--require=${path.join(dir, 'missing.cjs')}` },
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

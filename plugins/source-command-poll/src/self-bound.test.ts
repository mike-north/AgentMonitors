/** Self-bounding admission is asynchronous, ordered before user work, and fails closed. */
import { spawnSync } from 'node:child_process';
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
    it('admits an environment near the plain-spawn byte limit', async () => {
      // Darwin permits one near-ARG_MAX value; Linux also caps each string.
      // Discover the local limit with the exact authored argv, then reserve only
      // a small margin: embedded helper programs must not consume that budget.
      const environment = (bytes: number): Record<string, string> => {
        const env: Record<string, string> = {};
        for (let i = 0; bytes > 0; i++) {
          const length = Math.min(bytes, 60_000);
          env[`BOUND_ENV_${i}`] = 'x'.repeat(length);
          bytes -= length;
        }
        return env;
      };
      let low = 0;
      let high = 3_000_000;
      while (low + 1 < high) {
        const bytes = Math.floor((low + high) / 2);
        const direct = spawnSync('/bin/echo', ['okay'], {
          env: { ...process.env, ...environment(bytes) },
          encoding: 'utf8',
        });
        if (direct.status === 0) low = bytes;
        else {
          expect(direct.error).toMatchObject({ code: 'E2BIG' });
          high = bytes;
        }
      }
      const env = environment(low - 256);
      expect(
        spawnSync('/bin/echo', ['okay'], {
          env: { ...process.env, ...env },
          encoding: 'utf8',
        }).stdout,
      ).toBe('okay\n');
      const result = await source.observe(
        { command: ['/bin/echo', 'okay'], env, timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'okay\n',
        exitCode: 0,
      });
    });

    it('keeps authored and unrelated inherited values out of both helpers startup environments', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'env-'));
      const capture = (name: string) =>
        `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, name))}, JSON.stringify(process.env));`;
      injected.launcher = capture('launcher');
      injected.watchdog = capture('watchdog');
      process.env.BOUND_INHERITED = 'inherited-only';
      const env = {
        BOUND_AUTHORED: 'authored-only',
        NODE_OPTIONS: '--input-type=commonjs',
        PATH: '/authored-path',
        HOME: '/authored-home',
        TMPDIR: '/authored-tmp',
      };
      const owned = createCommandPollSource({
        environment: async () => ({
          AGENTMONITORS_COMMAND_LIFE: 'environment-test',
        }),
        spawned: () => {
          /* This environment fixture does not persist numeric hints. */
        },
        exited: () => {
          /* There are no persisted hints to retire in this fixture. */
        },
      });
      const result = await owned.observe(
        {
          command: [
            process.execPath,
            '-e',
            'process.stdout.write(JSON.stringify(process.env))',
          ],
          env,
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({ health: 'ok', exitCode: 0 });
      expect(
        JSON.parse((result.nextState as { stdout: string }).stdout),
      ).toMatchObject({
        ...env,
        BOUND_INHERITED: 'inherited-only',
        AGENTMONITORS_COMMAND_LIFE: 'environment-test',
      });
      for (const helper of ['launcher', 'watchdog']) {
        const startup = JSON.parse(
          readFileSync(path.join(dir, helper), 'utf8'),
        );
        // Darwin's runtime can synthesize this key even when spawn omits it.
        if (process.platform === 'darwin')
          delete startup.__CF_USER_TEXT_ENCODING;
        // Reject unexpected keys before comparing values, so a regression never
        // prints unrelated inherited environment contents into a test receipt.
        expect(Object.keys(startup)).toEqual(['AGENTMONITORS_COMMAND_LIFE']);
        expect(startup).toEqual({
          AGENTMONITORS_COMMAND_LIFE: 'environment-test',
        });
      }
    });

    it('lets commands reap all their children without waiting for the watchdog', async (context) => {
      // Perl provides POSIX wait() on both CI platforms without a C compiler.
      const program = '1 while wait() != -1; print "done\\n"';
      const direct = spawnSync('perl', ['-e', program], { encoding: 'utf8' });
      if (
        direct.error &&
        'code' in direct.error &&
        direct.error.code === 'ENOENT'
      ) {
        context.skip();
        return;
      }
      expect(direct.status).toBe(0);
      expect(direct.stdout).toBe('done\n');
      const started = performance.now();
      const result = await source.observe(
        { command: ['perl', '-e', program], timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'done\n',
        exitCode: 0,
      });
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('reparents the marked watchdog within the original group before authored exec', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'parent-'));
      const file = path.join(dir, 'watchdog');
      injected.watchdog = `require('node:fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({pid: process.pid, ppid: process.ppid, mark: process.env.AGENTMONITORS_COMMAND_LIFE}));`;
      const result = await source.observe(
        {
          command: [
            process.execPath,
            '-e',
            `
          const start = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8'));
          const table = require('node:child_process').spawnSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=', '-p', [process.pid, start.pid, start.ppid].join(',')], {encoding: 'utf8'});
          process.stdout.write(JSON.stringify({pid:process.pid, start, table:table.stdout}));
        `,
          ],
          env: { AGENTMONITORS_COMMAND_LIFE: 'reparent-test' },
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({ health: 'ok', exitCode: 0 });
      const captured: {
        pid: number;
        start: { pid: number; ppid: number; mark: string };
        table: string;
      } = JSON.parse((result.nextState as { stdout: string }).stdout);
      expect(captured.start.mark).toBe('reparent-test');
      expect(captured.start.ppid).not.toBe(captured.pid);
      const rows = captured.table
        .trim()
        .split('\n')
        .map((row) => row.trim().split(/\s+/).map(Number));
      // The intermediate was reaped; only the command and its reparented peer
      // remain. Membership, rather than a parent-child edge, pins the group.
      expect(rows.map((row) => row[0]).sort()).toEqual(
        [captured.pid, captured.start.pid].sort(),
      );
      const watchdog = rows.find((row) => row[0] === captured.start.pid);
      expect(watchdog?.[1]).not.toBe(captured.pid);
      expect(watchdog?.[2]).toBe(captured.pid);
    });

    it.each(['missing acknowledgement', 'failed exit'])(
      'refuses execution after watchdog parent %s',
      async (fault) => {
        // Replace only the intermediate. A message alone cannot authorize exec:
        // the parent must also be reaped with a successful exit status.
        injected.launcher = `const originalSpawn = require('node:child_process').spawn;
          require('node:child_process').spawn = (file, args, options) => {
            if (args[2].includes('parentWatchdog')) args[2] = ${JSON.stringify(fault === 'failed exit' ? 'process.send("armed", () => process.exit(1));' : 'process.exit(0);')};
            return originalSpawn(file, args, options);
          };`;
        const previousState = {
          stdout: 'baseline',
          exitCode: 7,
          truncated: false,
          health: 'ok',
          baselined: true,
        };
        const result = await source.observe(
          { command: ['/bin/echo', 'must-not-run'], timeout: '2s' },
          { now: new Date(), previousState },
        );
        expect(result.nextState).toEqual({
          ...previousState,
          health: 'failing',
        });
        expect(result.observations[0]?.payload).toMatchObject({
          error: expect.stringContaining(
            'Watchdog parent exited before acknowledged reparenting',
          ),
        });
      },
    );

    it('consumes the intermediate IPC acknowledgement even if its reaped exit arrives first', async () => {
      // waitpid and IPC are independent readiness sources. Deliver their real
      // events in the opposite order, retaining the eventual channel close.
      injected.launcher = `const originalSpawn = require('node:child_process').spawn;
        require('node:child_process').spawn = (...args) => {
          const child = originalSpawn(...args);
          const originalEmit = child.emit;
          let message;
          child.emit = function(event, ...values) {
            if (event === 'message') { message = values; return true; }
            const result = originalEmit.call(this, event, ...values);
            if (event === 'exit' && message) originalEmit.call(this, 'message', ...message);
            return result;
          };
          return child;
        };`;
      const result = await source.observe(
        { command: ['/bin/echo', 'ordered'], timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'ordered\n',
        exitCode: 0,
      });
    });

    it('reports native initialization stack failures without mislabelling them as module loading failures', async () => {
      injected.launcher = `const originalLoad = require('node:module')._load;
        require('node:module')._load = function(id, ...args) {
          const loaded = originalLoad.call(this, id, ...args);
          if (!id.includes('koffi')) return loaded;
          return {...loaded, load() {throw new RangeError('Maximum call stack size exceeded');}};
        };`;
      const previousState = {
        stdout: 'baseline',
        exitCode: 0,
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
        error:
          'Could not arm command lifetime bound: Maximum call stack size exceeded',
      });
    });

    it('clears native close-on-exec flags on every command standard stream', async () => {
      // Prime real helper descriptors, then inspect them at the native exec
      // boundary. A separate variadic binding makes this an ABI regression,
      // rather than trusting the launcher's own declaration or return code.
      injected.launcher = `const originalLoad = require('node:module')._load;
        require('node:module')._load = function(id, ...args) {
          const loaded = originalLoad.call(this, id, ...args);
          if (!id.includes('koffi')) return loaded;
          return {...loaded, load(...loadArgs) {
            const library = loaded.load(...loadArgs);
            const nativeFcntl = library.func('int fcntl(int fd, int cmd, ...)');
            const F_GETFD = 1, F_SETFD = 2, FD_CLOEXEC = 1;
            for (const fd of [0, 1, 2]) {
              if (nativeFcntl(fd, F_SETFD, 'int', FD_CLOEXEC) !== 0 || nativeFcntl(fd, F_GETFD) !== FD_CLOEXEC)
                throw new Error('fixture: could not prime close-on-exec');
            }
            return {...library, func(declaration) {
              const native = library.func(declaration);
              if (!declaration.includes(' execve(') && !declaration.includes(' execvpe(')) return native;
              return (...execArgs) => {
                for (const fd of [0, 1, 2]) {
                  if (nativeFcntl(fd, F_GETFD) !== 0) throw new Error('fixture: close-on-exec survived for fd ' + fd);
                }
                return native(...execArgs);
              };
            }};
          }};
        };`;
      const result = await source.observe(
        {
          command: [
            process.execPath,
            '-e',
            'const fs = require("node:fs"); fs.writeSync(1, "stdout"); fs.writeSync(2, "stderr"); process.exit(7)',
          ],
          timeout: '2s',
        },
        { now: new Date() },
      );
      expect(result.observations).toEqual([]);
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'stdout',
        exitCode: 7,
      });
    });

    it('restores blocking stdio while preserving other native status flags', async () => {
      // A real variadic binding primes every standard descriptor. Inspect at
      // exec so neither the launcher nor the authored interpreter can hide drift.
      injected.launcher = `const originalLoad = require('node:module')._load;
        require('node:module')._load = function(id, ...args) {
          const loaded = originalLoad.call(this, id, ...args);
          if (!id.includes('koffi')) return loaded;
          return {...loaded, load(...args) {
            const library = loaded.load(...args);
            const fcntl = library.func('int fcntl(int fd, int cmd, ...)');
            const nonblock = process.platform === 'darwin' ? 4 : 2048;
            const append = process.platform === 'darwin' ? 8 : 1024;
            return {...library, func(declaration) {
              const native = library.func(declaration);
              if (declaration.includes(' fcntl(')) return (fd, cmd, ...args) => {
                if (fd <= 2 && cmd === 2 && fcntl(fd, 4, 'int', fcntl(fd, 3) | nonblock | append) === -1)
                  throw new Error('fixture: could not prime status flags');
                return native(fd, cmd, ...args);
              };
              if (!declaration.includes(' execve(') && !declaration.includes(' execvpe(')) return native;
              return (...args) => {
                for (const fd of [0, 1, 2]) {
                  const flags = fcntl(fd, 3);
                  if (flags === -1 || (flags & nonblock) !== 0 || (flags & append) === 0)
                    throw new Error('fixture: wrong status flags for fd ' + fd);
                }
                return native(...args);
              };
            }};
          }};
        };`;
      const result = await source.observe(
        { command: ['/bin/echo', 'blocking'], timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: 'blocking\n',
        exitCode: 0,
      });
    });

    it.each([
      'set error',
      'get error',
      'flag retained',
      'status get error',
      'status set error',
      'status read-back error',
      'nonblock retained',
    ])(
      'retains the baseline and refuses execution after stdio %s',
      async (fault) => {
        // Fault only the admission binding. No authored work may run when the
        // kernel rejects a flag operation or stdio would close or stay nonblocking.
        injected.launcher = `const originalLoad = require('node:module')._load;
          require('node:module')._load = function(id, ...args) {
            const loaded = originalLoad.call(this, id, ...args);
            if (!id.includes('koffi')) return loaded;
            return {...loaded, load(...loadArgs) {
              const library = loaded.load(...loadArgs);
              return {...library, func(declaration) {
                const native = library.func(declaration);
                if (!declaration.includes(' fcntl(')) return native;
                let statusReads = 0;
                return (fd, cmd, ...flags) => {
                  if (fd === 1) {
                    if (cmd === 3) {
                      statusReads++;
                      if (${JSON.stringify(fault)} === 'status get error') return -1;
                      if (${JSON.stringify(fault)} === 'status read-back error' && statusReads === 2) return -1;
                      if (${JSON.stringify(fault)} === 'nonblock retained' && statusReads === 2) return process.platform === 'darwin' ? 4 : 2048;
                    }
                    if (cmd === 4 && ${JSON.stringify(fault)} === 'status set error') return -1;
                    if (cmd === 2 && ${JSON.stringify(fault)} === 'set error') return -1;
                    if (cmd === 1 && ${JSON.stringify(fault)} === 'get error') return -1;
                    if (cmd === 1 && ${JSON.stringify(fault)} === 'flag retained') return 1;
                  }
                  return native(fd, cmd, ...flags);
                };
              }};
            }};
          };`;
        const dir = mkdtempSync(path.join(tmpdir(), 'stdio-'));
        const marker = path.join(dir, 'ran');
        const previousState = {
          stdout: 'good-baseline',
          exitCode: 7,
          truncated: false,
          health: 'ok',
          baselined: true,
        };
        const result = await source.observe(
          {
            command: [
              process.execPath,
              '-e',
              'require("node:fs").writeFileSync(process.argv[1], "ran")',
              marker,
            ],
            timeout: '2s',
          },
          { now: new Date(), previousState },
        );
        expect(existsSync(marker)).toBe(false);
        expect(result.nextState).toEqual({
          ...previousState,
          health: 'failing',
        });
        expect(result.observations[0]?.payload).toMatchObject({
          error: expect.stringContaining('Could not retain command stdio'),
        });
      },
    );

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

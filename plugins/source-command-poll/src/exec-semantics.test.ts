/** Authored programs have native spawn signal state, exec errors, and environment. */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import source, { createCommandPollSource } from './index.js';
import { restoreProcessGlobalsAfterEach } from './global-state.test-support.js';

restoreProcessGlobalsAfterEach();

/** Capture a main-process spawn as the behavioral control, including native errors. */
async function plain(command: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  return new Promise<{
    stdout: string;
    code: number | null;
    signal: string | null;
    error?: string;
  }>((resolve) => {
    let stdout = '';
    const child = spawn(command[0] ?? '', command.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once('error', (error: NodeJS.ErrnoException) =>
      resolve({ stdout, code: null, signal: null, error: error.code }),
    );
    child.once('close', (code, signal) => resolve({ stdout, code, signal }));
  });
}

/** Kernel-level state probe: inspect every signal, rather than guessing Node's defaults. */
const SIGNAL_PROBE = String.raw`
#include <signal.h>
#include <stdio.h>
int main(void) {
  sigset_t mask;
  sigprocmask(SIG_SETMASK, NULL, &mask);
  for (int s = 1; s < NSIG; ++s) {
    struct sigaction a;
    if (sigaction(s, NULL, &a) == 0)
      printf("%d:%d:%d:%d\n", s, a.sa_handler == SIG_IGN, a.sa_handler != SIG_DFL && a.sa_handler != SIG_IGN, sigismember(&mask, s));
  }
#ifdef __linux__
  FILE *f = fopen("/proc/self/status", "r");
  char line[1024];
  while (fgets(line, sizeof(line), f))
    if (line[0]=='S' && line[1]=='i' && line[2]=='g' && (line[3]=='I' || line[3]=='B' || line[3]=='C')) fputs(line, stdout);
  fclose(f);
#endif
  return 0;
}
`;

const previousState = {
  stdout: 'good-baseline',
  exitCode: 7,
  truncated: false,
  health: 'ok',
  baselined: true,
};

describe.skipIf(process.platform === 'win32')(
  'native command execution semantics',
  () => {
    it.each(['PIPE', 'XFSZ'])(
      'retains native %s signal failure semantics',
      async (signal) => {
        const command = ['/bin/sh', '-c', `kill -s ${signal} $$; printf alive`];
        const cwd = mkdtempSync(path.join(tmpdir(), 'signal-'));
        expect((await plain(command, cwd)).signal).toBe('SIG' + signal);
        const result = await source.observe(
          { command, cwd, timeout: '2s' },
          { now: new Date(), previousState },
        );
        expect(result.nextState).toEqual({
          ...previousState,
          health: 'failing',
        });
        expect(result.observations[0]?.payload).toMatchObject({
          error: expect.stringContaining('SIG' + signal),
        });
      },
    );

    it('retains the native pipefail exit status', async () => {
      const command = ['/bin/bash', '-o', 'pipefail', '-c', 'yes | head -n 1'];
      const control = await plain(command);
      expect(control.code).toBe(141);
      const result = await source.observe(
        { command, timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        stdout: control.stdout,
        exitCode: control.code,
        health: 'ok',
      });
    });

    it('matches every native signal disposition and mask bit after exec', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'sig-'));
      const file = path.join(dir, 'probe.c');
      const binary = path.join(dir, 'probe');
      writeFileSync(file, SIGNAL_PROBE);
      execFileSync('/usr/bin/cc', [file, '-o', binary]);
      const control = await plain([binary]);
      // A successful Node exec exposes startup ignores/mask without introducing
      // an exec-error fixture or an authored shell. Compare that inherited state
      // with both libuv's spawn and the bounded native handoff in hosted logs.
      const nodeExec = await plain([
        process.execPath,
        '--disable-warning=ExperimentalWarning',
        '-e',
        'process.execve(process.argv[1], [process.argv[1]], process.env)',
        binary,
      ]);
      expect(nodeExec.code).toBe(0);
      const result = await source.observe(
        { command: [binary], timeout: '2s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        stdout: control.stdout,
        exitCode: 0,
      });
      // Retain both complete comparisons in test output for native macOS/Linux receipts.
      console.log(
        JSON.stringify({
          platform: process.platform,
          plain: control.stdout,
          nodeExec: nodeExec.stdout,
          bounded: result.nextState,
        }),
      );
    });

    it.each(['argument', 'environment'])(
      'rejects a NUL in an %s without truncation or a new baseline',
      async (location) => {
        const command = [
          '/bin/echo',
          location === 'argument' ? 'a\0b' : 'would-run',
        ];
        const env = location === 'environment' ? { NODE_OPTIONS: 'a\0b' } : {};
        expect(() =>
          spawn(command[0] ?? '', command.slice(1), {
            env: { ...process.env, ...env },
          }),
        ).toThrow(/null bytes/);
        const result = await source.observe(
          { command, env, timeout: '2s' },
          { now: new Date(), previousState },
        );
        expect(result.nextState).toEqual({
          ...previousState,
          health: 'failing',
        });
        expect(result.observations[0]?.payload).toMatchObject({
          error: expect.stringContaining('null bytes'),
        });
      },
    );

    it.each(['ENOENT', 'ENOEXEC', 'EACCES', 'E2BIG'])(
      'reports %s without abort artifacts and keeps the baseline',
      async (errno) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'exec-'));
        const file = path.join(dir, 'program');
        writeFileSync(
          file,
          errno === 'ENOENT'
            ? '#!/missing-review-624-interpreter\n'
            : 'invalid executable\n',
          { mode: errno === 'EACCES' ? 0o600 : 0o700 },
        );
        const reports = path.join(
          userInfo().homedir,
          'Library/Logs/DiagnosticReports',
        );
        const before = new Set(
          process.platform === 'darwin' && existsSync(reports)
            ? readdirSync(reports)
            : [],
        );
        let pid: number | undefined;
        const owned = createCommandPollSource({
          environment: async () => ({
            AGENTMONITORS_COMMAND_LIFE: 'exec-error-fixture',
          }),
          spawned: (value) => {
            pid = value;
          },
          exited: () => {
            /* Numeric hints are not persisted in this fixture. */
          },
        });
        const result = await owned.observe(
          {
            command:
              errno === 'E2BIG'
                ? ['/bin/echo', 'x'.repeat(3 * 1024 * 1024)]
                : [file],
            cwd: dir,
            timeout: '2s',
          },
          { now: new Date(), previousState },
        );
        expect(result.nextState).toEqual({
          ...previousState,
          health: 'failing',
        });
        const diagnostic = result.observations[0]?.payload;
        expect(diagnostic).toMatchObject({
          error: expect.stringContaining(errno),
        });
        expect(diagnostic).toMatchObject({
          error: expect.stringContaining(
            errno === 'E2BIG' ? '/bin/echo' : file,
          ),
        });
        expect(JSON.stringify(diagnostic)).not.toMatch(
          /SIGABRT|node::Execve|native stack/i,
        );
        expect(existsSync(path.join(dir, 'core'))).toBe(false);
        expect(existsSync(path.join(dir, 'core.' + String(pid)))).toBe(false);
        if (process.platform === 'darwin' && existsSync(reports)) {
          // Read only a PID metadata prefix of new Node candidates for attribution;
          // never inspect an unrelated report body or delete any crash report.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const own = readdirSync(reports)
            .filter(
              (name) =>
                !before.has(name) &&
                name.startsWith('node-') &&
                name.endsWith('.ips'),
            )
            .filter((name) => {
              const fd = openSync(path.join(reports, name), 'r');
              const prefix = Buffer.alloc(4096);
              let metadata: string;
              try {
                metadata = prefix
                  .subarray(0, readSync(fd, prefix, 0, prefix.length, 0))
                  .toString('utf8');
              } finally {
                closeSync(fd);
              }
              return new RegExp(
                '"pid"\\s*:\\s*' + String(pid) + '[,\\s}]',
              ).test(metadata);
            });
          console.log(
            JSON.stringify({
              errno,
              pid,
              error: diagnostic?.error,
              crashReports: own,
            }),
          );
          expect(own).toEqual([]);
        }
      },
    );

    it.each(
      ['authored', 'inherited'].flatMap((origin) =>
        [
          '--require ./boot.cjs',
          '--import ./boot.mjs',
          '--input-type=module',
        ].map((options) => ({ origin, options })),
      ),
    )(
      'isolates helpers from $origin $options and preserves command options',
      async ({ origin, options }) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'opts-'));
        const marker = path.join(dir, 'preloads');
        writeFileSync(
          path.join(dir, 'boot.cjs'),
          `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n'); console.log('boot');`,
        );
        writeFileSync(
          path.join(dir, 'boot.mjs'),
          `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n'); console.log('boot');`,
        );
        const env = origin === 'authored' ? { NODE_OPTIONS: options } : {};
        if (origin === 'inherited') process.env.NODE_OPTIONS = options;
        for (const command of [
          ['/bin/echo', '{"ok":true}'],
          [
            process.execPath,
            '-e',
            options === '--input-type=module'
              ? 'export {}; console.log(process.env.NODE_OPTIONS)'
              : 'console.log(process.env.NODE_OPTIONS)',
          ],
        ]) {
          const control = await plain(command, dir, env);
          const result = await source.observe(
            { command, env, cwd: dir, timeout: '2s' },
            { now: new Date() },
          );
          expect(result.nextState).toMatchObject({
            health: 'ok',
            stdout: control.stdout,
            exitCode: control.code,
          });
          // A native command runs no preload at all; each authored Node command
          // runs exactly once in the control and once in the bounded execution.
          if (options !== '--input-type=module') {
            if (command[0] === '/bin/echo')
              expect(existsSync(marker)).toBe(false);
            else
              expect(
                readFileSync(marker, 'utf8').trim().split('\n'),
              ).toHaveLength(2);
          }
        }
      },
    );
  },
);

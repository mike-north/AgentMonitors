/** Native standard streams must keep spawn's blocking I/O contract across helper exec. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import source from './index.js';
import { restoreProcessGlobalsAfterEach } from './global-state.test-support.js';

/** Only the stdin fixture replaces the source's ordinary ignored input with a pipe. */
const fixture = vi.hoisted(() => ({ input: false, primeFd: -1 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, argv, options] = args;
      if (!fixture.input || !options || !Array.isArray(options.stdio))
        return actual.spawn(...args);
      const child = actual.spawn(command, argv, {
        ...options,
        stdio: ['pipe', ...options.stdio.slice(1)],
      });
      // Deliver input only after authored work has announced its blocking read.
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output === 'ready\n') {
          output = 'sent';
          setTimeout(() => child.stdin?.end('x'), 100);
        }
      });
      return child;
    },
  };
});
vi.mock('./self-bound.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./self-bound.js')>();
  return {
    ...actual,
    get LAUNCHER_PROGRAM() {
      if (fixture.primeFd < 0) return actual.LAUNCHER_PROGRAM;
      // Exercise every stream even when a Node version leaves it blocking.
      // Prime the real flag alongside descriptor retention, before status restoration.
      return (
        `const originalLoad = require('node:module')._load;
        require('node:module')._load = function(id, ...args) {
          const loaded = originalLoad.call(this, id, ...args);
          if (!id.includes('koffi')) return loaded;
          return {...loaded, load(...args) {
            const library = loaded.load(...args);
            const fcntl = library.func('int fcntl(int fd, int cmd, ...)');
            const nonblock = process.platform === 'darwin' ? 4 : 2048;
            return {...library, func(declaration) {
              const native = library.func(declaration);
              if (!declaration.includes(' fcntl(')) return native;
              return (fd, cmd, ...args) => {
                if (fd === ${fixture.primeFd} && cmd === 2 && fcntl(fd, 4, 'int', fcntl(fd, 3) | nonblock) === -1)
                  throw new Error('fixture: could not prime nonblocking stdio');
                return native(fd, cmd, ...args);
              };
            }};
          }};
        };` + actual.LAUNCHER_PROGRAM
      );
    },
  };
});
restoreProcessGlobalsAfterEach();
afterEach(() => {
  fixture.input = false;
  fixture.primeFd = -1;
});

/** A plain asynchronous spawn continuously drains both streams like observe. */
async function plain(command: string[]) {
  return new Promise<{ code: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(command[0] ?? '', command.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout }));
    },
  );
}

// Perl's syswrite/sysread expose native EAGAIN instead of silently retrying it.
// Missing interpreters are the only supported skip; no C toolchain is required.
const perl = '/usr/bin/perl';
describe.skipIf(process.platform === 'win32' || !existsSync(perl))(
  'native blocking stdio',
  () => {
    it.each(['stdout', 'stderr'])(
      'drains 8 MiB from %s without EAGAIN',
      async (stream) => {
        fixture.primeFd = stream === 'stdout' ? 1 : -1;
        const command = [
          perl,
          '-e',
          String.raw`
      my $out = $ARGV[0] eq 'stdout' ? *STDOUT : *STDERR;
      my $bytes = 0; my $chunk = 'x' x 4096;
      while ($bytes < 8 * 1024 * 1024) {
        my $n = syswrite($out, $chunk);
        if (!defined($n)) { print STDOUT "errno=" . (0+$!) . " bytes=$bytes\n"; exit 42; }
        $bytes += $n;
      }
      if ($ARGV[0] eq 'stderr') { print STDOUT "bytes=$bytes\n"; }
    `,
          stream,
        ];
        const control = await plain(command);
        expect(control.code).toBe(0);
        expect(control.stdout).toBe(
          stream === 'stderr' ? 'bytes=8388608\n' : 'x'.repeat(8388608),
        );
        const result = await source.observe(
          { command, timeout: '5s' },
          { now: new Date() },
        );
        expect(result.nextState).toMatchObject({ health: 'ok', exitCode: 0 });
        if (stream === 'stderr')
          expect(result.nextState).toMatchObject({ stdout: control.stdout });
        else expect(result.nextState).toMatchObject({ truncated: true });
      },
    );

    it('blocks on stdin until input arrives after command readiness', async () => {
      fixture.input = true;
      fixture.primeFd = 0;
      const command = [
        perl,
        '-e',
        String.raw`
      $| = 1; print "ready\n";
      my $n = sysread(STDIN, my $byte, 1);
      if (!defined($n)) { print "errno=" . (0+$!) . "\n"; exit 42; }
      print "read=$n:$byte\n";
    `,
      ];
      expect(await plain(command)).toEqual({
        code: 0,
        stdout: 'ready\nread=1:x\n',
      });
      const result = await source.observe(
        { command, timeout: '5s' },
        { now: new Date() },
      );
      expect(result.nextState).toMatchObject({
        health: 'ok',
        exitCode: 0,
        stdout: 'ready\nread=1:x\n',
      });
    });
  },
);

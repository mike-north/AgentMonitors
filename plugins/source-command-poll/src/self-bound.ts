/**
 * POSIX admission programs are embedded and use a packaged native exec binding,
 * requiring no separate helper executable or PATH utility. The launcher becomes the authored command with the same PID;
 * its watchdog is an ordinary member of that detached group. Keeping itself in
 * the group makes kill(0) identity-safe even after every other member has exited:
 * this live member prevents group-ID reuse, with no remembered numeric target.
 */

/**
 * A referenced deadline survives parent loss and closed command descriptors.
 * Normal completion releases the finite observation's group after output capture;
 * daemon EOF alone leaves the original deadline armed for every descendant.
 * @internal
 */
export const WATCHDOG_PROGRAM = String.raw`
try {
const {Socket} = require('node:net');
const {deadline, grace} = JSON.parse(process.argv[1]);
const now = () => Number(process.hrtime.bigint() / 1000000n);
// The launcher created a new session, and this program never changes group.
// Signal the current group, not a persisted PID that could have been recycled.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
// Segment long delays to avoid overflowing Node's maximum timer, including grace.
// Monotonic time counts launcher startup and cannot be extended by clock correction.
function armAt(at, callback) {
  const timer = {handle: undefined};
  function step() {
    const remaining = at - now();
    if (remaining <= 0) { callback(); return; }
    timer.handle = setTimeout(step, Math.min(2147483647, remaining));
  }
  step();
  return timer;
}
armAt(deadline + grace, () => process.kill(0, 'SIGKILL'));
armAt(deadline, () => process.kill(0, 'SIGTERM'));
const control = new Socket({fd: 3, readable: true, writable: false});
control.on('error', () => control.destroy());
let input = '';
control.on('data', chunk => {
  input += chunk.toString();
  const lines = input.split('\n');
  input = lines.pop() || '';
  // A completion request arrives only after direct-command output has settled.
  // Finite observations release every remaining group member with the watchdog;
  // no process-table snapshot can safely prove the absence of a late fork.
  if (lines.includes('cancel') || lines.includes('complete')) process.kill(0, 'SIGKILL');
});
// EOF means the daemon may have died. Neither EOF nor an IPC disconnect cancels
// either referenced timer; no descriptor has to stay open for the bound to hold.
control.on('end', () => control.destroy());
if (!process.send) throw new Error('Missing watchdog arming channel');
process.send('armed');
process.disconnect();
} catch (error) {
  // Report a failed arm over the admission channel, never through command stderr.
  if (process.send) process.send({kind: 'error', error: String(error.message || error)}, () => process.exit(1));
  else process.exit(1);
}
`;

/**
 * Wait for the watchdog's armed acknowledgement before replacing this process.
 * Native exec preserves authored argv and environment with the platform's
 * normal spawn search and executable-format fallback. Native exec failures remain
 * execution failures, never command results.
 * A private close-on-exec status pipe orders admission/error messages before EOF;
 * the watchdog owns only the separate lifetime-control descriptor. All work here
 * runs in the asynchronous child, never synchronously on observe.
 * @internal
 */
export const LAUNCHER_PROGRAM = String.raw`
const {spawn} = require('node:child_process');
const {write, readFile, close} = require('node:fs');
const {getSystemErrorName} = require('node:util');
let armed = false;
let failing = false;
// A frame is a byte protocol: a successful write may consume only a prefix,
// including part of a UTF-8 character. Admission/exit wait for the entire buffer.
function writeFrame(message, callback) {
  const bytes = Buffer.from(JSON.stringify(message) + '\n');
  function next(offset) {
    write(5, bytes, offset, bytes.length - offset, (error, written) => {
      if (error) { callback(error); return; }
      if (written <= 0) { callback(new Error('Command status write made no progress')); return; }
      const end = offset + written;
      if (end < bytes.length) next(end);
      else callback();
    });
  }
  next(0);
}
function fail(error) {
  if (failing) return;
  failing = true;
  writeFrame({kind: 'error', error: 'Could not arm command lifetime bound: ' + String(error.message || error)}, writeError => {
    // If no error bytes reach the parent, an ordinary exit(1) could masquerade
    // as an authored result after armed. A signal makes that failure unambiguous.
    if (writeError) process.kill(process.pid, 'SIGKILL');
    else process.exit(1);
  });
}
async function launch({command, env, deadline, grace, watchdog, native}) {
  // C strings cannot represent embedded NUL. Match spawn's rejection rather
  // than letting the binding silently truncate literal argv or environment data.
  if (command.some(value => value.includes('\0')) || Object.entries(env).some(([key, value]) => key.includes('\0') || value.includes('\0')))
    throw new Error('Could not execute ' + command[0] + ': ERR_INVALID_ARG_VALUE: arguments and environment must be strings without null bytes');
  // All native work lives in this disposable helper, never on the observe path.
  // libc execve returns errno; Node's process.execve aborts on ordinary failures.
  let koffi;
  try { koffi = require(native); }
  catch (error) { throw new Error('Native exec support for this platform could not be loaded: ' + String(error.message || error)); }
  const libc = koffi.load(null);
  const execve = libc.func('int execve(const char *path, const char **argv, const char **envp)');
  // Linux libuv calls execvp after chdir and environment setup. execvpe uses
  // the same libc policy (including glibc's /bin/sh fallback on ENOEXEC), with
  // explicit envp so authored NODE_OPTIONS never executes in a helper.
  const execvpe = process.platform === 'linux'
    ? libc.func('int execvpe(const char *file, const char **argv, const char **envp)')
    : undefined;
  const signal = libc.func('void *signal(int sig, void *handler)');
  const sigemptyset = libc.func('int sigemptyset(void *set)');
  const sigprocmask = libc.func('int sigprocmask(int how, const void *set, void *oldset)');
  const strerror = libc.func('const char *strerror(int errnum)');
  // fcntl's optional argument is variadic: notably, Darwin arm64 passes it on
  // the stack rather than in the register used by a fixed third parameter.
  const fcntl = libc.func('int fcntl(int fd, int cmd, ...)');
  // Darwin and Linux use these same descriptor-flag constants. Keep the native
  // platform values explicit; they are distinct from open-file status flags.
  const {F_GETFD, F_SETFD, FD_CLOEXEC} = {
    darwin: {F_GETFD: 1, F_SETFD: 2, FD_CLOEXEC: 1},
    linux: {F_GETFD: 1, F_SETFD: 2, FD_CLOEXEC: 1},
  }[process.platform];
  function execError(errno) {
    return new Error('Could not execute ' + command[0] + ': ' + getSystemErrorName(-errno) + ': ' + strerror(errno));
  }
  // cwd was set by spawn before helper startup. Never prefix or normalize a
  // candidate: the kernel must retain symlink/.. traversal and script argv[0].
  const file = command[0];
  function execute() {
    const argv = [...command, null];
    const envp = [...Object.entries(env).map(([key, value]) => key + '=' + value), null];
    if (execvpe) {
      execvpe(file, argv, envp);
      throw execError(koffi.errno());
    }
    // Match Darwin libuv's uv__spawn_resolve_and_spawn, including its byte
    // limits and empty PATH components. An errno comes from exec, never access.
    // https://github.com/libuv/libuv/blob/v1.51.0/src/unix/process.c#L633-L723
    const searched = !file.includes('/');
    const path = env.PATH ?? '/usr/bin:/bin';
    if (searched && Buffer.byteLength(file) > 255) throw execError(koffi.os.errno.ENAMETOOLONG);
    const pathLimit = Math.min(Buffer.byteLength(path), 1023) + 1;
    const candidates = searched
      ? path.split(':').filter(dir => Buffer.byteLength(dir) < pathLimit).map(dir => dir ? dir + '/' + file : file)
      : [file];
    let errno = koffi.os.errno.ENOENT;
    let denied = false;
    for (const candidate of candidates) {
      do {
        execve(candidate, argv, envp);
        errno = koffi.errno();
      } while (errno === koffi.os.errno.EINTR);
      if (!searched) throw execError(errno);
      if (errno === koffi.os.errno.EACCES) denied = true;
      else if (errno !== koffi.os.errno.ENOENT && errno !== koffi.os.errno.ENOTDIR) throw execError(errno);
    }
    throw execError(denied ? koffi.os.errno.EACCES : errno);
  }
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', watchdog, JSON.stringify({deadline, grace})], {
    detached: false, stdio: ['ignore', 'ignore', 'ignore', 3, 'ipc'], env: process.env,
  });
  child.once('error', fail);
  child.once('exit', () => { if (!armed) fail(new Error('Watchdog exited before arming')); });
  child.once('message', message => {
    if (message && message.kind === 'error') { fail(new Error(message.error)); return; }
    if (message !== 'armed') { fail(new Error('Invalid watchdog acknowledgement')); return; }
    armed = true;
    writeFrame({kind: 'armed'}, error => {
      if (error) { fail(error); return; }
      if (Number(process.hrtime.bigint() / 1000000n) >= deadline) { fail(new Error('Deadline elapsed before command admission')); return; }
      // Node's spawn resets dispositions and clears the child mask. Direct exec
      // only resets handlers: its ignored SIGPIPE/SIGXFSZ would otherwise leak.
      // Clear every catchable signal (including Linux realtime signals), not just
      // today's Node ignores. Invalid and uncatchable numbers are harmless here.
      // Darwin has 32 signals and a 4-byte sigset_t; Linux has 65 and 128 bytes.
      const limit = process.platform === 'darwin' ? 32 : 65;
      const mask = Buffer.alloc(128);
      try {
        for (let sig = 1; sig < limit; sig++) signal(sig, null);
        if (sigemptyset(mask) !== 0 || sigprocmask(process.platform === 'darwin' ? 3 : 2, mask, null) !== 0)
          throw new Error('Could not restore command signal mask');
        // libuv marks even the inherited stdio duplicates close-on-exec. Retain
        // exactly stdin/stdout/stderr; private control and Node internals stay closed.
        for (const fd of [0, 1, 2]) {
          if (fcntl(fd, F_SETFD, 'int', 0) === -1) throw new Error('Could not retain command stdio');
          // A successful setter alone cannot prove that exec will retain stdio.
          // Refuse admission on read failure or a surviving close-on-exec flag.
          const flags = fcntl(fd, F_GETFD);
          if (flags === -1 || (flags & FD_CLOEXEC) !== 0) throw new Error('Could not retain command stdio');
        }
        // All other Node-created descriptors are close-on-exec. The watchdog retains its
        // independent control descriptor and timers across a successful replacement.
        // Every returning exec is a failure. Keep stdout, stderr and the prior
        // baseline untouched while the complete private error frame is flushed.
        execute();
      } catch (error) { fail(error); }
    });
  });
}
// A separate configuration pipe prevents command/env size from being multiplied
// in the launcher's exec arguments, and is closed before any authored exec.
readFile(4, 'utf8', (error, payload) => {
  if (error) { fail(error); return; }
  close(4, error => {
    if (error) { fail(error); return; }
    try { launch(JSON.parse(payload)).catch(fail); } catch (error) { fail(error); }
  });
});
`;

/** Execution deadlines keep the native epoch even if a host virtualizes its scheduling clock. */
const monotonicNanoseconds = process.hrtime.bigint.bind(process.hrtime);

/** Shared OS monotonic epoch lets launcher startup consume the configured window. @internal */
export function monotonicNowMs(): number {
  return Number(monotonicNanoseconds() / 1000000n);
}

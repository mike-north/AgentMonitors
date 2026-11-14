/**
 * POSIX admission programs, embedded so packed consumers need no helper file or
 * PATH utility. The launcher becomes the authored command with the same PID;
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
 * Direct exec preserves authored argv and environment without a shell rewriting
 * either. Native exec failures remain execution failures, never command results.
 * A private close-on-exec status pipe orders admission/error messages before EOF;
 * the watchdog owns only the separate lifetime-control descriptor. All work here
 * runs in the asynchronous child, never synchronously on observe.
 * @internal
 */
export const LAUNCHER_PROGRAM = String.raw`
const {spawn} = require('node:child_process');
const {write, readFile, close, promises: fs, constants} = require('node:fs');
const {getSystemErrorName} = require('node:util');
let armed = false;
function fail(error) {
  const message = JSON.stringify({kind: 'error', error: 'Could not arm command lifetime bound: ' + String(error.message || error)}) + '\n';
  write(5, message, () => process.exit(1));
}
async function launch({command, env, deadline, grace, watchdog, native}) {
  // All native work lives in this disposable helper, never on the observe path.
  // libc execve returns errno; Node's process.execve aborts on ordinary failures.
  const koffi = require(native);
  const libc = koffi.load(null);
  const execve = libc.func('int execve(const char *path, const char **argv, const char **envp)');
  const signal = libc.func('void *signal(int sig, void *handler)');
  const sigemptyset = libc.func('int sigemptyset(void *set)');
  const sigprocmask = libc.func('int sigprocmask(int how, const void *set, void *oldset)');
  const strerror = libc.func('const char *strerror(int errnum)');
  const fcntl = libc.func('int fcntl(int fd, int cmd, int flags)');
  function execError(errno) {
    return new Error('Could not execute ' + command[0] + ': ' + getSystemErrorName(-errno) + ': ' + strerror(errno));
  }
  // Preserve every path component for kernel symlink/.. traversal; lexical
  // normalization can silently select a different executable. Prefixing cwd
  // makes relative/dash-prefixed names unambiguous without rewriting them.
  // Lookups stay asynchronous and use the command's effective cwd/environment.
  const file = command[0];
  const candidates = file.includes('/') ? [file] : (process.env.PATH ?? '/usr/bin:/bin').split(':').map(dir => (dir || '.') + '/' + file);
  let executable;
  let denied = false;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) { executable = candidate.startsWith('/') ? candidate : process.cwd() + '/' + candidate; break; }
    } catch (error) {
      if (error.code === 'EACCES') denied = true;
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  if (!executable) throw execError(denied ? koffi.os.errno.EACCES : koffi.os.errno.ENOENT);
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', watchdog, JSON.stringify({deadline, grace})], {
    detached: false, stdio: ['ignore', 'ignore', 'ignore', 3, 'ipc'], env: process.env,
  });
  child.once('error', fail);
  child.once('exit', () => { if (!armed) fail(new Error('Watchdog exited before arming')); });
  child.once('message', message => {
    if (message && message.kind === 'error') { fail(new Error(message.error)); return; }
    if (message !== 'armed') { fail(new Error('Invalid watchdog acknowledgement')); return; }
    armed = true;
    write(5, JSON.stringify({kind: 'armed'}) + '\n', error => {
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
          if (fcntl(fd, 2, 0) === -1) throw new Error('Could not retain command stdio');
        }
        // All other Node-created descriptors are close-on-exec. The watchdog retains its
        // independent control descriptor and timers across a successful replacement.
        execve(executable, [command[0], ...command.slice(1), null], [...Object.entries(env).map(([key, value]) => key + '=' + value), null]);
        // A return is exclusively failure. Report it on the private channel before
        // exiting normally; stdout, stderr and successful baselines stay untouched.
        const errno = koffi.errno();
        fail(execError(errno));
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

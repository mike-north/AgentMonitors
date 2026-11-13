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
 * All work here runs in the asynchronous child, never synchronously on observe.
 * @internal
 */
export const LAUNCHER_PROGRAM = String.raw`
const {spawn} = require('node:child_process');
const {write, promises: fs, constants} = require('node:fs');
const {command, deadline, grace, watchdog} = JSON.parse(process.argv[1]);
let armed = false;
function fail(error) {
  const message = JSON.stringify({kind: 'error', error: 'Could not arm command lifetime bound: ' + String(error.message || error)}) + '\n';
  write(3, message, () => process.exit(1));
}
async function launch() {
  if (typeof process.execve !== 'function') throw new Error('POSIX execve is unavailable');
  // Preserve every path component for kernel symlink/.. traversal; lexical
  // normalization can silently select a different executable. Prefixing cwd
  // makes relative/dash-prefixed names unambiguous without rewriting them.
  // Lookups stay asynchronous and use the command's effective cwd/environment.
  const file = command[0];
  const candidates = file.includes('/') ? [file] : (process.env.PATH ?? '/usr/bin:/bin').split(':').map(dir => (dir || '.') + '/' + file);
  let executable;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) { executable = candidate.startsWith('/') ? candidate : process.cwd() + '/' + candidate; break; }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  if (!executable) throw new Error('Executable not found or not executable: ' + file);
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', watchdog, JSON.stringify({deadline, grace})], {
    detached: false, stdio: ['ignore', 'ignore', 'ignore', 3, 'ipc'], env: process.env,
  });
  child.once('error', fail);
  child.once('exit', () => { if (!armed) fail(new Error('Watchdog exited before arming')); });
  child.once('message', message => {
    if (message && message.kind === 'error') { fail(new Error(message.error)); return; }
    if (message !== 'armed') { fail(new Error('Invalid watchdog acknowledgement')); return; }
    armed = true;
    write(3, JSON.stringify({kind: 'armed'}) + '\n', error => {
      if (error) { fail(error); return; }
      if (Number(process.hrtime.bigint() / 1000000n) >= deadline) { fail(new Error('Deadline elapsed before command admission')); return; }
      // execve closes nonstandard descriptors. The watchdog owns its independent
      // duplicate of fd 3, and its referenced timers survive this replacement.
      // Node aborts on a native exec failure (e.g. a missing shebang interpreter),
      // so it cannot masquerade as an authored nonzero exit or replace a baseline.
      try { process.execve(executable, [command[0], ...command.slice(1)], process.env); }
      catch (error) { fail(error); }
    });
  });
}
launch().catch(fail);
`;

/** Execution deadlines keep the native epoch even if a host virtualizes its scheduling clock. */
const monotonicNanoseconds = process.hrtime.bigint.bind(process.hrtime);

/** Shared OS monotonic epoch lets launcher startup consume the configured window. @internal */
export function monotonicNowMs(): number {
  return Number(monotonicNanoseconds() / 1000000n);
}

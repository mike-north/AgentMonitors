/**
 * Linux PID 1 and existing subreapers own adopted watchdog exit statuses that
 * libuv never registered. Private launcher identities grant wait authority only:
 * they confer neither journal ownership nor authority to signal any process.
 * This module never enumerates children, installs SIGCHLD handlers or signals.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { vendoredNativeLoader } from './native-binding.js';

/** Nonblocking waits may release only an already terminated, specifically named child. */
const WNOHANG = 1;
/** Query the caller's existing adoption responsibility; never enable subreaping here. */
const PR_GET_CHILD_SUBREAPER = 37;
/** Poll only reported lifetimes, and only while some watchdog remains outstanding. */
const REAP_POLL_MS = 50;

/** The narrow OS boundary permits deterministic safety tests without real wait targets. @internal */
export interface IWatchdogReaperHost {
  readonly platform: string;
  readonly pid: number;
  readonly isSubreaper: () => boolean;
  readonly readStat: (pid: number) => string;
  readonly waitpid: (pid: number, status: Buffer, flags: number) => number;
}

/** Birth time and the original detached session distinguish a watchdog from PID reuse. @internal */
export interface IWatchdogIdentity {
  readonly startTime: string;
  readonly group: number;
  /** The reported intermediate may still own the watchdog when its frame arrives. */
  readonly initialParent?: number;
}

/**
 * Track only launcher-reported watchdog lifetimes. A live child is retained for
 * later inspection; unreadable, replaced or foreign identities grant no wait.
 * The proc read and exact wait run synchronously, without a libuv callback that
 * could consume a different child's status between validation and the wait.
 * @internal
 */
export function createWatchdogReaper(
  host: IWatchdogReaperHost,
): (
  pid: number,
  startTime: string,
  group: number,
  initialParent?: number,
) => void {
  const pending = new Map<number, IWatchdogIdentity>();
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Platform and current adoption responsibility are prerequisites for every sweep. */
  function eligible(): boolean {
    try {
      return (
        host.platform === 'linux' && (host.pid === 1 || host.isSubreaper())
      );
    } catch {
      return false;
    }
  }

  /** An idle reaper owns no timer and cannot keep an ordinary observer alive. */
  function stopWhenIdle(): void {
    if (pending.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  /**
   * comm is enclosed in parentheses but can itself contain spaces and ')'.
   * Fields after its final delimiter retain kernel positions: state, ppid,
   * pgrp, session, and starttime (field 22, offset 19 after comm).
   */
  function stateOf(
    pid: number,
    identity: IWatchdogIdentity,
  ): string | undefined {
    const stat = host.readStat(pid);
    const end = stat.lastIndexOf(') ');
    if (!stat.startsWith(`${String(pid)} (`) || end < 0) return undefined;
    const fields = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/);
    if (
      fields.length < 20 ||
      fields[2] !== String(identity.group) ||
      fields[3] !== String(identity.group) ||
      fields[19] !== identity.startTime
    ) {
      return undefined;
    }
    if (fields[1] === String(host.pid)) return fields[0];
    // Registration precedes arming and can beat adoption. Even a zombie must
    // remain pending while the reported intermediate owns it; only our own
    // adopted zombie may be waited on. Any other parent revokes this identity.
    return identity.initialParent !== undefined &&
      fields[1] === String(identity.initialParent)
      ? 'pending-adoption'
      : undefined;
  }

  /** Revalidate each known PID independently; no wildcard selector may reach waitpid. */
  function sweep(): void {
    if (!eligible()) {
      pending.clear();
      stopWhenIdle();
      return;
    }
    for (const [pid, identity] of pending) {
      try {
        const state = stateOf(pid, identity);
        if (state === undefined) {
          pending.delete(pid);
        } else if (state === 'Z') {
          // Never wait on a running/stopped child, even with WNOHANG: libuv
          // alone owns the statuses of processes it spawned. A zombie with this
          // pinned identity is this observer's adopted watchdog, not its launcher.
          if (host.waitpid(pid, Buffer.alloc(4), WNOHANG) === pid) {
            pending.delete(pid);
          }
        }
      } catch {
        // Disappearance or failed native inspection cannot broaden wait authority.
        pending.delete(pid);
      }
    }
    stopWhenIdle();
  }

  return (pid, startTime, group, initialParent) => {
    // A watchdog is never PID 1, the observer itself, or its detached group
    // leader (the libuv-spawned launcher/authored command).
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      pid === host.pid ||
      pid === group ||
      !Number.isSafeInteger(group) ||
      group <= 1 ||
      !/^\d+$/.test(startTime) ||
      (initialParent !== undefined &&
        (!Number.isSafeInteger(initialParent) ||
          initialParent < 1 ||
          initialParent === pid))
    ) {
      return;
    }
    pending.set(pid, {
      startTime,
      group,
      ...(initialParent === undefined ? {} : { initialParent }),
    });
    sweep();
    if (pending.size > 0 && timer === undefined) {
      timer = setInterval(sweep, REAP_POLL_MS);
      timer.unref();
    }
  };
}

/** Only the two libc operations required for wait authority are resolved, lazily on Linux. */
interface IReapingBinding {
  readonly waitpid: IWatchdogReaperHost['waitpid'];
  readonly isSubreaper: () => boolean;
}
let binding: IReapingBinding | undefined;

/** Reuse the existing packaged binding; no new binary, subprocess or native dependency. */
function nativeBinding(): IReapingBinding {
  if (binding !== undefined) return binding;
  const filename = vendoredNativeLoader();
  // Koffi's CommonJS API is outside TypeScript. Describe only the scalar and
  // pointer ABI calls used below; all public reaper inputs remain checked.
  const koffi = createRequire(filename)(filename) as {
    load: (filename: null) => {
      func: (
        declaration: string,
      ) => (...args: (number | string | Buffer)[]) => number;
    };
  };
  const libc = koffi.load(null);
  const prctl = libc.func('int prctl(int option, ...)');
  binding = {
    waitpid: libc.func('int waitpid(int pid, void *status, int options)'),
    isSubreaper: () => {
      const value = Buffer.alloc(4);
      return (
        prctl(
          PR_GET_CHILD_SUBREAPER,
          'void *',
          value,
          'unsigned long',
          0,
          'unsigned long',
          0,
          'unsigned long',
          0,
        ) === 0 && value.readInt32LE() === 1
      );
    },
  };
  return binding;
}

/** One process-local registry spans all source instances without changing libuv ownership. @internal */
export const trackAdoptedWatchdog = createWatchdogReaper({
  platform: process.platform,
  pid: process.pid,
  isSubreaper: () => nativeBinding().isSubreaper(),
  readStat: (pid) => readFileSync(`/proc/${String(pid)}/stat`, 'utf8'),
  waitpid: (pid, status, flags) => nativeBinding().waitpid(pid, status, flags),
});

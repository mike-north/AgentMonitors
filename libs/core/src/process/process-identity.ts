/**
 * Identity-verified cleanup signals (008 §5): the single gate every
 * cleanup or enforcement signal Agent Monitors sends must pass through.
 *
 * A stored pid or process-group id is a name the OS may hand to unrelated work
 * once the original holder is gone. So immediately before each signal, the
 * target is positively re-confirmed as the process (or group) Agent Monitors
 * spawned, using evidence that cannot outlive the original:
 *
 * - **Live child handle.** While Node still holds an unreaped `ChildProcess`
 *   for a pid, the kernel cannot reuse that pid — and, because a spawned
 *   POSIX child is a session and group leader that cannot leave its own group,
 *   cannot reuse that process-group id either. An unreaped handle is therefore
 *   positive identity for the pid and for the group it leads. Once Node has
 *   reaped the child (`exitCode`/`signalCode` set), the handle proves nothing
 *   about whoever holds the number now.
 * - **Recorded identity.** A `(pid, pgid, startTime)` record read from the
 *   platform process table ({@link readProcessTable}) names one process for its
 *   whole life. For a group whose leader has been reaped, the group is
 *   confirmed only if at least one current member is a process that was a
 *   member when the group was last confirmed. A group id can be reused only
 *   after every member is gone, so one surviving known member proves the group
 *   is still the one Agent Monitors started — and then every current member is
 *   inside the containment boundary (008 §2.1).
 *
 * When identity cannot be confirmed the signal is **withheld** and the
 * abstention is reported with its reason (008 §5, §6.1): leak once rather than
 * kill the wrong thing. Verification failure never escalates to force.
 *
 * Residual: the check and the `kill(2)` are separate system calls, so a target
 * that vanishes and is replaced in between is not detected. Replacement needs
 * the whole pid space to wrap inside that window; no portable POSIX primitive
 * closes it for process groups.
 */
import type {
  ProcessIdentityRecord,
  ProcessTableReader,
} from './process-table.js';
import { readProcessTable } from './process-table.js';
import { isErrnoException } from '../security/local-permissions.js';

/**
 * The parts of a Node `ChildProcess` identity verification relies on. A real
 * `ChildProcess` satisfies it.
 *
 * @public
 */
export interface ChildProcessHandle {
  readonly pid?: number | undefined;
  /** Set by Node once the child has been reaped (normal exit). */
  readonly exitCode: number | null;
  /** Set by Node once the child has been reaped (killed by a signal). */
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * A single process Agent Monitors spawned and still holds a handle for.
 *
 * @public
 */
export interface SpawnedProcessTarget {
  readonly kind: 'spawned-process';
  readonly handle: ChildProcessHandle;
}

/**
 * The process group led by a child Agent Monitors spawned as a group leader
 * (POSIX `detached: true`).
 *
 * `verifiedMembers` is the group's membership at the most recent moment its
 * identity was confirmed. {@link sendVerifiedSignal} maintains it: it is the
 * evidence that lets a later signal confirm the group after its leader has
 * been reaped. Create one with {@link spawnedProcessGroup} and reuse the same
 * object for every escalation step against that group.
 *
 * @public
 */
export interface SpawnedProcessGroupTarget {
  readonly kind: 'spawned-process-group';
  readonly leader: ChildProcessHandle;
  readonly pgid: number;
  verifiedMembers: readonly ProcessIdentityRecord[];
}

/**
 * A process known only from a recorded identity (no live handle), such as a
 * process left behind by an earlier daemon life.
 *
 * @public
 */
export interface RecordedProcessTarget {
  readonly kind: 'recorded-process';
  readonly record: ProcessIdentityRecord;
}

/**
 * Anything a cleanup signal may be aimed at.
 *
 * @public
 */
export type SignalTarget =
  | SpawnedProcessTarget
  | SpawnedProcessGroupTarget
  | RecordedProcessTarget;

/**
 * What positively confirmed a target's identity before it was signalled.
 *
 * @public
 */
export type IdentityEvidence = 'live-child-handle' | 'recorded-identity';

/**
 * A signal that was withheld because the target's identity could not be
 * confirmed (008 §5, §6.1). `observed` lists what the process table showed at
 * that id, so the report can name what was left alone.
 *
 * @public
 */
export interface SignalAbstention {
  /** What the signal was for, in user terms (e.g. a monitor's timeout). */
  readonly action: string;
  readonly signal: NodeJS.Signals;
  readonly target: {
    readonly kind: 'process' | 'process-group';
    readonly id: number;
  };
  /** Why identity could not be confirmed. */
  readonly reason: string;
  readonly observed: readonly ProcessIdentityRecord[];
}

/**
 * Result of {@link sendVerifiedSignal}.
 *
 * - `sent`: identity was confirmed and the signal was delivered.
 * - `not-needed`: the target no longer exists, so there was nothing to
 *   signal (and nothing suspected to report).
 * - `abstained`: identity could not be confirmed; nothing was signalled and
 *   the abstention was reported.
 * - `failed`: identity was confirmed but delivery failed for another reason
 *   (for example `EPERM`).
 *
 * @public
 */
export type SignalOutcome =
  | { readonly status: 'sent'; readonly evidence: IdentityEvidence }
  | { readonly status: 'not-needed'; readonly detail: string }
  | { readonly status: 'abstained'; readonly abstention: SignalAbstention }
  | { readonly status: 'failed'; readonly detail: string };

/**
 * Options for {@link sendVerifiedSignal}.
 *
 * @public
 */
export interface VerifiedSignalOptions {
  /** What the signal is for, in user terms; used in abstention reports. */
  readonly action: string;
  /** Process-table source; defaults to {@link readProcessTable}. */
  readonly readProcessTable?: ProcessTableReader;
  /** Abstention sink; defaults to {@link reportSignalAbstention}. */
  readonly reportAbstention?: (abstention: SignalAbstention) => void;
  /**
   * Replaces default delivery once identity is confirmed — for platforms with
   * their own tree-termination mechanism (Windows `taskkill /T`). Verification
   * still runs first; this only changes how a confirmed signal is sent.
   */
  readonly deliver?: (signal: NodeJS.Signals) => void;
}

/**
 * Build the group target for a child spawned as a process-group leader.
 * Throws when the child was never assigned a pid (nothing was started).
 *
 * @public
 */
export function spawnedProcessGroup(
  leader: ChildProcessHandle,
): SpawnedProcessGroupTarget {
  const pgid = leader.pid;
  if (pgid === undefined) {
    throw new Error('Cannot track a process group for a child with no pid');
  }
  return {
    kind: 'spawned-process-group',
    leader,
    pgid,
    verifiedMembers: [],
  };
}

/**
 * Whether Node still holds this child unreaped — the state in which its pid
 * (and the group it leads) cannot have been reused.
 *
 * @public
 */
export function isChildUnreaped(handle: ChildProcessHandle): boolean {
  return (
    handle.pid !== undefined &&
    handle.exitCode === null &&
    handle.signalCode === null
  );
}

function sameProcess(
  a: ProcessIdentityRecord,
  b: ProcessIdentityRecord,
): boolean {
  return a.pid === b.pid && a.startTime === b.startTime;
}

/**
 * Send `signal` to `target` only after positively confirming, at this moment,
 * that the target is the process (or group) Agent Monitors spawned.
 *
 * Never throws for an absent target or a failed verification: those come back
 * as `not-needed` and `abstained` outcomes, and every abstention is passed to
 * `options.reportAbstention`.
 *
 * @public
 */
export async function sendVerifiedSignal(
  target: SignalTarget,
  signal: NodeJS.Signals,
  options: VerifiedSignalOptions,
): Promise<SignalOutcome> {
  const readTable = options.readProcessTable ?? readProcessTable;
  const report = options.reportAbstention ?? reportSignalAbstention;

  const abstain = (
    kind: 'process' | 'process-group',
    id: number,
    reason: string,
    observed: readonly ProcessIdentityRecord[],
  ): SignalOutcome => {
    const abstention: SignalAbstention = {
      action: options.action,
      signal,
      target: { kind, id },
      reason,
      observed,
    };
    report(abstention);
    return { status: 'abstained', abstention };
  };

  switch (target.kind) {
    case 'spawned-process': {
      if (!isChildUnreaped(target.handle)) {
        return {
          status: 'not-needed',
          detail: 'the process Agent Monitors spawned has already exited',
        };
      }
      if (options.deliver) {
        return deliverWith(options.deliver, signal, 'live-child-handle');
      }
      // `ChildProcess.kill` signals through Node's own handle, which Node
      // invalidates when it reaps the child: it cannot reach a reused pid.
      return target.handle.kill(signal)
        ? { status: 'sent', evidence: 'live-child-handle' }
        : {
            status: 'not-needed',
            detail: 'the process Agent Monitors spawned has already exited',
          };
    }

    case 'spawned-process-group': {
      // Read the table BEFORE checking the leader: if the leader is still
      // unreaped afterwards, it was unreaped for the whole read, so every
      // member read is genuinely part of the group Agent Monitors started.
      const reading = await readTable();
      if (isChildUnreaped(target.leader)) {
        if (reading.supported) {
          target.verifiedMembers = reading.processes.filter(
            (p) => p.pgid === target.pgid,
          );
        }
        return deliverToGroup(
          target.pgid,
          signal,
          options,
          'live-child-handle',
        );
      }
      if (!reading.supported) {
        return abstain(
          'process-group',
          target.pgid,
          `the group's leader has exited and ${reading.reason}, so the group's current members cannot be compared with the ones last confirmed as ours`,
          [],
        );
      }
      const members = reading.processes.filter((p) => p.pgid === target.pgid);
      if (members.length === 0) {
        return {
          status: 'not-needed',
          detail: `process group ${String(target.pgid)} has no remaining members`,
        };
      }
      const continuous = members.some((member) =>
        target.verifiedMembers.some((known) => sameProcess(known, member)),
      );
      if (!continuous) {
        return abstain(
          'process-group',
          target.pgid,
          `the group's leader has exited and none of its ${String(members.length)} current member(s) was a member when the group was last confirmed as ours, so the group id may have been reused by unrelated work`,
          members,
        );
      }
      target.verifiedMembers = members;
      return deliverToGroup(target.pgid, signal, options, 'recorded-identity');
    }

    case 'recorded-process': {
      const { record } = target;
      const reading = await readTable();
      if (!reading.supported) {
        return abstain(
          'process',
          record.pid,
          `${reading.reason}, so pid ${String(record.pid)} cannot be compared with the recorded process`,
          [],
        );
      }
      const current = reading.processes.find((p) => p.pid === record.pid);
      if (current === undefined) {
        return {
          status: 'not-needed',
          detail: `pid ${String(record.pid)} is no longer running`,
        };
      }
      if (!sameProcess(current, record)) {
        return abstain(
          'process',
          record.pid,
          `pid ${String(record.pid)} now belongs to a process started at ${current.startTime}, but the recorded process started at ${record.startTime}, so the pid may have been reused`,
          [current],
        );
      }
      if (options.deliver) {
        return deliverWith(options.deliver, signal, 'recorded-identity');
      }
      return killNumericTarget(record.pid, signal, 'recorded-identity');
    }
  }
}

function deliverToGroup(
  pgid: number,
  signal: NodeJS.Signals,
  options: VerifiedSignalOptions,
  evidence: IdentityEvidence,
): SignalOutcome {
  if (options.deliver) return deliverWith(options.deliver, signal, evidence);
  // A negative pid addresses the whole process group.
  return killNumericTarget(-pgid, signal, evidence);
}

function deliverWith(
  deliver: (signal: NodeJS.Signals) => void,
  signal: NodeJS.Signals,
  evidence: IdentityEvidence,
): SignalOutcome {
  try {
    deliver(signal);
    return { status: 'sent', evidence };
  } catch (error) {
    return { status: 'failed', detail: errorMessage(error) };
  }
}

function killNumericTarget(
  id: number,
  signal: NodeJS.Signals,
  evidence: IdentityEvidence,
): SignalOutcome {
  try {
    process.kill(id, signal);
    return { status: 'sent', evidence };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return { status: 'not-needed', detail: 'the target exited first' };
    }
    return { status: 'failed', detail: errorMessage(error) };
  }
}

/** Cap on processes named in one abstention message. */
const MAX_OBSERVED_IN_MESSAGE = 5;

/**
 * Render an abstention as a user-facing warning. The wording states
 * uncertainty plainly — the target "may be ours" — and never presents the
 * suspicion as a certainty (008 §6.1).
 *
 * @public
 */
export function describeSignalAbstention(abstention: SignalAbstention): string {
  const noun =
    abstention.target.kind === 'process-group' ? 'process group' : 'process';
  const shown = abstention.observed.slice(0, MAX_OBSERVED_IN_MESSAGE);
  const more = abstention.observed.length - shown.length;
  const observed =
    shown.length === 0
      ? ''
      : ` Observed: ${shown
          .map((p) => `pid ${String(p.pid)} (started ${p.startTime})`)
          .join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}.`;
  return (
    `Left ${noun} ${String(abstention.target.id)} alone instead of sending ` +
    `${abstention.signal} (${abstention.action}): it may be ours, but its ` +
    `identity could not be confirmed — ${abstention.reason}.${observed} ` +
    'Nothing was signalled. If it is stray, you can end it yourself.'
  );
}

/**
 * Default abstention sink: one warning line on stderr, which is the daemon
 * log for a background daemon.
 *
 * @public
 */
export function reportSignalAbstention(abstention: SignalAbstention): void {
  process.stderr.write(`Warning: ${describeSignalAbstention(abstention)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

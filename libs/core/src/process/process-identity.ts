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
 *   whole life.
 * - **Group continuity.** A process-group id cannot be reused while any member
 *   of the group exists. So a membership reading taken while the group is
 *   provably ours confirms every member in it: a reading that *started* while
 *   the leader was still unreaped, one started in the leader's own `exit`
 *   event (the moment Node reaps it), or one in which a member confirmed
 *   earlier is still present. Confirmed members accumulate on the target, and
 *   each later step confirms the group through any of them that remains. Every
 *   current member of a confirmed group is inside the containment boundary
 *   (008 §2.1), including processes forked after an earlier step.
 * - **Grace-period tracking.** On request, a step that signals a group keeps
 *   re-reading its membership on a fixed interval until the next step, so a
 *   member that forks a child and then exits during the grace period hands
 *   continuity on through a reading that saw both ({@link GroupMembershipTracking}).
 *
 * When identity cannot be confirmed the signal is **withheld** and the
 * abstention is reported with its reason (008 §5, §6.1): leak once rather than
 * kill the wrong thing. Verification failure never escalates to force.
 *
 * Residual (008 §5.1): evidence comes from a process-table read that takes time
 * (tens of milliseconds, bounded by the reader's own timeout), and the signal
 * is sent after it completes. A target that empties and is replaced during
 * that read, or between the read and `kill(2)`, is not detected. Replacement
 * needs the whole pid space to wrap inside that window; no portable POSIX
 * primitive closes it for process groups. Separately, continuity is only
 * re-established at a reading: a member that forks and exits between two
 * readings, while no other confirmed member is alive, leaves the group to a
 * process no reading confirmed, and the next step abstains.
 */
import type {
  ProcessIdentityRecord,
  ProcessTableReader,
  ProcessTableReading,
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
  /**
   * Subscribes to the child's `exit` event, which Node emits in the same
   * callback that reaps it. When present, a process-group target re-reads the
   * group's membership at that moment, so processes forked after an earlier
   * escalation step are still confirmed as ours (008 §3.1, §5.1). Without it,
   * only members seen by an earlier read can carry the group's identity past
   * the leader's exit.
   */
  once?(event: 'exit', listener: () => void): unknown;
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
 * `verifiedMembers` holds every process confirmed as a member of the group so
 * far, from each reading taken while the group was provably ours.
 * {@link sendVerifiedSignal} maintains it: it is the evidence that lets a later
 * signal confirm the group after its leader has been reaped. Create one with
 * {@link spawnedProcessGroup} and reuse the same object for every escalation
 * step against that group.
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
  /**
   * Process-group targets only. When this step signals the group, keep
   * re-reading the group's membership on a fixed interval until the next step
   * against the same target starts (see {@link GroupMembershipTracking}). Use it
   * on a step that is followed by another after a grace period, so work handed
   * from one member to a newly forked process during that period is still
   * confirmed as ours (008 §3.1, §5.1).
   */
  readonly trackMembership?: GroupMembershipTracking;
}

/**
 * Grace-period membership tracking for a process-group target, requested
 * through {@link VerifiedSignalOptions.trackMembership}.
 *
 * Group continuity is only re-established when the group's membership is read.
 * A member that forks a child and then exits between two readings hands the
 * group to a process no reading ever saw beside a confirmed member, and the
 * next step must then leave the group alone. Tracking reads the membership
 * every 250 milliseconds, starting each read only after the previous one has
 * finished, and each reading that is provably ours (008 §5.1) confirms every
 * member it lists. A hand-off is therefore confirmed whenever the parent is still alive
 * at some reading after the child exists.
 *
 * Tracking stops when the next step against the target starts (which first
 * waits for a reading in flight), when a reading shows the group empty, when a
 * reading shows that continuity is already lost, when `untilMs` has elapsed,
 * or when `signal` aborts. Its timers never keep the process alive. A reading
 * that fails or is unsupported confirms nothing and does not stop tracking.
 *
 * Residual: after the leader has exited, a member that forks and exits between
 * two consecutive readings (within one interval plus one read) while no other
 * confirmed member is alive still hands the group to an unconfirmed process,
 * and the next step then abstains (008 §3.1, §5.1). A read is a `ps` run on
 * macOS, so its duration, and with it the window, grows under load, up to the
 * 5 s `ps` cap.
 *
 * @public
 */
export interface GroupMembershipTracking {
  /**
   * How long tracking may continue if no further step arrives, measured from
   * the end of the step that started it. No reading starts after this. Set it
   * to cover the gap until the next step.
   */
  readonly untilMs: number;
  /** Aborting it stops tracking, for an owner that is torn down early. */
  readonly signal?: AbortSignal;
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
      // A step ends any tracking an earlier step started, and first lets a
      // reading already in flight land, so a hand-off it saw is confirmed.
      // Only awaited when tracking exists: the first step must reach its
      // leader check without yielding (the leader is unreaped when it is
      // called, and its exit listener has to be armed while that holds).
      const tracking = endMembershipTracking(target);
      if (tracking !== undefined) await tracking;
      const outcome = await signalGroup(
        target,
        signal,
        options,
        readTable,
        abstain,
      );
      if (outcome.status === 'sent' && options.trackMembership !== undefined) {
        startMembershipTracking(target, readTable, options.trackMembership);
      }
      return outcome;
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

/** One escalation step against a process group (see {@link sendVerifiedSignal}). */
async function signalGroup(
  target: SpawnedProcessGroupTarget,
  signal: NodeJS.Signals,
  options: VerifiedSignalOptions,
  readTable: ProcessTableReader,
  abstain: (
    kind: 'process' | 'process-group',
    id: number,
    reason: string,
    observed: readonly ProcessIdentityRecord[],
  ) => SignalOutcome,
): Promise<SignalOutcome> {
  // Note the leader's state when the read STARTS. While it is unreaped the
  // group id cannot have been reused, so every member of a reading that
  // began then is ours, even if the leader is reaped before the reading
  // completes (residual: the group emptying and its id being reused during
  // the read itself, 008 §5.1).
  const leaderUnreapedAtReadStart = isChildUnreaped(target.leader);
  if (leaderUnreapedAtReadStart) {
    watchLeaderExit(target, readTable);
  } else {
    // Let the membership read started at the leader's exit land first, so
    // processes forked after the previous step count as confirmed.
    await groupExitReads.get(target)?.settled;
  }
  const reading = await readTable();
  if (leaderUnreapedAtReadStart) {
    if (reading.supported) {
      recordConfirmedMembers(target, groupMembers(reading, target.pgid));
    }
    if (isChildUnreaped(target.leader)) {
      return deliverToGroup(target.pgid, signal, options, 'live-child-handle');
    }
    if (!reading.supported) {
      return abstain(
        'process-group',
        target.pgid,
        `the group's leader exited while the process table was being read and ${reading.reason}, so the group's membership could not be confirmed`,
        [],
      );
    }
    if (groupMembers(reading, target.pgid).length === 0) {
      return {
        status: 'not-needed',
        detail: `process group ${String(target.pgid)} has no remaining members`,
      };
    }
    return deliverToGroup(target.pgid, signal, options, 'recorded-identity');
  }
  if (!reading.supported) {
    return abstain(
      'process-group',
      target.pgid,
      `the group's leader has exited and ${reading.reason}, so the group's current members cannot be compared with the ones confirmed as ours`,
      [],
    );
  }
  const members = groupMembers(reading, target.pgid);
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
      `the group's leader has exited and none of its ${String(members.length)} current member(s) was ever confirmed as a member, so they may be unrelated work that reused the group id, or work a member handed off between two membership readings`,
      members,
    );
  }
  recordConfirmedMembers(target, members);
  return deliverToGroup(target.pgid, signal, options, 'recorded-identity');
}

function groupMembers(
  reading: { readonly processes: readonly ProcessIdentityRecord[] },
  pgid: number,
): ProcessIdentityRecord[] {
  return reading.processes.filter((p) => p.pgid === pgid);
}

/**
 * Add `members` to the group's confirmed membership. Earlier confirmations are
 * kept: a `(pid, startTime)` pair names one process for its whole life, so a
 * record for a process that has since exited can never match anything else.
 */
function recordConfirmedMembers(
  target: SpawnedProcessGroupTarget,
  members: readonly ProcessIdentityRecord[],
): void {
  const added = members.filter(
    (member) => !target.verifiedMembers.some((k) => sameProcess(k, member)),
  );
  if (added.length > 0) {
    target.verifiedMembers = [...target.verifiedMembers, ...added];
  }
}

/** The membership read started when a group's leader was reaped. */
interface GroupExitRead {
  /** Resolves once that read has been recorded (or has failed). */
  settled?: Promise<void>;
}

/**
 * Per-target exit watches. Kept off the public target type: it is the gate's
 * own bookkeeping, not evidence a caller supplies.
 */
const groupExitReads = new WeakMap<SpawnedProcessGroupTarget, GroupExitRead>();

/**
 * Arrange for the group's membership to be read the moment its leader is
 * reaped. Called only while the leader is unreaped, so the `exit` event has not
 * fired yet. Node emits `exit` in the callback that reaps the child, and the
 * read is started synchronously from it, so the group cannot have emptied and
 * been reused before the read began: every member it lists is ours (residual:
 * reuse during the read, 008 §5.1). This is what captures a process forked
 * after an earlier step, such as work a SIGTERM trap starts before exiting.
 */
function watchLeaderExit(
  target: SpawnedProcessGroupTarget,
  readTable: ProcessTableReader,
): void {
  if (typeof target.leader.once !== 'function') return;
  if (groupExitReads.has(target)) return;
  const watch: GroupExitRead = {};
  groupExitReads.set(target, watch);
  target.leader.once('exit', () => {
    let reading: Promise<ProcessTableReading>;
    try {
      reading = readTable();
    } catch (error) {
      reading = Promise.resolve({
        supported: false,
        reason: errorMessage(error),
      });
    }
    watch.settled = reading.then(
      (result) => {
        if (result.supported) {
          recordConfirmedMembers(target, groupMembers(result, target.pgid));
        }
      },
      () => {
        // A failed read confirms nothing; the next step re-reads and decides.
      },
    );
  });
}

/**
 * Interval between grace-period membership readings (see
 * {@link GroupMembershipTracking}). It bounds the hand-off window that tracking
 * cannot see. On macOS a reading is one `/bin/ps` run of about 40-50 ms, so
 * 250 ms keeps `ps` running for at most about a sixth of the grace period and
 * takes about 20 readings across a 5 s grace; on Linux a reading is a pass over
 * `/proc` that is cheaper still. A shorter interval would put `ps` runs nearly
 * back to back on macOS for little gain against a window that cannot be
 * closed anyway.
 *
 * @internal
 */
export const MEMBERSHIP_READ_INTERVAL_MS = 250;

/** Live grace-period tracking for one group target. */
interface MembershipTracking {
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The reading in flight, which never rejects. */
  inFlight: Promise<void> | undefined;
  stop(): void;
}

/** Per-target tracking. Like {@link groupExitReads}, the gate's own state. */
const membershipTracking = new WeakMap<
  SpawnedProcessGroupTarget,
  MembershipTracking
>();

/**
 * Start re-reading the group's membership every
 * {@link MEMBERSHIP_READ_INTERVAL_MS} until stopped (see
 * {@link GroupMembershipTracking} for the stop conditions).
 */
function startMembershipTracking(
  target: SpawnedProcessGroupTarget,
  readTable: ProcessTableReader,
  request: GroupMembershipTracking,
): void {
  const { signal } = request;
  if (signal?.aborted === true) return;
  const deadline = Date.now() + request.untilMs;
  const tracking: MembershipTracking = {
    stopped: false,
    timer: undefined,
    inFlight: undefined,
    stop() {
      if (tracking.stopped) return;
      tracking.stopped = true;
      clearTimeout(tracking.timer);
      tracking.timer = undefined;
      signal?.removeEventListener('abort', onAbort);
      if (membershipTracking.get(target) === tracking) {
        membershipTracking.delete(target);
      }
    },
  };
  const onAbort = (): void => {
    tracking.stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  membershipTracking.set(target, tracking);

  const scheduleNext = (): void => {
    if (tracking.stopped) return;
    if (Date.now() + MEMBERSHIP_READ_INTERVAL_MS > deadline) {
      tracking.stop();
      return;
    }
    tracking.timer = setTimeout(() => {
      tracking.timer = undefined;
      if (tracking.stopped) return;
      tracking.inFlight = readMembershipOnce(target, readTable).then(
        (verdict) => {
          tracking.inFlight = undefined;
          if (verdict === 'stop') tracking.stop();
          else scheduleNext();
        },
      );
    }, MEMBERSHIP_READ_INTERVAL_MS);
    tracking.timer.unref();
  };
  scheduleNext();
}

/**
 * Stop any tracking on `target`. Returns the reading still in flight, if any,
 * so the caller can let its confirmations land before it reads the group.
 */
function endMembershipTracking(
  target: SpawnedProcessGroupTarget,
): Promise<void> | undefined {
  const tracking = membershipTracking.get(target);
  if (tracking === undefined) return undefined;
  tracking.stop();
  return tracking.inFlight;
}

/**
 * One grace-period membership reading. Confirms the reading's members when it
 * is provably ours (started while the leader was unreaped, or still holding a
 * confirmed member) and says whether tracking should go on. Never rejects.
 */
async function readMembershipOnce(
  target: SpawnedProcessGroupTarget,
  readTable: ProcessTableReader,
): Promise<'continue' | 'stop'> {
  const leaderUnreapedAtReadStart = isChildUnreaped(target.leader);
  let reading: ProcessTableReading;
  try {
    const pending = readTable();
    // A read started at the leader's exit may confirm members this reading
    // relies on for continuity; let it land before judging.
    if (!leaderUnreapedAtReadStart) await groupExitReads.get(target)?.settled;
    reading = await pending;
  } catch {
    return 'continue';
  }
  if (!reading.supported) return 'continue';
  const members = groupMembers(reading, target.pgid);
  // An emptied group can never gain members again under this id.
  if (members.length === 0) return 'stop';
  const continuous =
    leaderUnreapedAtReadStart ||
    members.some((member) =>
      target.verifiedMembers.some((known) => sameProcess(known, member)),
    );
  // Once continuity is lost, no later reading can restore it.
  if (!continuous) return 'stop';
  recordConfirmedMembers(target, members);
  return 'continue';
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

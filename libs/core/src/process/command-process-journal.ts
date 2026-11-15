/**
 * Durable command ownership and restart reconciliation (008 §4.2). The life
 * nonce is committed before any command can spawn, so even SIGKILL inside
 * spawn cannot leave identifiable work without a durable attribution record.
 * Numeric PIDs are suspicions only; boot, inherited mark and fresh start-time
 * identity must all agree before the shared signal gate can send anything.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ensurePrivateDir,
  restrictExistingPathMode,
  withRestrictedUmask,
} from '../security/local-permissions.js';
import {
  COMMAND_LIFE_ENV,
  readBootIdentity,
  readCommandMarks,
  readCommandTerminal,
  readDarwinCommandTerminals,
  type CommandTerminalEvidence,
} from './command-process-marks.js';
import { withDarwinCommandMarkReader } from './darwin-command-marks.js';
import { sendVerifiedSignal, type SignalOutcome } from './process-identity.js';
import {
  readProcessTable,
  type ProcessIdentityRecord,
} from './process-table.js';

/** Source-side ownership seam, also usable by a daemon-independent command supervisor. @public */
export interface CommandProcessOwner {
  /** Await the committed admission mark before spawning, then apply it after authored env. */
  environment(): Promise<Readonly<Record<string, string>>>;
  /** Persist the directly spawned identifier as a suspicion, never proof of identity. */
  spawned(pid: number): void;
  /** Retain an exited child's original-group suspicion; surviving members still need accounting. */
  exited(pid: number): void;
}

/** One durable decision, suitable for a future active-warning surface. @public */
export interface RestartSweepOutcome {
  /** Reaped requires terminal evidence; failed includes a sent signal with unconfirmed termination. */
  readonly status: 'reaped' | 'abstained' | 'gone' | 'failed' | 'owner-alive';
  /** The durable nonce of the daemon life that originally admitted this work. */
  readonly life: string;
  /** The considered identifier; absent only for discovery or record-level failures. */
  readonly pid?: number;
  /** Why cleanup was withheld, failed or was unnecessary. */
  readonly reason?: string;
  /** Evidence is deliberately limited to identity; never argv or environment contents. */
  readonly evidence?: ProcessIdentityRecord & {
    readonly boot: string;
    readonly mark: string;
    /** A same-group member may be identified through an already marked anchor. */
    readonly via: 'inherited-mark' | 'group-continuity';
    readonly groupAnchor?: ProcessIdentityRecord;
  };
}

/** An empty complete pass is different from unavailable discovery or an interrupted pass. @public */
export interface RestartSweepResult {
  /** Complete means discovery finished; individual outcomes can still contain abstentions or failures. */
  readonly status: 'running' | 'complete' | 'incomplete';
  /** UTC timestamp identifying when this startup reconciliation began. */
  readonly startedAt: string;
  /** Incrementally committed decisions, including successful and deliberately withheld cleanup. */
  readonly outcomes: readonly RestartSweepOutcome[];
}

/** Durable records are validated before identifiers can reach the signal gate. */
const identitySchema = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int(),
  startTime: z.string(),
});
const lifeSchema = z.object({
  life: z.uuid(),
  boot: z.string(),
  owner: z.string().transform((value, context) => {
    try {
      return identitySchema.nullable().parse(JSON.parse(value));
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid daemon identity' });
      return z.NEVER;
    }
  }),
});
const pidSchema = z.object({ pid: z.number().int().positive() });

/**
 * Per-workspace journal beside the runtime database. FULL synchronous SQLite
 * commits make the pre-spawn marker crash-safe; completed old lives are retired,
 * abstentions remain retryable, and only the most recent 20 sweep receipts remain.
 * @public
 */
export class CommandProcessJournal implements CommandProcessOwner {
  /** Identity work is deferred until real reconciliation or the first command admission. */
  private boot: string | undefined;
  private owner: ProcessIdentityRecord | undefined;
  private identityReady: Promise<void> | undefined;
  private registered = false;
  /** Transient tokens invalidate only refreshed hints in concurrent admission snapshots. */
  private readonly hintRevisions = new Map<number, symbol>();
  private constructor(
    private readonly sql: Database.Database,
    private readonly workspace: string,
    private readonly life: string,
  ) {}

  /** Open durable storage without scanning the host when no command life needs reconciliation. */
  static open(dbPath: string, workspace: string): CommandProcessJournal {
    const filename =
      dbPath === ':memory:' ? ':memory:' : `${dbPath}.commands.sqlite`;
    if (filename !== ':memory:') ensurePrivateDir(path.dirname(filename));
    const sql = withRestrictedUmask(() => new Database(filename));
    try {
      if (filename !== ':memory:') restrictExistingPathMode(filename, 0o600);
      sql.pragma('synchronous = FULL');
      sql.exec(`
        CREATE TABLE IF NOT EXISTS command_lives(life TEXT PRIMARY KEY, workspace TEXT NOT NULL, boot TEXT NOT NULL, owner TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS command_pids(life TEXT NOT NULL, pid INTEGER NOT NULL, PRIMARY KEY(life,pid));
        CREATE TABLE IF NOT EXISTS restart_sweeps(id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, result TEXT NOT NULL);
      `);
      return new CommandProcessJournal(sql, workspace, randomUUID());
    } catch (error) {
      sql.close();
      throw error;
    }
  }

  /** Commit the nonce and owner identity before the source receives permission to spawn. */
  async environment(): Promise<Readonly<Record<string, string>>> {
    await this.initializeIdentity();
    if (this.registered) await this.retireEmptyGroups();
    if (!this.registered) {
      this.sql
        .prepare('INSERT INTO command_lives VALUES(?,?,?,?)')
        .run(
          this.life,
          this.workspace,
          this.boot ?? '',
          JSON.stringify(this.owner ?? null),
        );
      this.registered = true;
    }
    return { [COMMAND_LIFE_ENV]: this.life };
  }

  /**
   * Admission is already awaited before spawn. Use that boundary to retire
   * empty numeric suspicions from this life, so ordinary completed commands
   * cannot grow the retained set until daemon restart. Keep the nonce for
   * detached marked work, and keep every group that could still have a survivor.
   * Unavailable discovery never proves emptiness and cannot discard a hint.
   */
  private async retireEmptyGroups(): Promise<void> {
    const rows = this.sql
      .prepare('SELECT pid FROM command_pids WHERE life = ?')
      .all(this.life);
    if (rows.length === 0) return;
    const revisions = new Map<number, symbol | undefined>();
    for (const raw of rows) {
      const hint = pidSchema.safeParse(raw);
      if (hint.success)
        revisions.set(hint.data.pid, this.hintRevisions.get(hint.data.pid));
    }
    const table = await readProcessTable();
    if (!table.supported) return;
    const occupied = new Set(table.processes.flatMap((p) => [p.pid, p.pgid]));
    const retire = this.sql.prepare(
      'DELETE FROM command_pids WHERE life = ? AND pid = ?',
    );
    this.sql.transaction(() => {
      for (const [pid, revision] of revisions) {
        // A refreshed hint can describe work newer than this snapshot, while
        // unrelated bookkeeping must not prevent older empty hints retiring.
        if (!occupied.has(pid) && this.hintRevisions.get(pid) === revision) {
          retire.run(this.life, pid);
          this.hintRevisions.delete(pid);
        }
      }
    })();
  }

  /** No lifecycle row is published until a real command asks for its admission mark. */
  private initializeIdentity(): Promise<void> {
    this.identityReady ??= (async () => {
      this.boot = await readBootIdentity();
      const table = await readProcessTable();
      this.owner = table.supported
        ? table.processes.find((p) => p.pid === process.pid)
        : undefined;
    })();
    return this.identityReady;
  }
  /**
   * Recording a numeric suspicion is synchronous before the spawn caller returns.
   * A fresh token protects that work from older in-flight admission snapshots.
   */
  spawned(pid: number): void {
    this.hintRevisions.set(pid, Symbol());
    this.sql
      .prepare('INSERT OR IGNORE INTO command_pids VALUES(?,?)')
      .run(this.life, pid);
  }
  /**
   * A direct exit cannot prove its original group empty. Keep the numeric
   * suspicion until a readable snapshot proves the group empty, so an environment-cleared survivor
   * gets an abstention even without a marked anchor. This never grants signal
   * authority: only fresh mark or confirmed membership evidence can do that.
   */
  exited(pid: number): void {
    this.spawned(pid);
  }
  /** Release persistence after the daemon has finished admitting command work. */
  close(): void {
    this.sql.close();
  }

  /** Reconcile only dead lives in this workspace, never a numerically matching group. */
  async sweep(): Promise<RestartSweepResult> {
    return withDarwinCommandMarkReader(() => this.reconcile());
  }

  /** One reconciliation scope retains a single helper while every gate still reads fresh evidence. */
  private async reconcile(): Promise<RestartSweepResult> {
    const outcomes: RestartSweepOutcome[] = [];
    const startedAt = new Date().toISOString();
    const receipt = this.sql
      .prepare('INSERT INTO restart_sweeps(workspace,result) VALUES(?,?)')
      .run(
        this.workspace,
        JSON.stringify({ status: 'running', startedAt, outcomes }),
      );
    /** Save decisions before further asynchronous work can interrupt their accounting. */
    const save = (status: RestartSweepResult['status']): RestartSweepResult => {
      const result: RestartSweepResult = { status, startedAt, outcomes };
      this.sql
        .prepare('UPDATE restart_sweeps SET result = ? WHERE id = ?')
        .run(JSON.stringify(result), receipt.lastInsertRowid);
      return result;
    };
    /** Keep successful empty passes and failed passes under the same receipt bound. */
    const finish = (
      status: RestartSweepResult['status'],
    ): RestartSweepResult => {
      this.sql
        .prepare(
          'DELETE FROM restart_sweeps WHERE workspace = ? AND id NOT IN (SELECT id FROM restart_sweeps WHERE workspace = ? ORDER BY id DESC LIMIT 20)',
        )
        .run(this.workspace, this.workspace);
      return save(status);
    };
    const rows = this.sql
      .prepare(
        'SELECT life, boot, owner FROM command_lives WHERE workspace = ? AND life != ?',
      )
      .all(this.workspace, this.life);
    // Without an admitted earlier command life there is no nonce to attribute.
    // A complete empty receipt needs no ps, sysctl or /proc scan at readiness.
    if (rows.length === 0) return finish('complete');
    const table = await readProcessTable();
    if (!table.supported) {
      outcomes.push({
        status: 'abstained',
        life: this.life,
        reason: table.reason,
      });
      return finish('incomplete');
    }
    this.boot = await readBootIdentity();
    this.owner = table.processes.find((p) => p.pid === process.pid);
    this.identityReady = Promise.resolve();
    const marks = await readCommandMarks(table.processes.map((p) => p.pid));
    if (!marks.supported) {
      outcomes.push({
        status: 'abstained',
        life: this.life,
        reason: marks.reason,
      });
      return finish('incomplete');
    }
    let complete = (marks.unreadable?.length ?? 0) === 0;
    // An unreadable environment is a discovery obstacle, never evidence that
    // its process belongs to a command life. Preserve the PID so consumers can
    // distinguish that uncertainty from a readable mark-erased escape.
    for (const pid of marks.unreadable ?? [])
      outcomes.push({
        status: 'abstained',
        life: this.life,
        pid,
        reason: marks.unreadableReason ?? UNREADABLE_OWNERSHIP_REASON,
      });
    // A later identity query can block or the daemon can crash. The running
    // receipt must already retain the obstacles discovered by this reading.
    if (!complete) save('running');
    const lives = rows.map((raw) => lifeSchema.safeParse(raw));
    // A daemon can itself inherit an old command mark. A currently registered
    // live daemon owner is never cleanup work, including this very process.
    // PID/start-time equality includes zombies. Only positive running evidence
    // means an owner can still supervise work. Unknown terminal evidence protects
    // its identity and withholds reconciliation rather than assuming death.
    const ownerStates = new Map<
      number,
      Awaited<ReturnType<typeof readCommandTerminal>>
    >();
    for (const parsed of lives) {
      if (
        !parsed.success ||
        parsed.data.boot !== this.boot ||
        parsed.data.owner === null
      )
        continue;
      const owner = parsed.data.owner;
      if (
        table.processes.some(
          (p) => p.pid === owner.pid && p.startTime === owner.startTime,
        )
      )
        ownerStates.set(owner.pid, await readCommandTerminal(owner));
    }
    const liveOwners = new Set(
      [...ownerStates]
        .filter(([, state]) => state !== 'terminated')
        .map(([pid]) => pid),
    );
    for (const parsed of lives) {
      if (!parsed.success) {
        complete = false;
        outcomes.push({
          status: 'abstained',
          life: 'invalid-record',
          reason: 'Invalid durable ownership record',
        });
        save('running');
        continue;
      }
      const previous = parsed.data;
      if (previous.life === this.life) continue;
      const sameBoot = this.boot !== undefined && previous.boot === this.boot;
      const owner = previous.owner;
      if (
        sameBoot &&
        owner !== null &&
        liveOwners.has(owner.pid) &&
        table.processes.some(
          (p) => p.pid === owner.pid && p.startTime === owner.startTime,
        )
      ) {
        const running = ownerStates.get(owner.pid) === 'running';
        outcomes.push({
          status: running ? 'owner-alive' : 'abstained',
          life: previous.life,
          pid: owner.pid,
          ...(!running
            ? {
                reason:
                  'Previous daemon terminal state is unavailable; death cannot be confirmed',
              }
            : {}),
        });
        save('running');
        continue;
      }
      if (sameBoot && owner === null) {
        outcomes.push({
          status: 'abstained',
          life: previous.life,
          reason:
            'Previous daemon identity was unavailable; death cannot be confirmed',
        });
        save('running');
        continue;
      }
      const recorded = new Set<number>();
      let invalidPidRecords = false;
      for (const raw of this.sql
        .prepare('SELECT pid FROM command_pids WHERE life = ?')
        .all(previous.life)) {
        const pid = pidSchema.safeParse(raw);
        if (pid.success) recorded.add(pid.data.pid);
        else {
          complete = false;
          invalidPidRecords = true;
          outcomes.push({
            status: 'abstained',
            life: previous.life,
            reason: 'Invalid durable command PID record',
          });
        }
      }
      // Invalid suspicions are already decided abstentions. Persist them
      // together before anchor confirmation can suspend reconciliation.
      if (invalidPidRecords) save('running');
      let reading = table;
      let ownership = marks;
      let retained = !complete;
      // A disappearance is provisional emptiness: enumeration can miss both a
      // parent and its last fork. Only a later readable, vacant snapshot can
      // discharge this retention; an occupied numeric hint grants no authority.
      const disappearance = { pending: false };
      // Once an identifier is considered, never retry it during this sweep.
      // In particular, start-time disagreement cannot later become permission.
      const visited = new Set<number>();
      // Terminal incarnations may remain visible without readable environments.
      // Retain their full identity so a recycled PID is still discovered normally.
      const reaped = new Map<number, ProcessIdentityRecord>();
      // Once a group loses cleanup certainty, no later discovery in this sweep
      // may remove its bound, including a watchdog discovered in a later pass.
      const groupVetoes = new Map<number, string>();
      for (let round = 0; round < MAX_DISCOVERY_PASSES; round++) {
        const progress = { observed: false };
        /** Every observed exit preserves attribution and earns bounded rediscovery. */
        const observeVanish = (pid: number, reason?: string): void => {
          disappearance.pending = true;
          progress.observed = true;
          visited.add(pid);
          outcomes.push({
            status: 'gone',
            life: previous.life,
            pid,
            ...(reason === undefined ? {} : { reason }),
          });
        };
        const markedMembers = reading.processes.filter(
          (member) =>
            ownership.marks.get(member.pid) === previous.life &&
            !liveOwners.has(member.pid) &&
            member.pid !== process.pid,
        );
        // A marked anchor can disappear during confirmation. Remember its group
        // as suspicion before that await, without granting membership authority.
        this.sql.transaction(() => {
          const remember = this.sql.prepare(
            'INSERT OR IGNORE INTO command_pids VALUES(?,?)',
          );
          for (const member of sameBoot ? markedMembers : []) {
            if (member.pgid > 0 && !recorded.has(member.pgid)) {
              remember.run(previous.life, member.pgid);
              recorded.add(member.pgid);
            }
          }
        })();
        const confirmed = await confirmGroupAnchors(
          sameBoot ? markedMembers : [],
        );
        if (!confirmed.supported) {
          complete = false;
          retained = true;
          outcomes.push({
            status: 'abstained',
            life: previous.life,
            reason: confirmed.reason,
          });
          break;
        }
        for (const pid of confirmed.gone) {
          if (!visited.has(pid)) observeVanish(pid);
        }
        if (confirmed.gone.length > 0) save('running');
        for (const pid of confirmed.changed) {
          visited.add(pid);
          retained = true;
          outcomes.push({
            status: 'abstained',
            life: previous.life,
            pid,
            reason:
              'Process identity or group changed while ownership marks were read; identifier may have been reused',
          });
          save('running');
        }
        const anchors = confirmed.anchors;
        const candidates = new Set([
          ...recorded,
          ...reading.processes
            .filter(
              (p) =>
                ownership.marks.get(p.pid) === previous.life ||
                anchors.has(p.pgid) ||
                recorded.has(p.pgid),
            )
            .map((p) => p.pid),
        ]);
        const pending = [...candidates].filter((pid) => !visited.has(pid));
        // Readable mark-erased members use existing group continuity. Consider
        // them before marked companions that could hold the group's bound.
        pending.sort(
          (a, b) =>
            Number(ownership.marks.get(a) === previous.life) -
            Number(ownership.marks.get(b) === previous.life),
        );
        if (pending.length === 0 && !progress.observed) break;
        const byPid = new Map(reading.processes.map((p) => [p.pid, p]));
        // Absence decisions use one immutable snapshot and involve no awaits.
        // Batch their receipt before further identity reads,
        // instead of FULL-sync rewriting an ever-growing receipt per gone PID.
        const gone = pending.filter((pid) => !byPid.has(pid));
        if (gone.length > 0) {
          this.sql.transaction(() => {
            for (const pid of gone) observeVanish(pid);
            save('running');
          })();
        }
        // Only a positively attributed watchdog can supply a bound to preserve.
        // Keep its discovery evidence through final mark unreadability: losing
        // that reading cannot prove the timer gone. Terminal incarnations no
        // longer supply a bound, even while their zombie rows remain visible.
        // A forged role can only withhold signals, never authorize another PID.
        const watchdogs = new Map(
          reading.processes
            .filter((record) => {
              const terminal = reaped.get(record.pid);
              return (
                sameBoot &&
                ownership.marks.get(record.pid) === previous.life &&
                ownership.watchdogs?.has(record.pid) &&
                !confirmed.changed.includes(record.pid) &&
                !confirmed.gone.includes(record.pid) &&
                !(
                  terminal?.startTime === record.startTime &&
                  terminal.pgid === record.pgid
                )
              );
            })
            .map((record) => [record.pid, record] as const),
        );
        const boundedGroups = new Set(
          [...watchdogs.values()].map((record) => record.pgid),
        );
        for (const record of reading.processes) {
          if (!recorded.has(record.pgid)) continue;
          const reason = ownership.unreadable?.includes(record.pid)
            ? 'ownership mark is unreadable'
            : confirmed.changed.includes(record.pid)
              ? 'process identity changed'
              : liveOwners.has(record.pid) || record.pid === process.pid
                ? 'member is a registered daemon owner'
                : !sameBoot
                  ? 'boot identity differs or is unavailable'
                  : undefined;
          if (reason !== undefined) groupVetoes.set(record.pgid, reason);
        }
        // A marked companion may be a watchdog. With only one mark, readable
        // mark-erased members run first and can veto that last companion. More
        // marks need one final table even across groups: PID reuse during mark
        // reads can introduce an uncertain member into another recorded group.
        const grouped =
          pending.filter(
            (pid) =>
              byPid.has(pid) && ownership.marks.get(pid) === previous.life,
          ).length > 1;
        // Batch callbacks commit decided non-signal outcomes before another
        // await. Keep their PIDs so the result loop never appends them twice.
        const committedDecisions = new Set<number>();
        const commitDecisions = (
          decisions: ReadonlyMap<number, { readonly outcome: SignalOutcome }>,
        ): void => {
          let dirty = false;
          for (const [pid, { outcome }] of decisions) {
            if (outcome.status === 'sent' || committedDecisions.has(pid))
              continue;
            committedDecisions.add(pid);
            visited.add(pid);
            dirty = true;
            if (outcome.status === 'not-needed') {
              observeVanish(pid, outcome.detail);
            } else {
              retained = true;
              outcomes.push({
                status: outcome.status === 'abstained' ? 'abstained' : 'failed',
                life: previous.life,
                pid,
                reason:
                  outcome.status === 'abstained'
                    ? outcome.abstention.reason
                    : outcome.detail,
              });
            }
          }
          if (dirty) save('running');
        };
        const batchDecisions =
          process.platform === 'darwin' || grouped
            ? await signalCandidateBatch(
                pending.flatMap((pid) => {
                  const record = byPid.get(pid);
                  const inherited = ownership.marks.get(pid) === previous.life;
                  return sameBoot &&
                    record &&
                    !liveOwners.has(pid) &&
                    pid !== process.pid &&
                    (inherited || anchors.has(record.pgid))
                    ? [{ record, inherited }]
                    : [];
                }),
                this.boot,
                previous.life,
                groupVetoes,
                boundedGroups,
                watchdogs,
                reaped,
                commitDecisions,
              )
            : undefined;
        // Synchronous abstentions share one durable write before the next await.
        let pendingAbstentions = false;
        for (const pid of pending) {
          const record = byPid.get(pid);
          if (record === undefined) continue;
          visited.add(pid);
          if (committedDecisions.has(pid)) continue;
          if (liveOwners.has(pid) || pid === process.pid) {
            outcomes.push({
              status: 'abstained',
              life: previous.life,
              pid,
              reason:
                'Identifier belongs to a currently registered daemon owner',
            });
            retained = true;
            save('running');
            continue;
          }
          const inherited = ownership.marks.get(pid) === previous.life;
          const anchor = anchors.get(record.pgid);
          if (
            sameBoot &&
            !inherited &&
            anchor === undefined &&
            ownership.unreadable?.includes(pid)
          ) {
            // Discovery already durably recorded this exact uncertainty. A stored
            // numeric suspicion supplies no new evidence or decision to append.
            retained = true;
            continue;
          }
          const veto = boundedGroups.has(record.pgid)
            ? groupVetoes.get(record.pgid)
            : undefined;
          if (veto !== undefined) {
            outcomes.push({
              status: 'abstained',
              life: previous.life,
              pid,
              reason: `Preserved group ${String(record.pgid)} bound: ${veto}`,
            });
            retained = true;
            pendingAbstentions = true;
            continue;
          }
          if (!sameBoot || (!inherited && anchor === undefined)) {
            outcomes.push({
              status: 'abstained',
              life: previous.life,
              pid,
              reason: !sameBoot
                ? 'Boot identity differs or is unavailable'
                : 'Inherited ownership mark differs or is unreadable; group continuity is unconfirmed',
            });
            retained = true;
            save('running');
            continue;
          }
          if (pendingAbstentions && batchDecisions === undefined) {
            save('running');
            pendingAbstentions = false;
          }
          const decision = batchDecisions?.get(pid);
          const outcome =
            decision?.outcome ??
            (await sendVerifiedSignal(
              { kind: 'recorded-process', record },
              'SIGKILL',
              {
                action: 'restart command cleanup',
                // Discovery positively records group membership while a marked
                // anchor exists. That immutable process identity remains evidence
                // after the anchor is killed; a bare PGID never grants authority.
                readProcessTable: async () => {
                  const freshBoot = await readBootIdentity();
                  let markConfirmed = true;
                  if (inherited) {
                    const freshMarks = await readCommandMarks([pid]);
                    markConfirmed =
                      freshMarks.supported &&
                      freshMarks.marks.get(pid) === previous.life;
                  }
                  // Identity is the LAST asynchronous query. An environment read
                  // must not leave the gate comparing a pre-recycling snapshot.
                  const fresh = await readProcessTable();
                  if (fresh.supported)
                    refreshWatchdogBounds(
                      boundedGroups,
                      watchdogs,
                      fresh.processes,
                    );
                  if (
                    !fresh.supported ||
                    !fresh.processes.some((p) => p.pid === pid)
                  )
                    return fresh;
                  if (freshBoot !== this.boot || !markConfirmed)
                    return {
                      supported: false,
                      reason:
                        'Boot or inherited ownership mark could not be confirmed at signal time',
                    };
                  // The last marked companion may be the watchdog. A member
                  // first seen in this final table has no ownership decision;
                  // keep the bound until that uncertainty can be reconciled.
                  // The shared per-process gate still owns the target's own comparison.
                  for (const member of fresh.processes) {
                    const known = byPid.get(member.pid);
                    if (
                      member.pid !== pid &&
                      member.pgid === record.pgid &&
                      (known?.pgid !== member.pgid ||
                        known.startTime !== member.startTime)
                    ) {
                      groupVetoes.set(
                        record.pgid,
                        'new group member has unverified identity',
                      );
                    }
                  }
                  const veto = boundedGroups.has(record.pgid)
                    ? groupVetoes.get(record.pgid)
                    : undefined;
                  if (veto !== undefined) {
                    return {
                      supported: false,
                      reason: `Preserved group ${String(record.pgid)} bound: ${veto}`,
                    };
                  }
                  return fresh;
                },
                reportAbstention: () => {
                  /* Durable outcomes are the future active-warning input. */
                },
              },
            ));
          if (outcome.status === 'sent') {
            progress.observed = true;
            const terminal =
              decision?.terminal ?? (await readCommandTerminal(record));
            outcomes.push({
              status: terminal === 'terminated' ? 'reaped' : 'failed',
              ...(terminal !== 'terminated'
                ? {
                    reason: `SIGKILL sent, but termination could not be confirmed (${terminal})`,
                  }
                : {}),
              life: previous.life,
              pid,
              evidence: {
                ...record,
                boot: previous.boot,
                mark: previous.life,
                via: inherited ? 'inherited-mark' : 'group-continuity',
                ...(!inherited && anchor !== undefined
                  ? { groupAnchor: anchor }
                  : {}),
              },
            });
            if (terminal === 'terminated') {
              reaped.set(pid, record);
              // A confirmed reap ends this incarnation, not its original group.
              // Retain the durable numeric suspicion until no member remains,
              // so unmarked late survivors stay accountable across restarts.
              // The hint alone never grants signal authority.
            }
            // Keep the nonce until a later empty startup can retire it: a
            // kernel-delayed exit must never erase attribution of late forks.
            retained = true;
          } else if (outcome.status === 'abstained') {
            groupVetoes.set(record.pgid, outcome.abstention.reason);
            retained = true;
            outcomes.push({
              status: 'abstained',
              life: previous.life,
              pid,
              reason: outcome.abstention.reason,
            });
          } else if (outcome.status === 'not-needed') {
            // Includes disappearance in the final table and ESRCH at delivery.
            observeVanish(pid, outcome.detail);
          } else {
            retained = true;
            outcomes.push({
              status: 'failed',
              life: previous.life,
              pid,
              reason: outcome.detail,
            });
          }
          // Shared decisions are already one uninterrupted batch. Commit them
          // together before the next asynchronous query instead of rewriting
          // an expanding receipt once per survivor with FULL synchronous I/O.
          if (batchDecisions === undefined) save('running');
        }
        if (batchDecisions !== undefined || pendingAbstentions) save('running');
        // Signals and observed exits can expose late forks. Withheld signals
        // alone do not justify rescanning unchanged ownership uncertainty.
        if (!progress.observed) break;
        // Re-read after cleanup or natural exits to discover late forks.
        // This is bounded discovery, not a timer or a retry of failed kills.
        const next = await readProcessTable();
        if (!next.supported) {
          complete = false;
          retained = true;
          outcomes.push({
            status: 'abstained',
            life: previous.life,
            reason: next.reason,
          });
          break;
        }
        const nextMarks = await readCommandMarks(
          next.processes
            .filter((p) => {
              const terminal = reaped.get(p.pid);
              return (
                terminal?.pgid !== p.pgid || terminal.startTime !== p.startTime
              );
            })
            .map((p) => p.pid),
        );
        if (!nextMarks.supported) {
          complete = false;
          retained = true;
          outcomes.push({
            status: 'abstained',
            life: previous.life,
            reason: nextMarks.reason,
          });
          break;
        }
        if ((nextMarks.unreadable?.length ?? 0) > 0) {
          complete = false;
          retained = true;
          for (const pid of nextMarks.unreadable ?? []) {
            const reason =
              nextMarks.unreadableReason ?? UNREADABLE_OWNERSHIP_REASON;
            // Repeated snapshots can preserve one unchanged obstacle while
            // finding new marked work. Record equal uncertainty once per pass,
            // including obstacles already found before selecting an old life.
            if (
              outcomes.some(
                (outcome) =>
                  outcome.pid === pid &&
                  outcome.status === 'abstained' &&
                  outcome.reason === reason,
              )
            ) {
              continue;
            }
            outcomes.push({
              status: 'abstained',
              life: previous.life,
              pid,
              reason,
            });
          }
          // Unrelated uncertainty cannot discard positively identified late
          // forks. Persist it before the next round's identity queries, while
          // keeping both this pass and its life incomplete and retryable.
          save('running');
        }
        reading = next;
        ownership = nextMarks;
        // Only fresh, readable emptiness can discharge a vanished target's
        // suspicion. PID occupancy also preserves it after reuse in a new group.
        // Other retaining outcomes (reaps, abstentions, failures) stay retryable.
        const occupied = new Set(
          next.processes.flatMap((p) => [p.pid, p.pgid]),
        );
        if (
          disappearance.pending &&
          (nextMarks.unreadable?.length ?? 0) === 0 &&
          ![...nextMarks.marks.values()].includes(previous.life) &&
          ![...recorded].some((pid) => occupied.has(pid))
        ) {
          disappearance.pending = false;
          this.sql.transaction(() => {
            this.sql
              .prepare('DELETE FROM command_pids WHERE life = ?')
              .run(previous.life);
            recorded.clear();
          })();
        }
        if (round === MAX_DISCOVERY_PASSES - 1) {
          const markedGroups = new Set(
            reading.processes
              .filter(
                (p) =>
                  ownership.marks.get(p.pid) === previous.life &&
                  !liveOwners.has(p.pid) &&
                  p.pid !== process.pid,
              )
              .map((p) => p.pgid),
          );
          const outstanding = reading.processes.filter(
            (p) =>
              !visited.has(p.pid) &&
              (ownership.marks.get(p.pid) === previous.life ||
                markedGroups.has(p.pgid) ||
                recorded.has(p.pgid)),
          );
          if (outstanding.length > 0) {
            complete = false;
            retained = true;
            for (const candidate of outstanding)
              outcomes.push({
                status: 'abstained',
                life: previous.life,
                pid: candidate.pid,
                reason:
                  'Bounded discovery did not reach a quiet process snapshot',
              });
          }
        }
      }
      if (!retained && !disappearance.pending)
        this.sql.transaction(() => {
          this.sql
            .prepare('DELETE FROM command_pids WHERE life = ?')
            .run(previous.life);
          this.sql
            .prepare('DELETE FROM command_lives WHERE life = ?')
            .run(previous.life);
        })();
      save('running');
    }
    return finish(complete ? 'complete' : 'incomplete');
  }
}

/** Bound startup discovery even if marked work continuously forks while being reconciled. */
const MAX_DISCOVERY_PASSES = 8;

/** Missing mark evidence names an uncertainty; it does not attribute the PID to a command. */
const UNREADABLE_OWNERSHIP_REASON =
  'Same-user ownership mark could not be read; command attribution is unknown';

/**
 * Remove a possible bound only when fresh identity evidence proves every known
 * watchdog in that group absent or replaced. Mark unreadability alone cannot
 * discharge the timer; a remaining matching watchdog protects all its companions.
 * This changes withholding only, never the independent authority of a signal gate.
 */
function refreshWatchdogBounds(
  groups: Set<number>,
  watchdogs: ReadonlyMap<number, ProcessIdentityRecord>,
  processes: readonly ProcessIdentityRecord[],
): void {
  const present = new Map(processes.map((record) => [record.pid, record]));
  const surviving = new Set<number>();
  for (const [pid, record] of watchdogs) {
    const current = present.get(pid);
    if (current?.pgid === record.pgid && current.startTime === record.startTime)
      surviving.add(record.pgid);
  }
  for (const group of groups) if (!surviving.has(group)) groups.delete(group);
}

/** Per-PID gate and terminal evidence; batching never changes the durable outcome vocabulary. */
interface SweepSignalDecision {
  readonly outcome: SignalOutcome;
  readonly terminal?: CommandTerminalEvidence;
}

/**
 * Compose existing ownership and signal gates with a group-wide veto, never group authority.
 * Read boot and all required marks, then identity LAST. Every signal gate runs
 * from that final table in the same microtask turn: no terminal query, journal
 * await, or subsequent discovery can age the snapshot between these signals.
 * Each eligible PID still passes sendVerifiedSignal individually; no stored PGID is sent.
 * Linux shares this batch when several marked candidates could include a watchdog.
 * The synchronous commit sink records non-signal decisions after the in-memory
 * gate batch settles, before any unrelated terminal evidence query. Journal I/O
 * must not block between the final identity snapshot and these signals.
 */
async function signalCandidateBatch(
  candidates: readonly {
    readonly record: ProcessIdentityRecord;
    readonly inherited: boolean;
  }[],
  boot: string | undefined,
  life: string,
  groupVetoes: Map<number, string>,
  boundedGroups: Set<number>,
  watchdogs: ReadonlyMap<number, ProcessIdentityRecord>,
  reaped: ReadonlyMap<number, ProcessIdentityRecord>,
  commitDecisions: (
    decisions: ReadonlyMap<number, SweepSignalDecision>,
  ) => void,
): Promise<ReadonlyMap<number, SweepSignalDecision>> {
  if (candidates.length === 0) return new Map();
  const freshBoot = await readBootIdentity();
  const inheritedPids = candidates
    .filter((candidate) => candidate.inherited)
    .map((candidate) => candidate.record.pid);
  const marks =
    process.platform === 'darwin'
      ? await readCommandMarks(inheritedPids)
      : await readLinuxCandidateMarks(inheritedPids);
  const fresh = await readProcessTable();
  if (fresh.supported)
    refreshWatchdogBounds(boundedGroups, watchdogs, fresh.processes);
  // Evaluate every obstruction before invoking any signal gate. A readable
  // watchdog cannot lend its evidence to another member, nor lose its timer
  // because its own row happened to be enumerated first.
  for (const { record, inherited } of candidates) {
    const current = fresh.supported
      ? fresh.processes.find((p) => p.pid === record.pid)
      : undefined;
    const reason = !fresh.supported
      ? fresh.reason
      : freshBoot !== boot
        ? 'boot identity differs or is unavailable'
        : current !== undefined &&
            (current.startTime !== record.startTime ||
              current.pgid !== record.pgid)
          ? 'process identity changed'
          : current !== undefined &&
              inherited &&
              (!marks.supported || marks.marks.get(record.pid) !== life)
            ? marks.supported
              ? 'ownership mark differs or is unreadable'
              : marks.reason
            : undefined;
    if (reason !== undefined) groupVetoes.set(record.pgid, reason);
  }
  if (fresh.supported) {
    // Reuse or a group change is unverified membership even at a known PID.
    // A former incarnation cannot discharge the current group's bound.
    const known = new Map(reaped);
    for (const { record } of candidates) known.set(record.pid, record);
    // Terminal identities discharge only their own incarnation. Recycled PIDs
    // must still fail this comparison even when their numeric identifier is known.
    const groups = new Set(candidates.map(({ record }) => record.pgid));
    for (const member of fresh.processes) {
      const prior = known.get(member.pid);
      if (
        groups.has(member.pgid) &&
        (prior?.pgid !== member.pgid || prior.startTime !== member.startTime)
      ) {
        groupVetoes.set(
          member.pgid,
          'new group member has unverified identity',
        );
      }
    }
  }
  // Collect preservation decisions without I/O. Every signal must use the
  // final identity snapshot before a FULL-sync receipt save can block and age it.
  const preserved = new Map<number, SweepSignalDecision>();
  for (const { record } of candidates) {
    if (boundedGroups.has(record.pgid) && groupVetoes.has(record.pgid)) {
      preserved.set(record.pid, {
        outcome: {
          status: 'abstained',
          abstention: {
            action: 'restart command cleanup',
            signal: 'SIGKILL',
            target: { kind: 'process', id: record.pid },
            reason: `Preserved group ${String(record.pgid)} bound: ${String(groupVetoes.get(record.pgid))}`,
            observed: [],
          },
        },
      });
    }
  }
  const results = await Promise.all(
    candidates.map(async ({ record, inherited }) => ({
      record,
      outcome:
        preserved.get(record.pid)?.outcome ??
        (await sendVerifiedSignal(
          { kind: 'recorded-process', record },
          'SIGKILL',
          {
            action: 'restart command cleanup',
            readProcessTable: () => {
              if (
                !fresh.supported ||
                !fresh.processes.some((p) => p.pid === record.pid)
              )
                return Promise.resolve(fresh);
              if (
                freshBoot !== boot ||
                (inherited &&
                  (!marks.supported || marks.marks.get(record.pid) !== life))
              )
                return Promise.resolve({
                  supported: false,
                  reason:
                    'Boot or inherited ownership mark could not be confirmed at signal time',
                });
              return Promise.resolve(fresh);
            },
            reportAbstention: () => {
              /* Committed with the batch before terminal queries. */
            },
          },
        )),
    })),
  );
  // Verification abstentions, disappearances and delivery failures are also
  // final decisions; terminal queries for other PIDs must not defer them.
  commitDecisions(
    new Map(results.map(({ record, outcome }) => [record.pid, { outcome }])),
  );
  const sent = results.filter((result) => result.outcome.status === 'sent');
  // Each Linux terminal query already fans out across up to 32 /proc files.
  // Serialize those queries after ALL signals so their descriptor bound remains
  // independent of candidate count and no terminal await ages signal evidence.
  const terminals = new Map<number, CommandTerminalEvidence>();
  if (process.platform === 'darwin') {
    for (const [pid, state] of await readDarwinCommandTerminals(
      sent.map((result) => result.record),
    ))
      terminals.set(pid, state);
  } else {
    for (const { record } of sent)
      terminals.set(record.pid, await readCommandTerminal(record));
  }

  return new Map(
    results.map(({ record, outcome }) => [
      record.pid,
      {
        outcome,
        ...(outcome.status === 'sent'
          ? { terminal: terminals.get(record.pid) ?? 'unavailable' }
          : {}),
      },
    ]),
  );
}

/** Retain Linux's per-PID ownership query; combining results grants no group authority. */
async function readLinuxCandidateMarks(
  pids: readonly number[],
): Promise<Awaited<ReturnType<typeof readCommandMarks>>> {
  const marks = new Map<number, string>();
  for (const pid of pids) {
    const reading = await readCommandMarks([pid]);
    if (!reading.supported) return reading;
    const mark = reading.marks.get(pid);
    if (mark !== undefined) marks.set(pid, mark);
  }
  return { supported: true, marks };
}

/** A failed or changing anchor cannot lend its old group authority to unrelated work. */
type GroupAnchorConfirmation =
  | {
      readonly supported: true;
      readonly anchors: ReadonlyMap<number, ProcessIdentityRecord>;
      readonly changed: readonly number[];
      /** Absence can hide late forks; it is not identity disagreement. */
      readonly gone: readonly number[];
    }
  | { readonly supported: false; readonly reason: string };

/**
 * Sandwich marker discovery between identity readings before recording any
 * group membership. The initial table alone is not evidence for the later
 * marker: a recycled PID may have moved that marker onto a different group.
 * Both incarnation and group must survive the reading, before any kill can
 * remove the anchor whose identity is being established.
 */
async function confirmGroupAnchors(
  marked: readonly ProcessIdentityRecord[],
): Promise<GroupAnchorConfirmation> {
  const anchors = new Map<number, ProcessIdentityRecord>();
  if (marked.length === 0)
    return { supported: true, anchors, changed: [], gone: [] };
  const confirmation = await readProcessTable();
  if (!confirmation.supported) return confirmation;
  const changed: number[] = [];
  const gone: number[] = [];
  for (const member of marked) {
    const current = confirmation.processes.find((p) => p.pid === member.pid);
    if (current === undefined) gone.push(member.pid);
    else if (
      current.startTime !== member.startTime ||
      current.pgid !== member.pgid
    )
      changed.push(member.pid);
    else anchors.set(member.pgid, member);
  }
  return { supported: true, anchors, changed, gone };
}

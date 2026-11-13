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
} from './command-process-marks.js';
import { sendVerifiedSignal } from './process-identity.js';
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
      for (const raw of this.sql
        .prepare('SELECT pid FROM command_pids WHERE life = ?')
        .all(previous.life)) {
        const pid = pidSchema.safeParse(raw);
        if (pid.success) recorded.add(pid.data.pid);
        else {
          complete = false;
          outcomes.push({
            status: 'abstained',
            life: previous.life,
            reason: 'Invalid durable command PID record',
          });
        }
      }
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
        for (const pid of pending) {
          const record = byPid.get(pid);
          if (record === undefined) continue;
          visited.add(pid);
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
          const outcome = await sendVerifiedSignal(
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
                return fresh;
              },
              reportAbstention: () => {
                /* Durable outcomes are the future active-warning input. */
              },
            },
          );
          if (outcome.status === 'sent') {
            progress.observed = true;
            const terminal = await readCommandTerminal(record);
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
          save('running');
        }
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

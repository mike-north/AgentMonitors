import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '@agentmonitors/core';
import { getCliVersion } from './cli-version.js';
import { resolveDataRoot, workspaceHash } from './workspace-paths.js';

/**
 * Durable liveness records for the two delivery transports (006 §3/§4/§5).
 *
 * A transport that is *up* is not the same as a transport that is *delivering
 * to this workspace*. The two transports fail in opposite ways:
 *
 * - `hook deliver` spawns a fresh CLI per prompt, so it re-resolves its
 *   workspace, socket, and binary every time — it self-heals, but it leaves no
 *   trace, so "is the hook wired up at all?" is unanswerable from outside.
 * - `channel serve` is a long-lived MCP subprocess that freezes its
 *   environment (`HOME`, `CLAUDE_PROJECT_DIR`, resolved socket, CLI binary) at
 *   session start. It keeps looking healthy after the daemon or workspace it
 *   resolved is gone, or after it resolved a *different* workspace than the one
 *   whose monitors the agent is waiting on.
 *
 * Both therefore write the same record: a heartbeat naming the process, the
 * exact binary/version serving it, the environment it resolved, the socket and
 * workspace it is bound to, and when it last actually delivered something.
 * `doctor` reads them back and compares each against its *own* resolution of
 * the same values, which is what makes a misbound or stale transport visible
 * instead of silent.
 *
 * ## Why records carry an explicit TTL
 *
 * `updatedAt + ttlMs` is a lease, not just a display field. A channel server
 * that dies without cleanup (SIGKILL, host crash) leaves its file behind; a
 * consumer must be able to decide the record is dead *without* trusting the
 * writer to have removed it. Expressing that as an owner-declared TTL — rather
 * than a reader-side constant — keeps the decision correct if a future writer
 * heartbeats on a different cadence, and gives a lease primitive that a
 * later daemon-lifetime policy can consume directly.
 *
 * ## Storage layout
 *
 * Records live under the resolved data root, NOT under the per-workspace data
 * directory:
 *
 * ```
 * <dataRoot>/agentmonitors/transports/<transport>-<key>.json
 * ```
 *
 * This is deliberate and load-bearing. Storing a channel heartbeat inside the
 * workspace directory *it resolved* would make the single most important
 * failure mode undetectable: a channel server bound to workspace X cannot be
 * seen by a `doctor` run in workspace Y, because it wrote into X's directory.
 * A flat, data-root-wide registry lets `doctor` enumerate every transport on
 * the machine and match them by host session id, so "your session's channel is
 * bound to a different workspace" is a finding rather than an absence.
 *
 * (A transport running under a genuinely different `HOME`/`XDG_DATA_HOME`
 * resolves a different data root and is invisible from here by construction.
 * That case is reported as an *absence* with wording that names the
 * possibility — see `transport-health.ts` — never as a false "healthy".)
 *
 * @see ../../../docs/specs/006-agent-integration.md §12 (transport health)
 */

/** Record schema version — bumped only on an incompatible field change. */
export const TRANSPORT_HEARTBEAT_SCHEMA_VERSION = 1;

/** The two delivery transports that report liveness (006 §3, §4). */
export type TransportName = 'hook' | 'channel';

/**
 * One transport's self-reported liveness. Every field answers a question that
 * has actually produced a silent delivery failure in the field, so none of them
 * is decorative:
 *
 * - `cliPath`/`execPath`/`version` — "which install is serving this session?"
 *   (a long-lived channel server can outlive the CLI upgrade that replaced it).
 * - `home`/`dataRoot` — "did this process resolve the same environment I did?"
 *   (the 2026-07-18 incident: a channel server pinned to a sandbox `HOME`).
 * - `workspacePath`/`socketPath` — "is it bound to the workspace whose monitors
 *   I am waiting on, and to the daemon I would reach?"
 * - `lastDeliveryAt` — liveness of *delivery*, not merely of the process.
 */
export interface TransportHeartbeat {
  schemaVersion: number;
  transport: TransportName;
  /** OS process id of the writer at the time it last heartbeat. */
  pid: number;
  /** Resolved CLI entry point (`process.argv[1]`), or `''` if unavailable. */
  cliPath: string;
  /** Node binary running the transport (`process.execPath`). */
  execPath: string;
  /** `@agentmonitors/cli` version, read from its manifest — never a literal. */
  version: string;
  /** `HOME` as the writer resolved it. */
  home: string;
  /** Data root as the writer resolved it (`XDG_DATA_HOME` aware). */
  dataRoot: string;
  /** Absolute workspace path the writer bound to. */
  workspacePath: string;
  /** Daemon socket path the writer bound to. */
  socketPath: string;
  /** Host session id, when known — both transports are session-scoped. */
  hostSessionId?: string;
  /** AgentMon session id the transport resolved, once it has one. */
  sessionId?: string;
  /** When this transport process started (ISO 8601). */
  startedAt: string;
  /** When this record was last written (ISO 8601) — the liveness signal. */
  updatedAt: string;
  /**
   * How long after `updatedAt` this record may still be trusted, in
   * milliseconds. Beyond it the record is stale (its writer is presumed gone).
   */
  ttlMs: number;
  /** When this transport last surfaced a delivery (ISO 8601), if ever. */
  lastDeliveryAt?: string;
}

/**
 * Default lease for a `channel serve` heartbeat: comfortably longer than its
 * 3s poll cadence, so an ordinarily-busy or briefly-blocked server is never
 * misreported as stale, but short enough that a killed server is recognized as
 * dead within a single agent turn rather than after minutes of silence.
 */
export const CHANNEL_HEARTBEAT_TTL_MS = 30_000;

/**
 * Default lease for a `hook deliver` heartbeat. The hook transport fires only
 * when the user submits a prompt, so its record is expected to sit untouched
 * for as long as the human is idle; a short TTL would flag a perfectly healthy
 * hook transport as stale during a coffee break. This TTL therefore answers a
 * different question than the channel's: not "is a process alive right now"
 * (there is none between prompts — that is the design) but "has this workspace
 * seen the hook transport recently enough that we can say it is wired up".
 */
export const HOOK_HEARTBEAT_TTL_MS = 24 * 60 * 60 * 1000;

/** The machine-wide transport registry directory. */
export function transportRegistryDir(): string {
  return path.join(resolveDataRoot(), 'agentmonitors', 'transports');
}

/**
 * Sanitize a heartbeat key into a single safe path segment.
 *
 * The key is derived from a host session id, which is host-supplied input we do
 * not control: a value containing `/` or `..` would otherwise let a heartbeat
 * escape the registry directory and overwrite an unrelated file. Everything
 * outside a conservative allowlist collapses to `_`, and the cleaned prefix is
 * length bounded so a pathological id cannot blow past `NAME_MAX`.
 *
 * A collapsed/truncated key alone is not injective: `run:1` and `run_1`
 * collapse to the same cleaned prefix, and two ids differing only past
 * position 96 truncate identically — either case would let one session's
 * heartbeat silently clobber another's, and a reader would then judge the
 * WRONG session's binding. Appending a short hash of the RAW (untruncated,
 * unsanitized) key makes every distinct input map to a distinct filename
 * regardless of what the cleaned prefix collapses to.
 */
function sanitizeKey(key: string): string {
  const cleaned = key.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  const base = cleaned.length > 0 ? cleaned : 'unknown';
  const suffix = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${base}-${suffix}`;
}

function heartbeatPath(transport: TransportName, key: string): string {
  return path.join(
    transportRegistryDir(),
    `${transport}-${sanitizeKey(key)}.json`,
  );
}

/**
 * The registry key for a transport's record.
 *
 * Both transports are keyed by host session id when one is known: `channel
 * serve` is one long-lived process per host session, and `hook deliver` — a
 * fresh short-lived process per prompt — is keyed per SESSION rather than
 * per process, so a session's own record survives across prompts and is
 * overwritten in place by that session's next invocation, not by another
 * session's. Per-session keying is exactly what lets `doctor` ask "is *my*
 * session's transport bound to *my* workspace?" and "has *every* active lead
 * left its own evidence?" — see {@link heartbeatKey}'s body for why hook was
 * changed from per-workspace to per-session keying.
 */
export function heartbeatKey(
  transport: TransportName,
  input: { workspacePath: string; hostSessionId?: string },
): string {
  // BOTH transports key per host session when one is known (issue #425 review,
  // round 6 follow-up). Keying `hook` per WORKSPACE meant each prompt
  // overwrote the last, so only ONE active lead could ever have a record —
  // which made the workspace-wide coverage check unable to tell a genuine gap
  // apart from a perfectly healthy workspace. Reproduced on the previous head:
  // two active leads that had BOTH just run `hook deliver` successfully still
  // reported `[hook-lead-uncovered]` against whichever prompted first, a
  // verdict of "via none: no delivery transport is listening", and exit 1 — a
  // false RED on a fully working setup, and permanent, since the single record
  // can only ever name one of them.
  //
  // Per-session keying makes the evidence real: each lead's own invocation
  // leaves its own record, so "no record for this lead" genuinely means no hook
  // invocation. Records stay bounded by SESSIONS, not prompts (a session
  // overwrites its own record in place), and expired ones are reaped on the
  // next write.
  if (input.hostSessionId) return input.hostSessionId;
  // No host session id: a manual/non-hook invocation. Fall back so the record
  // still has a stable home. Hash rather than embed the workspace path: paths
  // contain separators and can exceed a filename's length budget.
  // `workspaceHash` is the same canonical derivation `workspacePaths()` uses
  // (workspace-paths.ts) — imported rather than re-derived so the two can never
  // silently diverge.
  return transport === 'channel'
    ? `pid-${String(process.pid)}`
    : workspaceHash(input.workspacePath);
}

/** The fields a caller supplies; the rest are captured from the environment. */
export interface WriteHeartbeatInput {
  transport: TransportName;
  workspacePath: string;
  socketPath: string;
  hostSessionId?: string;
  sessionId?: string;
  startedAt?: Date;
  ttlMs?: number;
  lastDeliveryAt?: Date;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

/**
 * Read the `lastDeliveryAt` an existing record at `target` already carries,
 * or `undefined` if there is none / it cannot be read. Best-effort: any
 * failure (missing file, corrupt JSON, invalid schema) is treated the same as
 * "nothing to carry forward" — this is a read on the hot write path, and a
 * transient read failure must degrade to "reset the field", never to a
 * thrown error.
 */
function readExistingLastDeliveryAt(target: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf-8'));
    return isTransportHeartbeat(parsed) ? parsed.lastDeliveryAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write (or refresh) a transport heartbeat.
 *
 * **Never throws.** Both writers are on delivery-critical paths — `hook
 * deliver` runs inside a host hook whose failure degrades the user's session,
 * and `channel serve` is mid-poll — so a health-observability record must not
 * be able to break the thing it observes. A failed write degrades to "no
 * heartbeat", which the health surface already reports honestly as an absence.
 *
 * The write is atomic (temp file + `rename`) so a concurrent reader can never
 * observe a half-written record and misreport a healthy transport as corrupt.
 *
 * **Read-modify-write on `lastDeliveryAt`.** Every write is otherwise a whole
 * new record — `pid`/`version`/`home`/etc. always reflect the CURRENT writer,
 * never a stale prior value. `lastDeliveryAt` is the one field that must
 * survive a refresh that has nothing new to report: `hook deliver` spawns a
 * fresh process per prompt, so a caller that omits `lastDeliveryAt` (the
 * ordinary "nothing to surface this prompt" case) is not asserting "there was
 * never a delivery" — it has simply not observed one on THIS invocation. Without
 * carrying the prior value forward, every empty-prompt heartbeat silently reset
 * `last-delivery` to `never`, inverting the field's entire diagnostic purpose
 * (issue #425 review). An explicit `input.lastDeliveryAt` always wins over
 * whatever was on disk.
 */
export function writeTransportHeartbeat(
  input: WriteHeartbeatInput,
): TransportHeartbeat | undefined {
  const now = input.now ?? new Date();
  const workspacePath = path.resolve(input.workspacePath);
  const target = heartbeatPath(
    input.transport,
    heartbeatKey(input.transport, {
      workspacePath,
      ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}),
    }),
  );
  const lastDeliveryAt =
    input.lastDeliveryAt?.toISOString() ?? readExistingLastDeliveryAt(target);

  const record: TransportHeartbeat = {
    schemaVersion: TRANSPORT_HEARTBEAT_SCHEMA_VERSION,
    transport: input.transport,
    pid: process.pid,
    cliPath: process.argv[1] ?? '',
    execPath: process.execPath,
    version: getCliVersion(),
    home: os.homedir(),
    dataRoot: resolveDataRoot(),
    workspacePath,
    socketPath: input.socketPath,
    ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    startedAt: (input.startedAt ?? now).toISOString(),
    updatedAt: now.toISOString(),
    ttlMs:
      input.ttlMs ??
      (input.transport === 'channel'
        ? CHANNEL_HEARTBEAT_TTL_MS
        : HOOK_HEARTBEAT_TTL_MS),
    ...(lastDeliveryAt ? { lastDeliveryAt } : {}),
  };

  try {
    // Owner-only (0700), not the raw `mkdirSync` default: the registry dir
    // otherwise inherits the process umask, so a permissive umask (e.g. 000)
    // leaves every transport heartbeat — which carries a workspace path, a
    // socket path, and a host session id — world-readable (issue #425 review,
    // round 3). `ensurePrivateDir` is the established owner-only-directory
    // helper (also used by the daemon socket dir and per-workspace data
    // dirs), so this both creates missing ancestors at 0700 and tightens an
    // already-existing, more-permissive directory left by an older build.
    ensurePrivateDir(path.dirname(target));
    // `${target}.<pid>.tmp`, not a fixed `.tmp`: two transports refreshing the
    // same record concurrently would otherwise write the same temp file and
    // could rename each other's partial content into place.
    const tmp = `${target}.${String(process.pid)}.tmp`;
    // The temp path is still deterministic (this pid's own prior crash could
    // have left a stale file, or the registry directory predates the 0700
    // migration and something planted a symlink there), so treat whatever
    // sits there as hostile — mirroring `writePrivateFileAtomic`
    // (local-permissions.ts): remove it (`rm` does not follow symlinks) and
    // recreate with `O_EXCL`, which refuses to follow a symlink planted
    // between the two calls. A plain `writeFileSync(tmp, ...)` would instead
    // follow a pre-planted symlink and overwrite whatever it points at.
    rmSync(tmp, { force: true });
    const fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      PRIVATE_FILE_MODE,
    );
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf-8',
      });
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch {
    return undefined;
  }
  // Opportunistic GC lives SOLELY on the write path (issue #425 review,
  // round 6) — `readTransportHeartbeats` never mutates. A read-side reap
  // meant `doctor` itself deleted the only evidence of the failure it had
  // just reported: `[heartbeat-stale]` on run 1, then a clean "not
  // configured" idle verdict on run 2, purely because the diagnostic had
  // been invoked once already (005 §15's "diagnoses only, never mutates"
  // contract). A live process WRITING again is the genuine reconciliation
  // event a lapsed record should wait for; a bystander's read is not. A busy
  // channel poll writes its own record every ~3s regardless of whether
  // anything ever reads the registry, so this is still enough to reap OTHER
  // transports' expired records promptly rather than leaving them until
  // something else happens to write. Best-effort: a failed scan here must
  // not turn "write my own heartbeat" into a thrown error.
  try {
    reapExpiredHeartbeats(now);
  } catch {
    // Never throws (see the function doc above).
  }
  return record;
}

/** Remove a transport's heartbeat (clean shutdown). Never throws. */
export function removeTransportHeartbeat(
  transport: TransportName,
  input: { workspacePath: string; hostSessionId?: string },
): void {
  try {
    rmSync(heartbeatPath(transport, heartbeatKey(transport, input)), {
      force: true,
    });
  } catch {
    // Best-effort: a leftover record expires via its TTL anyway.
  }
}

/**
 * Type guard for a persisted record.
 *
 * Accepts `unknown` and validates every field it narrows: these files are on
 * disk, so they can be truncated, hand-edited, or written by a future version.
 * A partially-valid record is rejected outright rather than surfaced with
 * missing fields, because the health surface's whole job is comparing these
 * values — a silently-absent `workspacePath` would read as "no mismatch".
 */
export function isTransportHeartbeat(
  value: unknown,
): value is TransportHeartbeat {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const strings = [
    'cliPath',
    'execPath',
    'version',
    'home',
    'dataRoot',
    'workspacePath',
    'socketPath',
    'startedAt',
    'updatedAt',
  ];
  if (!strings.every((key) => typeof record[key] === 'string')) return false;

  // Numeric fields must be SEMANTICALLY valid, not merely `typeof === 'number'`
  // (issue #425 review). JSON has no `Infinity` literal, but `1e309` overflows
  // and `JSON.parse` hands back `Infinity` — which a bare typeof check accepts.
  // An infinite `ttlMs` then makes `isHeartbeatStale`'s `age > ttlMs` false
  // forever: the record is immortal, never reported stale, and never reaped, so
  // a dead transport reads as `running` permanently. That is precisely the
  // never-expires failure this module hardens against elsewhere (the
  // future-`updatedAt` clamp), reached through a different field. `NaN` is
  // equally poisonous — every comparison against it is `false`.
  //
  // `ttlMs` must additionally be POSITIVE: a zero or negative lease is not a
  // lease, and a negative one would report a record stale the instant it was
  // written.
  const ttlMs = record['ttlMs'];
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return false;
  }
  const pid = record['pid'];
  if (!Number.isInteger(pid)) return false;
  const schemaVersion = record['schemaVersion'];
  if (!Number.isInteger(schemaVersion)) return false;
  if (record['transport'] !== 'hook' && record['transport'] !== 'channel') {
    return false;
  }
  const optionalStrings = [
    'hostSessionId',
    'sessionId',
    'lastDeliveryAt',
  ] as const;
  return optionalStrings.every(
    (key) => record[key] === undefined || typeof record[key] === 'string',
  );
}

/**
 * Read every heartbeat in the machine-wide registry.
 *
 * Unreadable, malformed, or future-schema files are skipped rather than
 * throwing: one corrupt record must not blind `doctor` to every other
 * transport on the machine. A missing registry directory is simply an empty
 * list — the ordinary state before any transport has ever run.
 *
 * **Pure — never mutates, never reaps** (issue #425 review, round 6). This
 * function takes no `now` and has no GC side effect; a stale-past-TTL record
 * is returned exactly as read, every time, until something else reconciles
 * it. That is deliberate: `doctor` is 005 §15's "diagnoses only" surface, and
 * reaping on THIS read path previously let one `doctor` invocation destroy
 * the only evidence of the failure it had just reported — the record proving
 * `[heartbeat-stale]` on run 1 was gone by run 2, which then saw no
 * configured transports and reported a clean idle/exit-0 verdict for a
 * transport that was, in fact, still dead. Expiry reconciliation belongs
 * solely to {@link writeTransportHeartbeat}'s call to
 * {@link reapExpiredHeartbeats}: a live process WRITING again is the genuine
 * "this transport is back" event, whereas a bystander merely reading the
 * registry is not, and must not be able to erase what it observes.
 */
export function readTransportHeartbeats(): TransportHeartbeat[] {
  let names: string[];
  try {
    names = readdirSync(transportRegistryDir());
  } catch {
    return [];
  }
  const records: TransportHeartbeat[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(transportRegistryDir(), name), 'utf-8'),
      );
      if (
        isTransportHeartbeat(parsed) &&
        parsed.schemaVersion === TRANSPORT_HEARTBEAT_SCHEMA_VERSION
      ) {
        records.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * Reap records whose lease expired as of `now`. **Write path only.**
 *
 * Deliberately NOT folded into {@link readTransportHeartbeats} (issue #425
 * review). Reaping during a read made the diagnostic destroy its own evidence:
 * the first `agentmonitors doctor` reported `[heartbeat-stale]` and exited 1,
 * and the second — with the lead session and daemon completely unchanged, and
 * nothing recovered — found no record at all, took the "no transport has ever
 * reported in" branch, and exited 0. A dead channel server looked fixed purely
 * because someone had looked at it. It also made `doctor` mutate state, which
 * 005 §15 explicitly says it never does.
 *
 * A stale record is therefore durable: it keeps reporting the failure on every
 * health check until a transport actually WRITES again, which is the real
 * reconciliation event — a live process re-registering — rather than a
 * bystander's read.
 *
 * Never throws: reaping is best-effort housekeeping and must not turn "write my
 * own heartbeat" into a failure.
 */
export function reapExpiredHeartbeats(now: Date): void {
  let names: string[];
  try {
    names = readdirSync(transportRegistryDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(transportRegistryDir(), name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (
        isTransportHeartbeat(parsed) &&
        parsed.schemaVersion === TRANSPORT_HEARTBEAT_SCHEMA_VERSION &&
        isHeartbeatStale(parsed, now)
      ) {
        rmSync(filePath, { force: true });
      }
    } catch {
      continue;
    }
  }
}

/**
 * Tolerance for ordinary clock skew between a heartbeat's writer and whatever
 * process later reads it back (`doctor`, GC on the next write). A few seconds
 * of drift between two processes' clocks is normal; anything beyond it is not
 * skew, it is a corrupt or forged record.
 */
export const HEARTBEAT_FUTURE_TOLERANCE_MS = 5_000;

/** Whether a record's lease has expired as of `now`. */
export function isHeartbeatStale(
  heartbeat: TransportHeartbeat,
  now: Date,
): boolean {
  const updatedAt = Date.parse(heartbeat.updatedAt);
  // An unparseable timestamp cannot be shown to be fresh, so treat it as stale
  // — the conservative direction: we would rather flag a live transport for
  // inspection than report a dead one as healthy.
  if (Number.isNaN(updatedAt)) return true;
  const age = now.getTime() - updatedAt;
  // A negative `age` means `updatedAt` is in the future relative to `now`. Past
  // the small clock-skew tolerance above, that can only be a corrupt record or
  // a writer with a badly wrong clock — and treating a future timestamp as
  // "infinitely fresh" is the wrong failure mode: it would never age past its
  // TTL, so `reapExpiredHeartbeats`' write-path GC (round 7 — reads are
  // deliberately pure, see `readTransportHeartbeats` above) would never reap
  // it, and `doctor` would keep reporting a possibly-dead transport as
  // `running` forever (issue #425 review, round 4). Report it as stale
  // instead — the same conservative direction as the unparseable-timestamp
  // case above.
  if (age < -HEARTBEAT_FUTURE_TOLERANCE_MS) return true;
  return age > heartbeat.ttlMs;
}

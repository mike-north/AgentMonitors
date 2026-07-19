import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRIVATE_FILE_MODE } from '@agentmonitors/core';
import { getCliVersion } from './cli-version.js';

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
  /** Host session id, when the transport is session-scoped (channel). */
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

/** Resolve the data root the same way `workspacePaths`/`resolveSocketPath` do. */
export function resolveDataRoot(): string {
  return (
    process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share')
  );
}

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
 * outside a conservative allowlist collapses to `_`, and the result is length
 * bounded so a pathological id cannot blow past `NAME_MAX`.
 */
function sanitizeKey(key: string): string {
  const cleaned = key.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'unknown';
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
 * `channel serve` is one long-lived process per host session, so its record is
 * keyed by host session id — that is exactly what lets `doctor` ask "is *my*
 * session's channel bound to *my* workspace?" and detect a cross-workspace
 * binding. `hook deliver`, by contrast, is a fresh short-lived process per
 * prompt with no stable identity of its own; keying it per-process would
 * accumulate garbage, so its record is per-workspace and each invocation
 * overwrites the last (the newest activity is the only interesting one).
 */
export function heartbeatKey(
  transport: TransportName,
  input: { workspacePath: string; hostSessionId?: string },
): string {
  if (transport === 'channel') {
    return input.hostSessionId ?? `pid-${String(process.pid)}`;
  }
  // Hash rather than embed the workspace path: paths contain separators and can
  // exceed a filename's length budget.
  return workspaceKey(input.workspacePath);
}

/** Stable short key for a workspace path (mirrors `workspacePaths`' hashing). */
export function workspaceKey(workspacePath: string): string {
  return createHash('sha256')
    .update(path.resolve(workspacePath))
    .digest('hex')
    .slice(0, 16);
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
 */
export function writeTransportHeartbeat(
  input: WriteHeartbeatInput,
): TransportHeartbeat | undefined {
  const now = input.now ?? new Date();
  const record: TransportHeartbeat = {
    schemaVersion: TRANSPORT_HEARTBEAT_SCHEMA_VERSION,
    transport: input.transport,
    pid: process.pid,
    cliPath: process.argv[1] ?? '',
    execPath: process.execPath,
    version: getCliVersion(),
    home: os.homedir(),
    dataRoot: resolveDataRoot(),
    workspacePath: path.resolve(input.workspacePath),
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
    ...(input.lastDeliveryAt
      ? { lastDeliveryAt: input.lastDeliveryAt.toISOString() }
      : {}),
  };

  const target = heartbeatPath(
    input.transport,
    heartbeatKey(input.transport, {
      workspacePath: record.workspacePath,
      ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}),
    }),
  );
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    // `${target}.<pid>.tmp`, not a fixed `.tmp`: two transports refreshing the
    // same record concurrently would otherwise write the same temp file and
    // could rename each other's partial content into place.
    const tmp = `${target}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: PRIVATE_FILE_MODE,
    });
    renameSync(tmp, target);
    return record;
  } catch {
    return undefined;
  }
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
  if (typeof record['pid'] !== 'number') return false;
  if (typeof record['ttlMs'] !== 'number') return false;
  if (typeof record['schemaVersion'] !== 'number') return false;
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
  return now.getTime() - updatedAt > heartbeat.ttlMs;
}

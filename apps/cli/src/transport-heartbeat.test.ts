import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_HEARTBEAT_TTL_MS,
  HOOK_HEARTBEAT_TTL_MS,
  TRANSPORT_HEARTBEAT_SCHEMA_VERSION,
  isHeartbeatStale,
  isTransportHeartbeat,
  readTransportHeartbeats,
  reapExpiredHeartbeats,
  removeTransportHeartbeat,
  transportRegistryDir,
  writeTransportHeartbeat,
} from './transport-heartbeat.js';

/**
 * Transport heartbeat persistence (issue #425).
 *
 * These run against a REAL filesystem under an isolated `XDG_DATA_HOME` rather
 * than a mocked `fs`: the whole point of the record is that a separate process
 * (`doctor`) can read what another process (`channel serve` / `hook deliver`)
 * wrote, so a mock that never exercises the shared path, the atomic rename, or
 * the JSON round-trip would prove nothing about the property under test.
 */

let dataHome: string;
let previousDataHome: string | undefined;

beforeEach(() => {
  previousDataHome = process.env['XDG_DATA_HOME'];
  dataHome = mkdtempSync(path.join(os.tmpdir(), 'am-transport-hb-'));
  process.env['XDG_DATA_HOME'] = dataHome;
});

afterEach(() => {
  if (previousDataHome === undefined) {
    delete process.env['XDG_DATA_HOME'];
  } else {
    process.env['XDG_DATA_HOME'] = previousDataHome;
  }
  rmSync(dataHome, { recursive: true, force: true });
});

const WORKSPACE = '/repos/agentmonitors';
const SOCKET = '/tmp/agentmonitors-test.sock';

describe('writeTransportHeartbeat', () => {
  it('records every field the health surface compares against', () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    const written = writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'host-1',
      sessionId: 'session-1',
      now,
    });

    expect(written).toBeDefined();
    const [record] = readTransportHeartbeats();
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      schemaVersion: TRANSPORT_HEARTBEAT_SCHEMA_VERSION,
      transport: 'channel',
      pid: process.pid,
      execPath: process.execPath,
      home: os.homedir(),
      dataRoot: dataHome,
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'host-1',
      sessionId: 'session-1',
      updatedAt: '2026-07-19T12:00:00.000Z',
      ttlMs: CHANNEL_HEARTBEAT_TTL_MS,
    });
  });

  it('reports the real CLI version, never a hardcoded literal', () => {
    // A frozen version string makes every release indistinguishable, which
    // defeats the "which build is serving this session?" question the record
    // exists to answer.
    const manifest = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, '..', 'package.json'),
        'utf-8',
      ),
    ) as { version: string };

    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
    });

    expect(readTransportHeartbeats()[0]?.version).toBe(manifest.version);
  });

  it('gives the hook transport a lease long enough to survive an idle human', () => {
    // There is no hook process between prompts by design; a channel-length TTL
    // would report a healthy hook setup as dead during any pause.
    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
    });
    expect(readTransportHeartbeats()[0]?.ttlMs).toBe(HOOK_HEARTBEAT_TTL_MS);
    expect(HOOK_HEARTBEAT_TTL_MS).toBeGreaterThan(CHANNEL_HEARTBEAT_TTL_MS);
  });

  it('keys channel records per host session so two sessions both stay visible', () => {
    // Detecting "MY session's channel is bound elsewhere" requires per-session
    // records; a shared key would let one session's server overwrite another's.
    for (const hostSessionId of ['host-a', 'host-b']) {
      writeTransportHeartbeat({
        transport: 'channel',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        hostSessionId,
      });
    }

    const ids = readTransportHeartbeats().map((record) => record.hostSessionId);
    expect(ids.sort()).toEqual(['host-a', 'host-b']);
  });

  it('keys hook records per host session, so each active lead has its own evidence', () => {
    // Workspace keying capped this at ONE record, so only the most recent
    // prompter could ever be "covered" — which made a healthy multi-session
    // workspace indistinguishable from a genuine gap and produced a false RED
    // (issue #425 review, round 6 follow-up).
    for (const hostSessionId of ['lead-a', 'lead-b']) {
      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        hostSessionId,
      });
    }

    const ids = readTransportHeartbeats()
      .map((record) => record.hostSessionId)
      .sort();
    expect(ids).toEqual(['lead-a', 'lead-b']);
  });

  it("overwrites one session's hook record in place, so prompts do not accumulate files", () => {
    // Bounded by SESSIONS, not prompts: `hook deliver` is a fresh process every
    // prompt, and the same session must reuse its own record rather than
    // leaving one file per prompt the user ever submitted.
    for (let i = 0; i < 3; i++) {
      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        hostSessionId: 'lead-a',
      });
    }
    expect(readTransportHeartbeats()).toHaveLength(1);
  });

  it('writes records outside the per-workspace directory, so a misbound transport is findable', () => {
    // This is the load-bearing layout decision: a channel that resolved
    // workspace X must be visible to a `doctor` run in workspace Y, or the
    // single most important failure mode is undetectable by construction.
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: '/some/other/workspace',
      socketPath: SOCKET,
      hostSessionId: 'host-1',
    });

    expect(transportRegistryDir()).toBe(
      path.join(dataHome, 'agentmonitors', 'transports'),
    );
    const [record] = readTransportHeartbeats();
    expect(record?.workspacePath).toBe('/some/other/workspace');
  });

  it('confines a host session id with path separators to a single segment', () => {
    // The host session id is untrusted input; a `../` in it must not let a
    // heartbeat escape the registry and overwrite an unrelated file.
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: '../../escape',
    });

    const records = readTransportHeartbeats();
    expect(records).toHaveLength(1);
    expect(records[0]?.hostSessionId).toBe('../../escape');
  });

  it('never throws when the registry cannot be written', () => {
    // Both writers sit on delivery-critical paths; an observability record must
    // not be able to break the delivery it observes.
    //
    // The unwritable location is a path whose PARENT IS A REGULAR FILE, so
    // every `mkdir` beneath it fails `ENOTDIR` immediately. Two alternatives
    // were tried and are wrong:
    //
    // - `/proc/<missing>/…` (what this test used originally) HANGS FOREVER on
    //   Linux: `mkdirSync(path, { recursive: true })` under procfs never
    //   returns, while a plain non-recursive `mkdirSync` on the same path
    //   throws `ENOENT` in under a millisecond. Because that call is
    //   SYNCHRONOUS, vitest cannot interrupt it — its test timeout never
    //   fires, the worker spins, and the whole run hangs with no output.
    //   That is exactly how this suite burned CI's entire 30-minute budget
    //   four times with a completely silent log. It passed locally only
    //   because macOS has no `/proc`, so the same call failed instantly.
    // - A `chmod 0500` directory does not work either: CI containers run as
    //   root, and root ignores permission bits, so the write would SUCCEED and
    //   the test would silently stop testing anything.
    const blocker = path.join(dataHome, 'not-a-directory');
    writeFileSync(blocker, 'regular file, not a directory');
    process.env['XDG_DATA_HOME'] = path.join(blocker, 'nested');

    const startedAt = Date.now();
    expect(() =>
      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
      }),
    ).not.toThrow();
    // Guards the regression above: the failure path must fail FAST. A blocking
    // filesystem call here cannot be caught by a test timeout (it is
    // synchronous), so the only way to catch it is to assert afterwards that
    // we got here at all and promptly. The bound is deliberately loose — this
    // work is sub-millisecond in practice — so it flags a hang, never slowness.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('removeTransportHeartbeat', () => {
  it('removes the record so a clean shutdown reads as absent, not stale', () => {
    // "No channel" and "stale channel" point at different fixes.
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'host-1',
    });
    expect(readTransportHeartbeats()).toHaveLength(1);

    removeTransportHeartbeat('channel', {
      workspacePath: WORKSPACE,
      hostSessionId: 'host-1',
    });
    expect(readTransportHeartbeats()).toHaveLength(0);
  });

  it('never throws when the record is already gone', () => {
    expect(() =>
      removeTransportHeartbeat('channel', {
        workspacePath: WORKSPACE,
        hostSessionId: 'never-written',
      }),
    ).not.toThrow();
  });
});

describe('readTransportHeartbeats', () => {
  it('returns an empty list before any transport has run', () => {
    expect(readTransportHeartbeats()).toEqual([]);
  });

  it('skips a corrupt record instead of blinding the surface to the rest', () => {
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'host-good',
    });
    writeFileSync(
      path.join(transportRegistryDir(), 'channel-corrupt.json'),
      '{ this is not json',
    );

    const records = readTransportHeartbeats();
    expect(records).toHaveLength(1);
    expect(records[0]?.hostSessionId).toBe('host-good');
  });

  it('skips a record written by an incompatible future schema', () => {
    mkdirSync(transportRegistryDir(), { recursive: true });
    writeFileSync(
      path.join(transportRegistryDir(), 'channel-future.json'),
      JSON.stringify({
        schemaVersion: TRANSPORT_HEARTBEAT_SCHEMA_VERSION + 1,
        transport: 'channel',
        pid: 1,
        cliPath: '',
        execPath: '',
        version: '9.9.9',
        home: '/h',
        dataRoot: '/d',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        startedAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
        ttlMs: 1,
      }),
    );
    expect(readTransportHeartbeats()).toEqual([]);
  });
});

describe('isTransportHeartbeat', () => {
  const valid = {
    schemaVersion: 1,
    transport: 'hook',
    pid: 1,
    cliPath: '/bin/agentmonitors',
    execPath: '/bin/node',
    version: '1.0.0',
    home: '/home/me',
    dataRoot: '/home/me/.local/share',
    workspacePath: WORKSPACE,
    socketPath: SOCKET,
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ttlMs: 1000,
  };

  it('accepts a well-formed record', () => {
    expect(isTransportHeartbeat(valid)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [valid]],
    ['a string', 'heartbeat'],
    ['a number', 42],
  ])('rejects %s', (_label, value) => {
    expect(isTransportHeartbeat(value)).toBe(false);
  });

  it('rejects a record missing a field the health surface compares', () => {
    // A silently-absent `workspacePath` would read as "no mismatch" — a false
    // clean bill of health, the exact failure this surface exists to prevent.
    const { workspacePath: _omitted, ...withoutWorkspace } = valid;
    expect(isTransportHeartbeat(withoutWorkspace)).toBe(false);
  });

  it('rejects an unknown transport name', () => {
    expect(
      isTransportHeartbeat({ ...valid, transport: 'carrier-pigeon' }),
    ).toBe(false);
  });

  it.each([
    ['an infinite ttl (JSON 1e309 overflows to Infinity)', Infinity],
    ['a negative-infinite ttl', -Infinity],
    ['a NaN ttl', NaN],
    ['a zero ttl (not a lease)', 0],
    ['a negative ttl (stale the instant it is written)', -1000],
  ])('rejects %s', (_label, ttlMs) => {
    // An infinite lease makes `isHeartbeatStale`'s `age > ttlMs` false forever:
    // the record is immortal, never reported stale, and never reaped, so a dead
    // transport reads as `running` permanently (issue #425 review).
    expect(isTransportHeartbeat({ ...valid, ttlMs })).toBe(false);
  });

  it.each([
    ['a non-integer pid', 1.5],
    ['an infinite pid', Infinity],
    ['a NaN schemaVersion', NaN],
  ])('rejects %s', (_label, _value) => {
    const key = _label.includes('schemaVersion') ? 'schemaVersion' : 'pid';
    expect(isTransportHeartbeat({ ...valid, [key]: _value })).toBe(false);
  });

  it('survives a PERSISTED non-finite lease without treating it as live', () => {
    // End to end through the real registry: `1e309` is valid JSON that parses
    // to `Infinity`, so this is reachable from a hand-edited or
    // future-version record, not just a synthetic object.
    mkdirSync(transportRegistryDir(), { recursive: true });
    // Built as TEXT, not via `JSON.stringify`: stringify turns `Infinity` into
    // `null`, which the guard would reject for the wrong reason and let this
    // test pass vacuously. `1e309` is legal JSON that parses to `Infinity`.
    const raw = `{"schemaVersion":1,"transport":"channel","pid":1,"cliPath":"/bin/agentmonitors","execPath":"/bin/node","version":"1.0.0","home":"/home/me","dataRoot":"/home/me/.local/share","workspacePath":"${WORKSPACE}","socketPath":"${SOCKET}","startedAt":"2026-07-19T00:00:00.000Z","updatedAt":"2026-07-19T00:00:00.000Z","ttlMs":1e309}`;
    // Guard the guard: prove the fixture really does parse to a non-finite
    // lease, so a failure here means the validation regressed, not the fixture.
    expect((JSON.parse(raw) as { ttlMs: number }).ttlMs).toBe(Infinity);

    writeFileSync(
      path.join(transportRegistryDir(), 'channel-immortal.json'),
      raw,
    );
    // Rejected at the guard, so it never reaches the health surface at all.
    expect(readTransportHeartbeats()).toEqual([]);
  });

  it('rejects a non-numeric ttl', () => {
    expect(isTransportHeartbeat({ ...valid, ttlMs: '30s' })).toBe(false);
  });

  it('rejects a non-string optional field rather than ignoring it', () => {
    expect(isTransportHeartbeat({ ...valid, hostSessionId: 7 })).toBe(false);
  });
});

describe('writeTransportHeartbeat lastDeliveryAt merge (issue #425 review)', () => {
  it('preserves a prior lastDeliveryAt across a refresh that omits it', () => {
    // Simulates the hook transport: a fresh process per prompt writes a
    // record BEFORE it knows whether anything will be delivered, then
    // (maybe) a second write records the delivery. Before this fix, the
    // first write's whole-record overwrite erased the second write's
    // `lastDeliveryAt` on the very next prompt.
    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      lastDeliveryAt: new Date('2026-07-19T10:00:00.000Z'),
    });
    expect(readTransportHeartbeats()[0]?.lastDeliveryAt).toBe(
      '2026-07-19T10:00:00.000Z',
    );

    // A later refresh with nothing new to report (an empty prompt) omits
    // `lastDeliveryAt` entirely.
    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
    });

    expect(readTransportHeartbeats()[0]?.lastDeliveryAt).toBe(
      '2026-07-19T10:00:00.000Z',
    );
  });

  it('lets an explicit lastDeliveryAt override whatever was on disk', () => {
    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      lastDeliveryAt: new Date('2026-07-19T10:00:00.000Z'),
    });

    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      lastDeliveryAt: new Date('2026-07-19T11:00:00.000Z'),
    });

    expect(readTransportHeartbeats()[0]?.lastDeliveryAt).toBe(
      '2026-07-19T11:00:00.000Z',
    );
  });

  it('has no lastDeliveryAt to preserve on the very first write', () => {
    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
    });
    expect(readTransportHeartbeats()[0]?.lastDeliveryAt).toBeUndefined();
  });
});

describe('heartbeat key collisions (issue #425 review)', () => {
  it('never collides two host session ids whose sanitized forms would match', () => {
    // `run:1` and `run_1` both collapse to the cleaned prefix `run_1` under
    // the sanitizer's allowlist — without a hash suffix, the second write
    // would silently clobber the first's file, and a reader would then judge
    // the WRONG session's binding.
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'run:1',
    });
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'run_1',
    });

    const ids = readTransportHeartbeats()
      .map((record) => record.hostSessionId)
      .sort();
    expect(ids).toEqual(['run:1', 'run_1']);
  });

  it('never collides two ids differing only past the 96-char truncation point', () => {
    const prefix = 'a'.repeat(100);
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: `${prefix}-first`,
    });
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: `${prefix}-second`,
    });

    const ids = readTransportHeartbeats()
      .map((record) => record.hostSessionId)
      .sort();
    expect(ids).toEqual([`${prefix}-first`, `${prefix}-second`]);
  });
});

describe('opportunistic registry GC (issue #425 review)', () => {
  it('reaps an expired-past-TTL record from disk while still reporting it for THIS read', () => {
    const writtenAt = new Date('2026-07-19T11:00:00.000Z');
    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'host-1',
      ttlMs: 30_000,
      now: writtenAt,
    });

    // Well past the 30s lease — simulates an uncleanly-killed process (SIGKILL,
    // host crash) that never called `removeTransportHeartbeat`.
    const readAt = new Date('2026-07-19T12:00:00.000Z');

    // A READ NEVER REAPS (issue #425 review). Repeated reads keep returning
    // the dead record, so a lapsed transport keeps reporting the failure on
    // every health check instead of the diagnostic erasing its own evidence.
    for (const pass of [1, 2, 3]) {
      const records = readTransportHeartbeats();
      expect(records, `read #${String(pass)}`).toHaveLength(1);
      expect(records[0]?.hostSessionId).toBe('host-1');
    }

    // Only the WRITE path reaps — a live process re-registering is the real
    // reconciliation event, not a bystander looking at the registry.
    reapExpiredHeartbeats(readAt);
    expect(readTransportHeartbeats()).toHaveLength(0);
  });

  it('does not reap a record that is still within its lease', () => {
    const writtenAt = new Date('2026-07-19T11:00:00.000Z');
    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      now: writtenAt,
    });

    const soonAfter = new Date('2026-07-19T11:00:05.000Z');
    reapExpiredHeartbeats(soonAfter);
    expect(readTransportHeartbeats()).toHaveLength(1);
    reapExpiredHeartbeats(soonAfter);
    expect(readTransportHeartbeats()).toHaveLength(1);
  });

  it('also reaps opportunistically on a write, not only a read', () => {
    // A channel poll writes its OWN heartbeat every ~3s regardless of whether
    // anything ever calls `readTransportHeartbeats` — relying solely on reads
    // to reap OTHER transports' expired records would leave them sitting
    // until the next `doctor` run.
    writeTransportHeartbeat({
      transport: 'hook',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      ttlMs: 1_000,
      now: new Date('2026-07-19T11:00:00.000Z'),
    });

    writeTransportHeartbeat({
      transport: 'channel',
      workspacePath: WORKSPACE,
      socketPath: SOCKET,
      hostSessionId: 'host-2',
      now: new Date('2026-07-19T11:05:00.000Z'),
    });

    const records = readTransportHeartbeats();
    expect(records.map((record) => record.transport).sort()).toEqual([
      'channel',
    ]);
  });
});

describe('isHeartbeatStale', () => {
  const base = {
    schemaVersion: 1 as const,
    transport: 'channel' as const,
    pid: 1,
    cliPath: '',
    execPath: '',
    version: '1.0.0',
    home: '/h',
    dataRoot: '/d',
    workspacePath: WORKSPACE,
    socketPath: SOCKET,
    startedAt: '2026-07-19T11:00:00.000Z',
    ttlMs: 30_000,
  };

  it('is fresh within the lease', () => {
    expect(
      isHeartbeatStale(
        { ...base, updatedAt: '2026-07-19T12:00:00.000Z' },
        new Date('2026-07-19T12:00:20.000Z'),
      ),
    ).toBe(false);
  });

  it('is stale past the lease', () => {
    expect(
      isHeartbeatStale(
        { ...base, updatedAt: '2026-07-19T12:00:00.000Z' },
        new Date('2026-07-19T12:00:31.000Z'),
      ),
    ).toBe(true);
  });

  it('honors the record’s own ttl rather than a reader-side constant', () => {
    // A future writer heartbeating on a different cadence must stay correct
    // without every reader being updated in lockstep.
    expect(
      isHeartbeatStale(
        {
          ...base,
          ttlMs: 3_600_000,
          updatedAt: '2026-07-19T12:00:00.000Z',
        },
        new Date('2026-07-19T12:30:00.000Z'),
      ),
    ).toBe(false);
  });

  it('treats an unparseable timestamp as stale', () => {
    expect(
      isHeartbeatStale({ ...base, updatedAt: 'whenever' }, new Date()),
    ).toBe(true);
  });

  // Regression: a FUTURE `updatedAt` (clock skew or a corrupt/forged record)
  // used to be treated as fresh forever — `now - updatedAt` is negative, so it
  // is never `> ttlMs` no matter how far in the future the record claims to be.
  // That blocked opportunistic GC (`readTransportHeartbeats` never reaped it)
  // and let `doctor` report a dead transport as `running` indefinitely (issue
  // #425 review, round 4).
  it('treats a far-future updatedAt as stale, not fresh forever', () => {
    expect(
      isHeartbeatStale(
        { ...base, updatedAt: '2026-07-20T12:00:00.000Z' },
        new Date('2026-07-19T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('tolerates a few seconds of future clock skew as fresh', () => {
    expect(
      isHeartbeatStale(
        { ...base, updatedAt: '2026-07-19T12:00:02.000Z' },
        new Date('2026-07-19T12:00:00.000Z'),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The transport registry is owner-only, even under a permissive umask (issue
// #425 review, round 3). Every record it holds names a workspace path, a
// socket path, and — for `channel` — a host session id; a world-readable
// registry directory would leak all of that to any local user. POSIX-only
// (modes are meaningless on win32), matching the daemon-IPC-artifacts suite's
// convention (`daemon-ipc.test.ts`).
// ---------------------------------------------------------------------------
const mode = (p: string): number => statSync(p).mode & 0o777;

describe.skipIf(process.platform === 'win32')(
  'transport registry directory is owner-only (issue #425 review)',
  () => {
    let originalUmask: number;

    beforeEach(() => {
      originalUmask = process.umask(0o000);
    });

    afterEach(() => {
      process.umask(originalUmask);
    });

    it('creates a missing registry directory 0700 even under umask 000', () => {
      writeTransportHeartbeat({
        transport: 'channel',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        now: new Date('2026-07-19T12:00:00.000Z'),
      });

      expect(mode(transportRegistryDir())).toBe(0o700);
    });

    it('tightens a pre-existing, permissively-created registry directory', () => {
      // Simulate a registry directory left behind by an older build that used
      // a raw `mkdirSync` (no explicit mode) under a permissive umask.
      mkdirSync(transportRegistryDir(), { recursive: true });
      chmodSync(transportRegistryDir(), 0o777);
      expect(mode(transportRegistryDir())).toBe(0o777);

      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        now: new Date('2026-07-19T12:00:00.000Z'),
      });

      expect(mode(transportRegistryDir())).toBe(0o700);
    });
  },
);

// ---------------------------------------------------------------------------
// The temp-file write must not follow a pre-planted symlink at its
// deterministic path (issue #425 review, round 4). The registry directory
// predates the 0700 migration in some installs, so a symlink planted there
// while it was still permissive must not let a later refresh overwrite
// whatever that symlink points at.
// ---------------------------------------------------------------------------
describe.skipIf(process.platform === 'win32')(
  'writeTransportHeartbeat does not follow a planted symlink at the temp path (issue #425 review)',
  () => {
    it('removes a pre-planted symlink at the temp path instead of following it', () => {
      // Establish the real target file and learn its exact on-disk name.
      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        now: new Date('2026-07-19T12:00:00.000Z'),
      });
      const [recordName] = readdirSync(transportRegistryDir()).filter((name) =>
        name.startsWith('hook-'),
      );
      if (recordName === undefined) throw new Error('no hook record written');
      const target = path.join(transportRegistryDir(), recordName);
      const tmpPath = `${target}.${String(process.pid)}.tmp`;

      // Plant a symlink at the deterministic temp path, pointing at an
      // unrelated "victim" file outside the registry — exactly what an
      // attacker with write access during the pre-migration permissive window
      // could have left behind.
      const victim = path.join(dataHome, 'victim.txt');
      writeFileSync(victim, 'do-not-overwrite');
      symlinkSync(victim, tmpPath);

      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        now: new Date('2026-07-19T12:05:00.000Z'),
      });

      // The victim file must be untouched — a plain `writeFileSync(tmpPath,
      // ...)` would have followed the symlink and clobbered it.
      expect(readFileSync(victim, 'utf-8')).toBe('do-not-overwrite');
      // The real record still refreshed correctly.
      const record: unknown = JSON.parse(readFileSync(target, 'utf-8'));
      expect(isTransportHeartbeat(record)).toBe(true);
      if (!isTransportHeartbeat(record)) throw new Error('unreachable');
      expect(record.updatedAt).toBe('2026-07-19T12:05:00.000Z');
      // The symlink at the temp path was consumed (rm'd, then recreated as a
      // real file which was renamed away) rather than left dangling.
      expect(() => statSync(tmpPath)).toThrow();
    });
  },
);

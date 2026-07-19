import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

  it('keys hook records per workspace so repeated prompts do not accumulate files', () => {
    // `hook deliver` is a fresh process per prompt; keying per-process would
    // leave one stale file behind for every prompt the user ever submitted.
    for (let i = 0; i < 3; i++) {
      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
        hostSessionId: `host-${String(i)}`,
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
    process.env['XDG_DATA_HOME'] = '/proc/nonexistent-cannot-create';
    expect(() =>
      writeTransportHeartbeat({
        transport: 'hook',
        workspacePath: WORKSPACE,
        socketPath: SOCKET,
      }),
    ).not.toThrow();
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
    const firstRead = readTransportHeartbeats(readAt);
    // Still returned on the read that observed it stale: this pass's caller
    // gets an accurate "it was stale" finding, not a silent absence.
    expect(firstRead).toHaveLength(1);
    expect(firstRead[0]?.hostSessionId).toBe('host-1');

    // But the backing file is gone: the NEXT read sees a clean absence
    // instead of the same dead record forever (the bug: doctor turned
    // permanently red for one uncleanly-killed channel server).
    expect(readTransportHeartbeats(readAt)).toHaveLength(0);
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
    expect(readTransportHeartbeats(soonAfter)).toHaveLength(1);
    expect(readTransportHeartbeats(soonAfter)).toHaveLength(1);
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

    const records = readTransportHeartbeats(
      new Date('2026-07-19T11:05:00.000Z'),
    );
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
});

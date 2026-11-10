/**
 * Issue #451 — a pending event keeps the semantics it was observed under.
 *
 * Editing a monitor's `MONITOR.md` after an event has materialized (or while its
 * observation is held in a debounce batch) must not change that event's
 * urgency, title or body, nor the decision whether it interrupts a turn. These
 * suites drive the real runtime, real SQLite, real `MONITOR.md` parsing and the
 * real delivery claim; only the observation source is scripted.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/451
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.3
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const MONITOR_ID = 'edit-monitor';
const SOURCE_NAME = 'scripted-451';
const START = new Date('2026-02-01T10:00:00.000Z');
/** Longer than the debounce settle window and the high-urgency claim settle. */
const PAST_SETTLE_MS = 60_000;

/** Longer than the default poll interval, so every tick observes. */
const POLL_CLEARANCE_MS = 10 * 60_000;

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  rootDir: string;
  monitorsDir: string;
  /** What the scripted source will report on its next observation, then clear. */
  emit(command: string): void;
  edit(
    urgency: string,
    body: string,
    options?: { command?: string; settleFor?: string },
  ): void;
  openRuntime(): { runtime: AgentMonitorRuntime; sessionId: string };
}

/**
 * A workspace whose monitor is edited in place. The source reports
 * `payload.command`, standing in for the command-poll output the dogfood report
 * saw; its `objectKey` is that command, as command-poll's default is.
 */
function createFixture(initial: { urgency: string; body: string }): Fixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-451-'));
  tempDirs.push(rootDir);
  const monitorsDir = path.join(rootDir, '.claude', 'monitors');
  const monitorDir = path.join(monitorsDir, MONITOR_ID);
  mkdirSync(monitorDir, { recursive: true });

  // The source's `command` is authored configuration, as `command-poll`'s is:
  // editing it goes through the real parser like any other MONITOR.md edit.
  let currentCommand = 'command-a';
  let currentSettle = '30s';
  const edit = (
    urgency: string,
    body: string,
    options: { command?: string; settleFor?: string } = {},
  ): void => {
    currentCommand = options.command ?? currentCommand;
    currentSettle = options.settleFor ?? currentSettle;
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---\nname: Edit monitor\nwatch:\n  type: ${SOURCE_NAME}\n  command: ${currentCommand}\nnotify:\n  strategy: debounce\n  settle-for: ${currentSettle}\nurgency: ${urgency}\n---\n${body}\n`,
      'utf-8',
    );
  };
  edit(initial.urgency, initial.body);

  let pending: string | undefined;
  const source: ObservationSource = {
    name: SOURCE_NAME,
    scopeSchema: { type: 'object', properties: {}, additionalProperties: true },
    stateful: true,
    observe(): Promise<ObservationResult> {
      const command = pending;
      pending = undefined;
      return Promise.resolve({
        observations:
          command === undefined
            ? []
            : [
                {
                  title: `Result of ${command}`,
                  summary: `output of ${command}`,
                  objectKey: command,
                  payload: { command },
                },
              ],
        nextState: {},
      });
    },
  };

  const dbPath = path.join(rootDir, 'agentmon.db');
  return {
    rootDir,
    monitorsDir,
    emit(command) {
      pending = command;
    },
    edit,
    openRuntime() {
      const registry = new SourceRegistry();
      registry.register(source);
      const runtime = new AgentMonitorRuntime(
        new RuntimeStore(createDb(dbPath)),
        registry,
        [claudeCodeAdapter],
      );
      const session = runtime.openSession(
        claudeCodeAdapter.createSessionInput({
          hostSessionId: 'claude-session-451',
          workspacePath: rootDir,
        }),
      );
      return { runtime, sessionId: session.id };
    },
  };
}

/** Observe, then run past the debounce window so the event materializes. */
async function materialize(
  fixture: Fixture,
  runtime: AgentMonitorRuntime,
  command: string,
): Promise<void> {
  // Clear the poll interval so a second materialization in one test is due.
  vi.advanceTimersByTime(POLL_CLEARANCE_MS);
  fixture.emit(command);
  await runtime.tick(fixture.monitorsDir, fixture.rootDir);
  vi.advanceTimersByTime(PAST_SETTLE_MS);
  const flush = await runtime.tick(fixture.monitorsDir, fixture.rootDir);
  expect(flush.emittedEventIds).toHaveLength(1);
}

async function deliveryStage(
  fixture: Fixture,
  runtime: AgentMonitorRuntime,
  eventLimit?: number,
): Promise<{ reason: string; details?: Record<string, unknown> }> {
  const explained = await runtime.explainMonitor({
    monitorId: MONITOR_ID,
    monitorsDir: fixture.monitorsDir,
    workspacePath: fixture.rootDir,
    ...(eventLimit === undefined ? {} : { eventLimit }),
  });
  const stage = explained.stages.find((s) => s.id === 'delivery');
  if (!stage) throw new Error('explain returned no delivery stage');
  return stage;
}

describe('pending events keep the semantics they were observed under (issue #451)', () => {
  it('a normal event is not escalated into a high-urgency interrupt when the monitor is edited to high', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({
      urgency: 'normal',
      body: 'OLD instructions.',
    });
    const { runtime, sessionId } = fixture.openRuntime();
    await materialize(fixture, runtime, 'gh pr list --limit 12');

    fixture.edit('high', 'NEW instructions: only actionable rows appear.');
    // Past the high-urgency claim settle window, so an escalated event WOULD
    // be eligible to interrupt.
    vi.advanceTimersByTime(PAST_SETTLE_MS);
    const postEdit = await runtime.tick(fixture.monitorsDir, fixture.rootDir);
    expect(postEdit.emittedEventIds).toHaveLength(0);

    const [event] = runtime.listEvents({ sessionId, unreadOnly: true });
    expect(event?.urgency).toBe('normal');
    expect(event?.body).toBe('OLD instructions.');

    const claim = runtime.claimDelivery(sessionId, 'turn-interruptible');
    expect(claim?.urgency).toBe('normal');
    expect(claim?.events).toHaveLength(0);
  });

  it('a high event delivers under command A with A’s body and payload after the monitor is edited to command B', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({
      urgency: 'high',
      body: 'A body: unfiltered rows, triage them.',
    });
    const { runtime, sessionId } = fixture.openRuntime();
    await materialize(fixture, runtime, 'command-a');

    fixture.edit('normal', 'B body: only actionable rows appear.', {
      command: 'command-b',
    });
    vi.advanceTimersByTime(PAST_SETTLE_MS);
    await runtime.tick(fixture.monitorsDir, fixture.rootDir);

    const claim = runtime.claimDelivery(sessionId, 'turn-interruptible');
    expect(claim?.urgency).toBe('high');
    expect(claim?.events).toHaveLength(1);
    const delivered = claim?.events[0];
    expect(delivered?.urgency).toBe('high');
    expect(delivered?.body).toBe('A body: unfiltered rows, triage them.');
    expect(delivered?.objectDetail).toBe('output of command-a');
    expect(JSON.stringify(claim)).not.toContain('B body');
    // The edit really reached the parsed definition, and explain says so.
    expect((await deliveryStage(fixture, runtime)).reason).toMatch(
      /1 pending event\(s\) in total predate/,
    );

    const [stored] = runtime.listEvents({ sessionId });
    expect(stored?.objectKey).toBe('command-a');
    expect(stored?.payload).toEqual({ command: 'command-a' });
  });

  it('an observation held in a debounce batch across the edit materializes under the definition it was observed under', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({
      urgency: 'normal',
      body: 'OLD instructions.',
    });
    const { runtime, sessionId } = fixture.openRuntime();

    fixture.emit('command-a');
    await runtime.tick(fixture.monitorsDir, fixture.rootDir);
    // Edit while the batch is still settling, then let it flush.
    fixture.edit('high', 'NEW instructions.');
    vi.advanceTimersByTime(PAST_SETTLE_MS);
    const flush = await runtime.tick(fixture.monitorsDir, fixture.rootDir);
    expect(flush.emittedEventIds).toHaveLength(1);

    const [event] = runtime.listEvents({ sessionId, unreadOnly: true });
    expect(event?.urgency).toBe('normal');
    expect(event?.body).toBe('OLD instructions.');
    expect(
      runtime.claimDelivery(sessionId, 'turn-interruptible')?.events,
    ).toHaveLength(0);
  });

  it('keeps the observed semantics across a daemon restart that follows the edit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({
      urgency: 'normal',
      body: 'OLD instructions.',
    });
    const first = fixture.openRuntime();
    await materialize(fixture, first.runtime, 'command-a');

    fixture.edit('high', 'NEW instructions.');
    vi.advanceTimersByTime(PAST_SETTLE_MS);

    // A fresh runtime over the same database file: nothing in memory survives.
    const restarted = fixture.openRuntime();
    await restarted.runtime.tick(fixture.monitorsDir, fixture.rootDir);

    const unread = restarted.runtime.listEvents({
      sessionId: restarted.sessionId,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(1);
    expect(unread[0]?.urgency).toBe('normal');
    expect(unread[0]?.body).toBe('OLD instructions.');
    const claim = restarted.runtime.claimDelivery(
      restarted.sessionId,
      'turn-interruptible',
    );
    expect(claim?.events).toHaveLength(0);
  });
});

describe('explain reports pending events that predate the current definition (issue #451)', () => {
  it('flags nothing before the edit, and counts the pending event after it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({ urgency: 'normal', body: 'OLD.' });
    const { runtime } = fixture.openRuntime();
    await materialize(fixture, runtime, 'command-a');

    const before = await deliveryStage(fixture, runtime);
    expect(before.reason).not.toMatch(/predate/);
    expect(before.details?.['staleDefinitionEventIds']).toBeUndefined();

    fixture.edit('high', 'NEW.');
    const after = await deliveryStage(fixture, runtime);
    expect(after.reason).toMatch(
      /1 pending event\(s\) in total predate the monitor's current definition/,
    );
    expect(after.details?.['staleDefinitionEventIds']).toHaveLength(1);
  });

  it('treats a legacy row with no recorded fingerprint as unknown, never stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({ urgency: 'normal', body: 'OLD.' });
    const { runtime } = fixture.openRuntime();
    await materialize(fixture, runtime, 'command-a');

    const raw = new Database(path.join(fixture.rootDir, 'agentmon.db'));
    raw
      .prepare('UPDATE monitor_events SET definition_fingerprint = NULL')
      .run();
    raw.close();

    fixture.edit('high', 'NEW.');
    const stage = await deliveryStage(fixture, runtime);
    expect(stage.reason).not.toMatch(/predate/);
  });

  it('never gates delivery: the flagged event is still delivered as observed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({ urgency: 'high', body: 'OLD.' });
    const { runtime, sessionId } = fixture.openRuntime();
    await materialize(fixture, runtime, 'command-a');
    fixture.edit('normal', 'NEW.');
    vi.advanceTimersByTime(PAST_SETTLE_MS);

    expect((await deliveryStage(fixture, runtime)).reason).toMatch(/predate/);
    const claim = runtime.claimDelivery(sessionId, 'turn-interruptible');
    expect(claim?.events[0]?.body).toBe('OLD.');
    expect(claim?.events[0]?.urgency).toBe('high');
  });

  it('does not flag an edit that only changes notify timing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({ urgency: 'normal', body: 'OLD.' });
    const { runtime } = fixture.openRuntime();
    await materialize(fixture, runtime, 'command-a');

    fixture.edit('normal', 'OLD.', { settleFor: '45s' });
    const stage = await deliveryStage(fixture, runtime);
    expect(stage.reason).not.toMatch(/predate/);
  });

  it('flags a source-config edit (command A to B) with unchanged urgency and body', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({ urgency: 'normal', body: 'SAME.' });
    const { runtime } = fixture.openRuntime();
    await materialize(fixture, runtime, 'command-a');

    fixture.edit('normal', 'SAME.', { command: 'command-b' });
    expect((await deliveryStage(fixture, runtime)).reason).toMatch(
      /1 pending event\(s\) in total predate/,
    );
  });

  it('counts every stale pending event, not only those within eventLimit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({ urgency: 'normal', body: 'OLD.' });
    const { runtime } = fixture.openRuntime();
    for (const command of ['cmd-1', 'cmd-2', 'cmd-3']) {
      await materialize(fixture, runtime, command);
    }

    fixture.edit('high', 'NEW.');
    const stage = await deliveryStage(fixture, runtime, 1);
    expect(stage.reason).toMatch(/3 pending event\(s\) in total predate/);
    expect(stage.details?.['staleDefinitionEventIds']).toHaveLength(3);
  });

  it('opens a database created before the column existed: the old row is unknown, a new row is fingerprinted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fixture = createFixture({ urgency: 'normal', body: 'OLD.' });
    const first = fixture.openRuntime();
    await materialize(fixture, first.runtime, 'command-a');

    // Reduce the database to main's schema: same table, without the column,
    // with the already-materialized row still in it.
    const dbFile = path.join(fixture.rootDir, 'agentmon.db');
    const raw = new Database(dbFile);
    raw.exec('ALTER TABLE monitor_events DROP COLUMN definition_fingerprint');
    expect(
      raw
        .prepare("SELECT name FROM pragma_table_info('monitor_events')")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toContain('definition_fingerprint');
    raw.close();

    // Reopening runs the additive migration; the legacy row survives untouched.
    const reopened = fixture.openRuntime();
    const [legacy] = reopened.runtime.listEvents({
      sessionId: reopened.sessionId,
    });
    expect(legacy?.definitionFingerprint).toBeNull();
    expect(legacy?.body).toBe('OLD.');

    fixture.edit('high', 'NEW.');
    expect((await deliveryStage(fixture, reopened.runtime)).reason).not.toMatch(
      /predate/,
    );

    // A row materialized after the upgrade does carry a fingerprint.
    await materialize(fixture, reopened.runtime, 'command-new');
    fixture.edit('normal', 'NEWER.');
    expect((await deliveryStage(fixture, reopened.runtime)).reason).toMatch(
      /1 pending event\(s\) in total predate/,
    );
  });
});

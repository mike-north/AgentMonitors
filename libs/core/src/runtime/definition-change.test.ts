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
  edit(urgency: string, body: string): void;
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

  const edit = (urgency: string, body: string): void => {
    writeFileSync(
      path.join(monitorDir, 'MONITOR.md'),
      `---\nname: Edit monitor\nwatch:\n  type: ${SOURCE_NAME}\nnotify:\n  strategy: debounce\n  settle-for: 30s\nurgency: ${urgency}\n---\n${body}\n`,
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
  fixture.emit(command);
  await runtime.tick(fixture.monitorsDir, fixture.rootDir);
  vi.advanceTimersByTime(PAST_SETTLE_MS);
  const flush = await runtime.tick(fixture.monitorsDir, fixture.rootDir);
  expect(flush.emittedEventIds).toHaveLength(1);
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

    fixture.edit('normal', 'B body: only actionable rows appear.');
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

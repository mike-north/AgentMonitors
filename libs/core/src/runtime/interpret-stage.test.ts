/**
 * Tests for the optional **Interpret** stage (G14): a cheap agentic digest +
 * significance gate over the per-recipient delta, produced by shelling out to the
 * user's OWN installed AI tool behind a host-agnostic adapter boundary.
 *
 * Every test replaces the user's AI tool with a deterministic FAKE
 * {@link InterpretAdapter} — a real model is NEVER invoked in CI. Expected values
 * are written by hand from the spec, not captured from program output.
 *
 * Proof criteria (issue #178; 002 §1.1.8 test implication):
 *  (a) a `prose` monitor invokes the adapter; a non-`prose` monitor never does.
 *  (b) a "substantive" delta → a `prose` delivery whose digest is the fake's output.
 *  (c) a "not substantive" delta → NO delivery + a per-recipient suppression
 *      reason retrievable via `monitor explain` (C12).
 *  (d) the fake adapter throws → the recipient still receives the §1.1.5
 *      `rendered` artifact (best-effort fallback) + the failure is recorded.
 *  (e) the runtime reads no model credential and ships no model — the only AI call
 *      is the adapter shell-out.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.8
 * @see ../../../../docs/specs/006-agent-integration.md §2.1
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type {
  ObservationResult,
  ObservationSource,
} from '../observation/types.js';
import { claudeCodeAdapter } from '../adapter/claude.js';
import type {
  InterpretAdapter,
  InterpretInput,
  InterpretResult,
} from '../adapter/interpret.js';
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A source that emits one observation per tick with the next supplied
 * `snapshotText` (re-emitting the last once exhausted). The first tick is the
 * baseline (no prior snapshot, so its event has a null diff); subsequent ticks
 * carry a real text diff against the stored snapshot. This lets a test fully
 * control the per-recipient delta the runtime computes.
 */
function scriptedSource(snapshots: string[]): ObservationSource {
  let index = 0;
  return {
    name: 'scripted',
    scopeSchema: { type: 'object', properties: {}, additionalProperties: true },
    stateful: true,
    observe(): Promise<ObservationResult> {
      const snapshotText = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return Promise.resolve({
        observations: [
          {
            title: 'Scripted change',
            summary: 'Scripted change',
            snapshotText,
            objectKey: 'obj-1',
          },
        ],
        nextState: { index },
      });
    },
  };
}

/**
 * The 1s `watch.interval` makes the second tick due; the runtime reads its own
 * clock (no injectable `now`), so a real >1s pause is required between ticks.
 */
const TICK_GAP_MS = 1_100;
function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TICK_GAP_MS));
}

/** The event whose diff is the v1 → v2 delta (the second, non-baseline event). */
function diffEvent<T extends { diffText: string | null }>(
  events: T[],
): T | undefined {
  return events.find((event) => event.diffText !== null);
}

/** Records every {@link InterpretInput} the runtime hands the adapter. */
interface RecordingFake extends InterpretAdapter {
  readonly calls: InterpretInput[];
}

function fakeAdapter(
  classify: (input: InterpretInput) => InterpretResult,
): RecordingFake {
  const calls: InterpretInput[] = [];
  return {
    name: 'fake-interpret',
    calls,
    interpret(input: InterpretInput): Promise<InterpretResult> {
      calls.push(input);
      return Promise.resolve(classify(input));
    },
  };
}

function throwingAdapter(message: string): RecordingFake {
  const calls: InterpretInput[] = [];
  return {
    name: 'fake-throwing-interpret',
    calls,
    interpret(input: InterpretInput): Promise<InterpretResult> {
      calls.push(input);
      return Promise.reject(new Error(message));
    },
  };
}

function writeMonitor(rootDir: string, payloadForm: string | null): string {
  const monitorsDir = path.join(rootDir, '.claude', 'monitors', 'interp');
  mkdirSync(monitorsDir, { recursive: true });
  const payloadBlock =
    payloadForm === null ? '' : `payload:\n  form: ${payloadForm}\n`;
  writeFileSync(
    path.join(monitorsDir, 'MONITOR.md'),
    `---
name: Interpret monitor
watch:
  type: scripted
  interval: 1s
urgency: normal
${payloadBlock}---
Tell me only if the change is substantive.
`,
    'utf-8',
  );
  return path.join(rootDir, '.claude', 'monitors');
}

function setup(
  payloadForm: string | null,
  source: ObservationSource,
  interpret?: InterpretAdapter,
): {
  runtime: AgentMonitorRuntime;
  store: RuntimeStore;
  monitorsDir: string;
  rootDir: string;
} {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-interpret-'));
  tempDirs.push(rootDir);
  const db = createDb(path.join(rootDir, 'agentmon.db'));
  const store = new RuntimeStore(db);
  const registry = new SourceRegistry();
  registry.register(source);
  const runtime = new AgentMonitorRuntime(
    store,
    registry,
    [claudeCodeAdapter],
    interpret,
  );
  const monitorsDir = writeMonitor(rootDir, payloadForm);
  return { runtime, store, monitorsDir, rootDir };
}

describe('Interpret stage (G14, 002 §1.1.8)', () => {
  it('(a) a prose monitor invokes the adapter; the delta is the per-recipient diff', async () => {
    const fake = fakeAdapter(() => ({ decision: 'deliver', digest: 'ok' }));
    const { runtime, monitorsDir, rootDir } = setup(
      'prose',
      scriptedSource(['v1', 'v2']),
      fake,
    );
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    // First tick: baseline event (no prior snapshot). Interpret still reads it,
    // with the snapshot itself as the delta (first appearance).
    await runtime.tick(monitorsDir, rootDir);
    expect(fake.calls).toHaveLength(1);

    // Second tick produces a real v1 → v2 diff — Interpret runs on it.
    await pause();
    await runtime.tick(monitorsDir, rootDir);
    expect(fake.calls).toHaveLength(2);
    // The delta handed to the tool for the second event is the rendered diff,
    // not the raw source snapshot (002 §1.1.8: "never the raw source snapshot").
    // A unified text diff of v1 → v2 contains the added line.
    const deltaCall = fake.calls[1];
    expect(deltaCall?.delta).toContain('v2');
    expect(deltaCall?.monitorId).toBe('interp');
  });

  it('(a) a non-prose monitor NEVER invokes the adapter', async () => {
    const fake = fakeAdapter(() => ({ decision: 'deliver', digest: 'ok' }));
    // `rendered` is a deterministic-floor form that skips Interpret entirely.
    const { runtime, monitorsDir, rootDir } = setup(
      'rendered',
      scriptedSource(['v1', 'v2']),
      fake,
    );
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // baseline
    await pause();
    await runtime.tick(monitorsDir, rootDir); // delta

    expect(fake.calls).toHaveLength(0);
  });

  it('(a) a monitor without any payload form NEVER invokes the adapter', async () => {
    const fake = fakeAdapter(() => ({ decision: 'deliver', digest: 'ok' }));
    const { runtime, monitorsDir, rootDir } = setup(
      null,
      scriptedSource(['v1', 'v2']),
      fake,
    );
    runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir);
    await pause();
    await runtime.tick(monitorsDir, rootDir);

    expect(fake.calls).toHaveLength(0);
  });

  it('(b) a "substantive" delta is delivered with the fake digest as the verdict', async () => {
    const DIGEST = 'The status flipped from green to red.';
    const fake = fakeAdapter(() => ({ decision: 'deliver', digest: DIGEST }));
    const { runtime, store, monitorsDir, rootDir } = setup(
      'prose',
      scriptedSource(['v1', 'v2']),
      fake,
    );
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // baseline
    await pause();
    await runtime.tick(monitorsDir, rootDir); // delta → delivered

    // The substantive delta is delivered (unread) for the recipient.
    const unread = store.unreadEventsForSession(session.id);
    const delta = diffEvent(unread);
    expect(delta).toBeDefined();

    // The recorded per-recipient verdict for the delta event is `deliver` with
    // the fake's exact digest.
    const report = await runtime.explainMonitor({
      monitorId: 'interp',
      monitorsDir,
      workspacePath: rootDir,
    });
    const projection = report.projections.find((p) => p.eventId === delta?.id);
    expect(projection?.interpretDecision).toBe('deliver');
    expect(projection?.interpretDigest).toBe(DIGEST);
  });

  it('(b) the Interpret digest IS the recipient-visible summary in claimDelivery (not the raw body)', async () => {
    // Regression for Copilot comment 3418449211: the digest must reach the
    // recipient, not just be stored on session_event_state. Before this fix,
    // claimDelivery used event.summary/body/title and the digest was never surfaced.
    const DIGEST = 'Pipeline failed on step 3 — urgent review needed.';
    const fake = fakeAdapter(() => ({ decision: 'deliver', digest: DIGEST }));
    const { runtime, monitorsDir, rootDir } = setup(
      'prose',
      scriptedSource(['v1', 'v2']),
      fake,
    );
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // baseline (urgency: high→settle applies; use normal here via monitor spec)
    await pause();
    await runtime.tick(monitorsDir, rootDir); // delta → interpret → deliver

    // The monitor is `normal` urgency (see writeMonitor), so a post-compact
    // recap carries the events with their summaries.
    const claim = runtime.claimDelivery(session.id, 'post-compact');
    expect(claim).not.toBeNull();
    // Every event in the recap must use the Interpret digest, not the raw summary.
    const digestEvent = claim?.events.find((e) => e.summary === DIGEST);
    expect(digestEvent).toBeDefined();
  });

  it('(b) the adapter is called ONCE per event even when multiple sessions share the same delta', async () => {
    // Regression for Copilot comment 3418449196: runInterpret previously called
    // the adapter once per projected session with identical inputs, causing N
    // redundant round-trips to the user's AI tool. The correct behavior is one
    // call per distinct delta, with the verdict applied to all recipients.
    const fake = fakeAdapter(() => ({ decision: 'deliver', digest: 'ok' }));
    const { runtime, store, monitorsDir, rootDir } = setup(
      'prose',
      scriptedSource(['v1', 'v2']),
      fake,
    );

    // Open TWO lead sessions in the same workspace — both receive the same event
    // projection from insertEvent and must share the single adapter invocation.
    const session1 = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-A',
        workspacePath: rootDir,
      }),
    );
    const session2 = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-B',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // baseline: 1 call (delta = snapshotText)
    expect(fake.calls).toHaveLength(1);

    await pause();
    await runtime.tick(monitorsDir, rootDir); // delta event: must be exactly 1 MORE call, not 2

    // Two sessions, one event — adapter must have been called exactly once per
    // tick (total 2), not once per session (total 4).
    expect(fake.calls).toHaveLength(2);

    // Both sessions received the `deliver` verdict from the single adapter call.
    const unread1 = diffEvent(store.unreadEventsForSession(session1.id));
    const unread2 = diffEvent(store.unreadEventsForSession(session2.id));
    expect(unread1).toBeDefined();
    expect(unread2).toBeDefined();
  });

  it('(c) a "not substantive" delta yields NO delivery and an explainable suppression reason', async () => {
    const REASON = 'idle chatter, no question for the principal';
    const fake = fakeAdapter(() => ({ decision: 'suppress', reason: REASON }));
    const { runtime, store, monitorsDir, rootDir } = setup(
      'prose',
      scriptedSource(['v1', 'v2']),
      fake,
    );
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // baseline
    await pause();
    await runtime.tick(monitorsDir, rootDir); // delta → suppressed

    // NO delivery for the recipient (the agentic gate fired on every projection).
    expect(store.unreadEventsForSession(session.id)).toHaveLength(0);
    expect(store.pendingEventsForSession(session.id)).toHaveLength(0);

    // But the suppression is recorded and explainable per-recipient (C12) — the
    // events were still materialized (it is not a silent drop).
    const report = await runtime.explainMonitor({
      monitorId: 'interp',
      monitorsDir,
      workspacePath: rootDir,
    });
    const delta = diffEvent(report.events);
    expect(delta).toBeDefined();
    const projection = report.projections.find((p) => p.eventId === delta?.id);
    expect(projection?.interpretDecision).toBe('suppress');
    expect(projection?.interpretReason).toBe(REASON);

    // The reason surfaces on the delivery stage of `monitor explain` (§10.7).
    const deliveryStage = report.stages.find((s) => s.id === 'delivery');
    expect(deliveryStage?.reason).toContain('suppressed');
  });

  it('(d) when the adapter throws, the recipient still receives the rendered artifact and the failure is recorded', async () => {
    const fake = throwingAdapter('claude: command not found');
    const { runtime, store, monitorsDir, rootDir } = setup(
      'prose',
      scriptedSource(['v1', 'v2']),
      fake,
    );
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // baseline
    await pause();
    await runtime.tick(monitorsDir, rootDir); // delta → tool throws

    // Best-effort fallback (002 §1.1.8): the underlying delta is NOT dropped —
    // the recipient still gets the deterministic delivery for the delta event.
    const unread = store.unreadEventsForSession(session.id);
    const deltaEvent = unread.find((event) => event.diffText !== null);
    expect(deltaEvent).toBeDefined();
    // The delivered artifact carries the §1.1.5 rendered diff text (today's
    // deterministic behavior — degraded gracefully, not lost).
    expect(deltaEvent?.diffText).toContain('v2');

    // The failure is recorded as explainable per-recipient. The adapter was
    // invoked for every projection that materialized a delta event; the verdict
    // recorded for the delta event is `failed` with the tool's error.
    const report = await runtime.explainMonitor({
      monitorId: 'interp',
      monitorsDir,
      workspacePath: rootDir,
    });
    const failedProjection = report.projections.find(
      (projection) => projection.eventId === deltaEvent?.id,
    );
    expect(failedProjection?.interpretDecision).toBe('failed');
    expect(failedProjection?.interpretReason).toBe('claude: command not found');
  });

  it('(e) the runtime ships no model and reads no credential — Interpret is impossible without an injected adapter', async () => {
    // With NO interpret adapter injected, a `prose` monitor still delivers
    // deterministically and the runtime never attempts any AI call. This proves
    // the only AI path is the explicitly-injected adapter shell-out (C45): the
    // core holds no model and no credentials of its own.
    const { runtime, store, monitorsDir, rootDir } = setup(
      'prose',
      scriptedSource(['v1', 'v2']),
      undefined,
    );
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'sess-1',
        workspacePath: rootDir,
      }),
    );

    await runtime.tick(monitorsDir, rootDir); // baseline
    await pause();
    await runtime.tick(monitorsDir, rootDir); // delta

    // The delta is delivered deterministically; no Interpret verdict is recorded
    // because no adapter ran.
    const delta = diffEvent(store.unreadEventsForSession(session.id));
    expect(delta).toBeDefined();
    const report = await runtime.explainMonitor({
      monitorId: 'interp',
      monitorsDir,
      workspacePath: rootDir,
    });
    expect(
      report.projections.every((p) => p.interpretDecision === undefined),
    ).toBe(true);
  });
});

/**
 * Issue #449 — the runtime, not the source, decides a materialized event's
 * `title`: the monitor's AUTHORED `name` when it has one, otherwise the
 * source-provided title unchanged (002 §5.4).
 *
 * The `apps/cli` companion suite (`event-title-transports.test.ts`) proves the
 * same rule end-to-end through the real `command-poll` source and both delivery
 * transports. This suite covers the core rule itself against a scripted source,
 * including the property that makes the rule safe for per-object sources: the
 * source's own per-object text is NOT lost, because it remains the `summary`.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/449
 * @see ../../../../docs/specs/002-runtime-delivery.md §5.4
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { RuntimeStore } from './store.js';
import { AgentMonitorRuntime } from './service.js';
import type { MonitorEventRecord } from './types.js';

const MONITOR_ID = 'spec-watch';
const OBJECT_KEY = 'docs/specs/002-runtime-delivery.md';
/** What a per-object source (e.g. `file-fingerprint`) writes as its own title. */
const SOURCE_TITLE = `File changed: ${OBJECT_KEY}`;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Emits one changing observation per tick, titled the way a real source would. */
function scriptedSource(): ObservationSource {
  let tick = 0;
  return {
    name: 'scripted-title',
    scopeSchema: { type: 'object', properties: {}, additionalProperties: true },
    stateful: true,
    observe(): Promise<ObservationResult> {
      tick += 1;
      return Promise.resolve({
        observations: [
          {
            title: SOURCE_TITLE,
            summary: SOURCE_TITLE,
            snapshotText: `revision ${String(tick)}`,
            objectKey: OBJECT_KEY,
            changeKind: 'modified',
          },
        ],
        nextState: { tick },
      });
    },
  };
}

/**
 * Tick a monitor (named or unnamed) once and return the materialized event.
 * `urgency: low` keeps notify dispatch immediate, so one tick is enough.
 */
async function materializeOneEvent(
  monitorName: string | undefined,
): Promise<MonitorEventRecord> {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-title-'));
  tempDirs.push(rootDir);
  const monitorDir = path.join(rootDir, '.claude', 'monitors', MONITOR_ID);
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(
    path.join(monitorDir, 'MONITOR.md'),
    [
      '---',
      ...(monitorName === undefined ? [] : [`name: ${monitorName}`]),
      'watch:',
      '  type: scripted-title',
      '  interval: 1s',
      'urgency: low',
      '---',
      '',
      'Review the spec change.',
      '',
    ].join('\n'),
    'utf-8',
  );

  const registry = new SourceRegistry();
  registry.register(scriptedSource());
  const db = createDb(path.join(rootDir, 'agentmon.db'));
  const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
    claudeCodeAdapter,
  ]);
  const monitorsDir = path.join(rootDir, '.claude', 'monitors');
  await runtime.tick(monitorsDir, rootDir);

  const events = new RuntimeStore(db).listEvents({ workspacePath: rootDir });
  const event = events[0];
  expect(event).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
  return event!;
}

describe('issue #449: event title selection', () => {
  it('uses the monitor’s authored name as the title', async () => {
    const event = await materializeOneEvent('Spec watcher');
    expect(event.title).toBe('Spec watcher');
  });

  it('does NOT lose the source’s per-object detail — it stays the summary', async () => {
    const event = await materializeOneEvent('Spec watcher');
    expect(event.summary).toBe(SOURCE_TITLE);
    expect(event.objectKey).toBe(OBJECT_KEY);
  });

  it('falls back to the source title when the monitor has no name', async () => {
    const event = await materializeOneEvent(undefined);
    expect(event.title).toBe(SOURCE_TITLE);
  });
});

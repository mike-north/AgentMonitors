/**
 * `monitor explain` delivery counts for a `net` monitor: rows the per-recipient
 * net collapse suppressed are reported under their own count and are never
 * folded into `claimed` (a claimed row was surfaced to the session; a
 * net-suppressed row was deliberately not).
 *
 * @see docs/specs/002-runtime-delivery.md §1.1.7 (net collapse)
 * @see docs/specs/005-cli-reference.md `monitor explain`
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCodeAdapter } from '../adapter/claude.js';
import { createDb } from '../inbox/db.js';
import { SourceRegistry } from '../observation/registry.js';
import type { ObservationSource } from '../observation/types.js';
import { AgentMonitorRuntime } from './service.js';
import { RuntimeStore } from './store.js';

const connections: Database.Database[] = [];
afterEach(() => {
  for (const client of connections.splice(0)) {
    if (client.open) client.close();
  }
  vi.useRealTimers();
});

describe('monitor explain delivery counts (net-suppressed rows)', () => {
  it('counts net-suppressed rows separately from claimed and unread (#572)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    const workspace = mkdtempSync(path.join(tmpdir(), 'explain-net-'));
    const monitorsDir = path.join(workspace, 'monitors');
    let snapshot: string | undefined;
    const source: ObservationSource = {
      name: 'versioned-object',
      stateful: true,
      scopeSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      observe: () =>
        Promise.resolve({
          observations:
            snapshot === undefined
              ? []
              : [
                  {
                    objectKey: 'shared-object',
                    snapshotText: snapshot,
                    title: snapshot,
                    summary: snapshot,
                  },
                ],
          nextState: {},
        }),
    };
    const registry = new SourceRegistry();
    registry.register(source);
    const db = createDb(path.join(workspace, 'runtime.db'));
    connections.push((db as unknown as { $client: Database.Database }).$client);
    const runtime = new AgentMonitorRuntime(new RuntimeStore(db), registry, [
      claudeCodeAdapter,
    ]);
    const session = runtime.openSession(
      claudeCodeAdapter.createSessionInput({
        hostSessionId: 'explain-net',
        workspacePath: workspace,
      }),
    );
    mkdirSync(path.join(monitorsDir, 'net-mon'), { recursive: true });
    writeFileSync(
      path.join(monitorsDir, 'net-mon', 'MONITOR.md'),
      `---
name: net-mon
watch:
  type: versioned-object
  interval: 1s
urgency: high
notify:
  strategy: debounce
  settle-for: 1s
baseline-strategy: net
---
Handle net-mon changes.
`,
    );
    const emit = async (version: string) => {
      vi.advanceTimersByTime(60_000);
      snapshot = version;
      await runtime.tick(monitorsDir, workspace);
      snapshot = undefined;
      vi.advanceTimersByTime(60_000);
      await runtime.tick(monitorsDir, workspace);
    };

    // v1, v2, v3 accumulate unread; one claim surfaces only the newest (v3)
    // and net-suppresses the older intermediates v1, v2.
    await emit('v1');
    await emit('v2');
    await emit('v3');
    const claim = runtime.claimDelivery(session.id, 'turn-interruptible');
    expect(claim?.events.map((event) => event.summary)).toEqual(['v3']);
    // v4 arrives after the claim and stays unread.
    await emit('v4');

    const report = await runtime.explainMonitor({
      monitorId: 'net-mon',
      monitorsDir,
      workspacePath: workspace,
    });
    const delivery = report.stages.find((stage) => stage.id === 'delivery');
    expect(delivery?.details).toMatchObject({
      claimed: 1,
      netSuppressed: 2,
      unread: 1,
    });
  });
});

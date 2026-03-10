import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InboxService } from '../inbox/inbox-service.js';
import type { HookState, UrgentItem } from './types.js';

/**
 * Compute hook state from the current inbox contents.
 */
export function computeHookState(inbox: InboxService): HookState {
  const queued = inbox.list({ state: 'queued' });
  const acked = inbox.list({ state: 'acked' });
  const inProgress = inbox.list({ state: 'in-progress' });
  const failed = inbox.list({ state: 'failed' });

  const urgentItems = inbox.list({ state: 'queued', urgency: 'high' });

  const urgent: UrgentItem[] = urgentItems.map((item) => ({
    id: item.id,
    monitorId: item.monitorId,
    title: item.title,
    createdAt: item.createdAt.toISOString(),
  }));

  return {
    updatedAt: new Date().toISOString(),
    counts: {
      queued: queued.length,
      acked: acked.length,
      'in-progress': inProgress.length,
      failed: failed.length,
    },
    urgent,
  };
}

/**
 * Write hook state atomically (write to temp file, then rename).
 *
 * @param statePath - Path to the hook-state.json file (e.g., `<project>/.agentmonitors/hook-state.json`)
 * @param state - The hook state to write
 */
export function writeBridgeState(statePath: string, state: HookState): void {
  const dir = path.dirname(statePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${statePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, statePath);
}

/**
 * Read hook state from disk.
 *
 * @param statePath - Path to the hook-state.json file
 * @returns The parsed hook state, or null if the file doesn't exist
 */
export function readBridgeState(statePath: string): HookState | null {
  try {
    const content = readFileSync(statePath, 'utf-8');
    return JSON.parse(content) as HookState;
  } catch {
    return null;
  }
}

/**
 * Create an onMutation callback for InboxService that writes hook state on every change.
 *
 * @param inbox - The InboxService instance
 * @param statePath - Path to write the hook-state.json
 */
export function createBridgeCallback(
  inbox: InboxService,
  statePath: string,
): () => void {
  return () => {
    const state = computeHookState(inbox);
    writeBridgeState(statePath, state);
  };
}

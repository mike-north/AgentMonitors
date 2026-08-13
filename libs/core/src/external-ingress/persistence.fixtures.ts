import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXTERNAL_EVENT_SCHEMA } from './contract.js';
import type { ExternalEventIngestInput } from './contract.js';

export const RECEIPT_NOW = new Date('2026-08-13T18:00:00.000Z');
export const RECEIPT_MATERIALIZED_AT = new Date('2026-08-13T18:00:01.000Z');
export const RECEIPT_EVENT_ID = '01EXAMPLEEVENT000000000001';

const tempDirs: string[] = [];

export function cleanupReceiptTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export function receiptScratchDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmon-external-receipts-'));
  tempDirs.push(dir);
  return path.join(dir, 'agentmon.db');
}

export function receiptInput(
  overrides: Partial<ExternalEventIngestInput['envelope']> = {},
  workspaceIdentity = '/workspace-a',
): ExternalEventIngestInput {
  return {
    workspaceIdentity,
    envelope: {
      schema: EXTERNAL_EVENT_SCHEMA,
      monitorId: 'build-health',
      source: 'example-build-system',
      upstreamEventId: 'delivery-42',
      objectId: 'build-group-123',
      objectSequence: 42,
      eventKind: 'build.updated',
      changeKind: 'modified',
      occurredAt: '2026-08-13T17:59:59.000Z',
      resumeToken: 'private-relay-cursor',
      scope: { project: 'example/widgets', secretScope: 'PRIVATE-SCOPE' },
      state: { status: 'passed', secret: 'PRIVATE-STATE' },
      ...overrides,
    },
  };
}

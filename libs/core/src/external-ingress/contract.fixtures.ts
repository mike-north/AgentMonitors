import { expect } from 'vitest';
import {
  EXTERNAL_EVENT_SCHEMA,
  validateExternalEventEnvelope,
} from './contract.js';
import type {
  ExternalEventEnvelope,
  ExternalEventErrorCode,
} from './contract.js';

export function envelope(
  overrides: Partial<ExternalEventEnvelope> = {},
): ExternalEventEnvelope {
  return {
    schema: EXTERNAL_EVENT_SCHEMA,
    monitorId: 'build-health',
    source: 'example-build-system',
    upstreamEventId: 'delivery-01HX',
    objectId: 'build-group-123',
    objectSequence: 42,
    eventKind: 'build.updated',
    changeKind: 'modified',
    occurredAt: '2026-08-13T18:00:00.000Z',
    resumeToken: 'opaque-source-cursor',
    scope: {
      project: 'example/widgets',
      branch: 'alex/update-widget',
    },
    state: { status: 'passed', completed: 12, total: 12 },
    ...overrides,
  };
}

export function expectError(input: unknown, code: ExternalEventErrorCode) {
  const result = validateExternalEventEnvelope(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('expected validation failure');
  expect(result.error).toMatchObject({ code, retryable: false });
  return result.error;
}

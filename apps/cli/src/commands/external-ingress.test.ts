import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { ExternalEventIngestError } from '@agentmonitors/core';
import {
  DaemonApplicationError,
  DaemonConnectionError,
  DaemonUnsupportedRequestError,
} from '../daemon-ipc.js';
import {
  classifyError,
  parseEnvelope,
  registerExternalIngressCommands,
} from './external-ingress.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function envelope() {
  return {
    schema: 'agentmonitors.external-event.v1',
    monitorId: 'build-health',
    source: 'synthetic-build-system',
    upstreamEventId: 'delivery-1',
    objectId: 'build-1',
    objectSequence: 1,
    eventKind: 'build.updated',
    changeKind: 'modified',
    occurredAt: '2026-08-13T18:00:00.000Z',
    resumeToken: 'cursor-1',
    scope: {},
    state: { status: 'passed' },
  };
}

function inputFile(value: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-ingress-command-'));
  roots.push(root);
  const file = path.join(root, 'event.json');
  writeFileSync(file, value, 'utf8');
  return file;
}

describe('external ingress command input', () => {
  it('parses and validates exactly one JSON envelope from a file', () => {
    expect(parseEnvelope(inputFile(JSON.stringify(envelope())))).toEqual(
      envelope(),
    );
  });

  it('rejects multiple JSON values without echoing their contents', () => {
    let thrown: unknown;
    try {
      parseEnvelope(inputFile('{"secret":"first"}\n{"secret":"second"}'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExternalEventIngestError);
    expect(classifyError(thrown)).toEqual({
      code: 'invalid_envelope',
      message: 'Event envelope input must contain exactly one JSON value.',
      retryable: false,
    });
    expect(JSON.stringify(classifyError(thrown))).not.toContain('secret');
  });

  it('registers all four supported operator surfaces and required ids', () => {
    const events = new Command('events');
    const monitor = new Command('monitor');
    registerExternalIngressCommands(events, monitor);
    expect(events.commands.map((command) => command.name())).toEqual([
      'ingest',
      'ingest-status',
      'ingest-retry',
    ]);
    expect(monitor.commands.map((command) => command.name())).toEqual([
      'retry-outbox',
    ]);
    expect(
      events.commands
        .find((command) => command.name() === 'ingest-status')
        ?.options.find(({ long }) => long === '--receipt')?.mandatory,
    ).toBe(true);
  });
});

describe('external ingress error classification', () => {
  it.each([
    [new DaemonConnectionError('offline'), 'daemon_unavailable', true],
    [
      new DaemonUnsupportedRequestError('old daemon'),
      'daemon_incompatible',
      true,
    ],
    [
      new DaemonApplicationError('bad route', 'workspace_mismatch', false),
      'workspace_mismatch',
      false,
    ],
  ])('preserves machine-readable daemon policy', (error, code, retryable) => {
    expect(classifyError(error)).toMatchObject({ code, retryable });
  });

  it('redacts an unexpected error', () => {
    expect(classifyError(new Error('PRIVATE STATE'))).toEqual({
      code: 'internal_error',
      message: 'External event command failed unexpectedly.',
      retryable: true,
    });
  });
});

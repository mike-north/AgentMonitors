/**
 * Public-entry-point consumer behavior for 002 section 2.6 and 004 section 2.14.
 * The compiled package and its trimmed declarations are the consumer boundary.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import * as core from '@agentmonitors/core';
import { envelope } from './contract.fixtures.js';

/** Compile virtual consumer source inside this package, with normal exports resolution. */
function consumerDiagnostics(source: string): readonly ts.Diagnostic[] {
  const file = fileURLToPath(new URL('../../consumer.ts', import.meta.url));
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === file
      ? ts.createSourceFile(file, source, languageVersion)
      : original(name, languageVersion, onError, shouldCreate);
  return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
}

describe('public external envelope contract', () => {
  it('validates and computes deterministic identity through ESM and CJS entry points', () => {
    const cjs = createRequire(import.meta.url)(
      '@agentmonitors/core',
    ) as typeof core;
    for (const api of [core, cjs]) {
      const result = api.validateExternalEventEnvelope(envelope());
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error.message);
      expect(JSON.parse(result.canonicalJson)).toEqual(result.envelope);
      const reordered = api.validateExternalEventEnvelope({
        ...result.envelope,
        state: { total: 12, completed: 12, status: 'passed' },
      });
      expect(reordered.success).toBe(true);
      if (!reordered.success) throw new Error(reordered.error.message);
      expect(reordered.canonicalJson).toBe(result.canonicalJson);
      expect(
        api.externalEventSemanticHash({
          ...result.envelope,
          resumeToken: 'next',
        }),
      ).toBe(api.externalEventSemanticHash(result.envelope));
      expect(api.externalEventObjectKey('source', 'object')).toBe(
        'external:["source","object"]',
      );
      const wider = { ...result.envelope, extra: true };
      expect(api.externalEventSemanticHash(wider)).toBe(
        api.externalEventSemanticHash(result.envelope),
      );
    }
  });

  it('publishes only implemented envelope, validation and identity values', () => {
    expect(
      Object.keys(core)
        .filter((name) => /^(external|EXTERNAL|canonicalJson)/.test(name))
        .sort(),
    ).toEqual(
      [
        'EXTERNAL_EVENT_SCHEMA',
        'externalEventLimits',
        'externalEventObjectKey',
        'externalEventReservedScopeKeys',
        'externalEventSemanticHash',
      ].sort(),
    );
    expect(core).not.toHaveProperty('canonicalJsonStringify');
    expect(core).not.toHaveProperty('assertExternalJsonValue');
    expect(core).not.toHaveProperty('envelopeJsonBytes');
  });

  it('exports composable documented types and literal limits without speculative ingestion types', () => {
    const diagnostics = consumerDiagnostics(`
      import { externalEventLimits, validateExternalEventEnvelope } from '@agentmonitors/core';
      import type { ExternalEventEnvelope, ExternalEventErrorCode, ExternalJsonValue } from '@agentmonitors/core';
      // @ts-expect-error Ingestion has no public producer yet.
      import type { ExternalEventIngestInput, ExternalEventIngestResult, ExternalEventOutcome, ExternalEventDisposition } from '@agentmonitors/core';
      declare const event: ExternalEventEnvelope;
      const json: ExternalJsonValue = event;
      JSON.stringify(json);
      // @ts-expect-error General canonical encoding is an internal implementation detail.
      import { canonicalJsonStringify } from '@agentmonitors/core';
      const envelopeBytes: 262144 = externalEventLimits.envelopeBytes;
      const scopeBytes: 32768 = externalEventLimits.scopeBytes;
      type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
      const exactKinds: Same<ExternalEventEnvelope['changeKind'], 'created' | 'modified' | 'deleted' | 'descoped'> = true;
      const exactCodes: Same<ExternalEventErrorCode, 'invalid_envelope' | 'unsupported_schema' | 'payload_too_large'> = true;
      // @ts-expect-error Version 1 has a closed change classification.
      const kind: ExternalEventEnvelope['changeKind'] = 'updated';
      // @ts-expect-error Only implemented validation errors are published.
      const code: ExternalEventErrorCode = 'daemon_busy';
      const result = validateExternalEventEnvelope(event);
      if (!result.success) { const permanent: boolean = result.error.retryable; }
    `);
    expect(
      diagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      ),
    ).toEqual([]);
  });

  it('records the new surface without undocumented declarations or internal release tags', () => {
    const report = readFileSync(
      new URL('../../api-report/core.api.md', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const start = report.indexOf(
      '// @public\nexport const EXTERNAL_EVENT_SCHEMA',
    );
    const end = report.indexOf(
      '// @public (undocumented)\nexport function fingerprintText',
      start,
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(report.slice(start, end)).not.toMatch(
      /undocumented|@internal|Warning:/,
    );
    expect(report).not.toMatch(
      /export (?:interface|type) ExternalEvent(?:Ingest|Outcome|Disposition)/,
    );
    expect(report).not.toContain('export function canonicalJsonStringify');
  });

  it('cannot weaken any limit through exported runtime metadata', () => {
    expect(Object.isFrozen(core.externalEventLimits)).toBe(true);
    for (const key of Object.keys(core.externalEventLimits)) {
      const before = Reflect.get(core.externalEventLimits, key);
      expect(Reflect.set(core.externalEventLimits, key, 999999)).toBe(false);
      expect(Reflect.get(core.externalEventLimits, key)).toBe(before);
    }
    expect(
      core.validateExternalEventEnvelope(
        envelope({ monitorId: 'x'.repeat(513) }),
      ),
    ).toMatchObject({
      success: false,
      error: { code: 'payload_too_large', retryable: false },
    });
  });
});

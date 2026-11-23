/**
 * The receipt operation as a package consumer sees it: the compiled entry
 * points and their trimmed public declarations (002 §2.6, 004 §2.14). Every
 * public receipt type must resolve to a concrete type there. A reference to a
 * declaration the public rollup trims would silently become `any`, so these
 * checks pin exact types and expect errors that `any` would swallow.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import * as core from '@agentmonitors/core';
import { receiptInput } from './persistence.fixtures.js';

const tsSource = String.raw;

/** Compile virtual consumer source inside this package, with normal exports resolution. */
function consumerDiagnostics(source: string): string[] {
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
  return ts
    .getPreEmitDiagnostics(ts.createProgram([file], options, host))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('public external receipt operation', () => {
  it('accepts and replays through the ESM and CJS entry points', () => {
    const cjs = createRequire(import.meta.url)(
      '@agentmonitors/core',
    ) as typeof core;
    for (const api of [core, cjs]) {
      const store = new api.RuntimeStore(api.createDb(':memory:'));
      const first = store.withExternalEventReceipt(receiptInput(), () => ({
        outcome: 'held',
      }));
      const replay = store.withExternalEventReceipt(receiptInput(), () => {
        throw new Error('replay must not run work');
      });
      expect(first.decision).toBe('accepted');
      expect(replay).toEqual({
        decision: 'duplicate',
        receipt: first.decision === 'accepted' ? first.receipt : undefined,
      });
    }
    expect(core).not.toHaveProperty('DURABLE_INGRESS_COMPATIBILITY_MARKER');
  });

  it('publishes receipt types that resolve exactly in the trimmed declarations', () => {
    expect(
      consumerDiagnostics(tsSource`
        import { RuntimeStore, createDb } from '@agentmonitors/core';
        import type {
          ExternalEventEnvelope,
          ExternalEventReceiptCompletion,
          ExternalEventReceiptDecision,
          ExternalEventReceiptInput,
          ExternalEventReceiptOutcome,
          ExternalEventReceiptRecord,
        } from '@agentmonitors/core';
        type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
        // A trimmed reference would make these any, and any matches nothing exactly.
        const exactOutcome: Same<
          ExternalEventReceiptRecord['outcome'],
          'materialized' | 'held' | 'suppressed' | 'stale' | 'failed'
        > = true;
        const sameOutcome: Same<ExternalEventReceiptOutcome, ExternalEventReceiptRecord['outcome']> = true;
        const exactKind: Same<
          ExternalEventReceiptRecord['changeKind'],
          'created' | 'modified' | 'deleted' | 'descoped'
        > = true;
        const exactEnvelope: Same<ExternalEventReceiptInput['envelope'], ExternalEventEnvelope> = true;
        const store = new RuntimeStore(createDb(':memory:'));
        declare const input: ExternalEventReceiptInput;
        const decision: ExternalEventReceiptDecision = store.withExternalEventReceipt(
          input,
          () => ({ outcome: 'held' }),
        );
        if (decision.decision !== 'conflict') {
          // @ts-expect-error a receipt outcome is not a number
          const notNumber: number = decision.receipt.outcome;
        }
        // @ts-expect-error failed is never an initial outcome
        const failed: ExternalEventReceiptCompletion = { outcome: 'failed' };
        // @ts-expect-error materialized work names at least one event
        const empty: ExternalEventReceiptCompletion = { outcome: 'materialized', eventIds: [] };
        // @ts-expect-error the operation is synchronous
        store.withExternalEventReceipt(input, async () => ({ outcome: 'held' as const }));
        // @ts-expect-error the compatibility marker is internal
        import { DURABLE_INGRESS_COMPATIBILITY_MARKER } from '@agentmonitors/core';
      `),
    ).toEqual([]);
  });
});

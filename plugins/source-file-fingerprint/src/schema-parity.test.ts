/**
 * Schema ↔ parser parity guard for the file-fingerprint source.
 *
 * This source has TWO representations of one `scope` contract:
 *  1. the runtime parser, `parseScopeConfig` (throws on invalid scope), and
 *  2. the hand-authored JSON Schema, `scopeSchema`, validated for editor tooling
 *     via core's `validateScope` (`@cfworker/json-schema`, draft-07).
 *
 * They MUST accept and reject the same inputs. This test pins that invariant
 * against the exact cases that drifted historically (urgency-style required
 * mismatches; whitespace-only / blank-pattern acceptance) so a future change to
 * one representation can never silently diverge from the other.
 *
 * `parseScopeConfig` is not exported, so we exercise it through the public
 * `source.observe` entry point: an invalid scope must throw before any IO.
 *
 * @see ../../../.github/instructions/schema.instructions.md
 * @see ../../../libs/core/src/schema/validate-scope.ts
 */
import { describe, expect, it } from 'vitest';
import { validateScope } from '@agentmonitors/core';
import source from './index.js';

/** A parity corpus row: a labelled scope and whether the contract should accept it. */
interface ParityCase {
  readonly label: string;
  readonly input: Record<string, unknown>;
  readonly expectValid: boolean;
}

/**
 * Run the input through both representations and assert they AGREE.
 *
 * - JSON-Schema view: `validateScope` returns `[]` when valid.
 * - Parser view: `parseScopeConfig` (invoked via `observe`) throws when invalid.
 *
 * The assertion is parity-first: both must accept, or both must reject. We also
 * assert each side matches `expectValid` so a corpus row is anchored to the
 * spec'd outcome rather than merely "whatever both happen to do".
 */
async function expectParity(
  testCase: ParityCase,
  scopeSchema: typeof source.scopeSchema,
): Promise<void> {
  const schemaErrors = validateScope(testCase.input, scopeSchema);
  const schemaValid = schemaErrors.length === 0;

  let parserValid: boolean;
  try {
    await source.observe(testCase.input, {
      now: new Date('2024-01-15T00:00:00.000Z'),
    });
    parserValid = true;
  } catch {
    parserValid = false;
  }

  // Parity: the two representations must reach the same accept/reject verdict.
  expect(
    schemaValid,
    `[${testCase.label}] JSON-Schema valid=${String(schemaValid)} but parser valid=${String(parserValid)} — schema and parser disagree`,
  ).toBe(parserValid);

  // Anchor to the spec'd outcome so a corpus row can't pass by mutual error.
  expect(schemaValid, `[${testCase.label}] JSON-Schema verdict`).toBe(
    testCase.expectValid,
  );
  expect(parserValid, `[${testCase.label}] parser verdict`).toBe(
    testCase.expectValid,
  );
}

const cases: readonly ParityCase[] = [
  {
    label: 'valid array of globs',
    input: { globs: ['*.txt', 'notes/**/*.md'] },
    expectValid: true,
  },
  {
    label: 'valid bare-string glob (shorthand)',
    input: { globs: 'notes.md' },
    expectValid: true,
  },
  {
    label: 'valid ignore exclude globs',
    input: { globs: ['**/*.txt'], ignore: ['**/notified-*.txt'] },
    expectValid: true,
  },
  {
    label: 'valid bare-string ignore exclude glob (shorthand)',
    input: { globs: ['**/*.txt'], ignore: '**/notified-*.txt' },
    expectValid: true,
  },
  {
    label: 'whitespace-only string is rejected',
    input: { globs: '   ' },
    expectValid: false,
  },
  {
    label: 'blank array entry is rejected',
    input: { globs: [''] },
    expectValid: false,
  },
  {
    label: 'missing globs is rejected',
    input: {},
    expectValid: false,
  },
  {
    label: 'non-string, non-array ignore is rejected',
    input: { globs: ['**/*.txt'], ignore: 42 },
    expectValid: false,
  },
  {
    label: 'blank ignore entry is rejected',
    input: { globs: ['**/*.txt'], ignore: [''] },
    expectValid: false,
  },
  {
    label: 'whitespace-only bare-string ignore is rejected',
    input: { globs: ['**/*.txt'], ignore: '   ' },
    expectValid: false,
  },
];

describe('file-fingerprint schema ↔ parser parity', () => {
  it.each(cases.map((c) => [c.label, c] as const))(
    'agrees on: %s',
    async (_label, testCase) => {
      await expectParity(testCase, source.scopeSchema);
    },
  );
});

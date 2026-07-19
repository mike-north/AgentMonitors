/**
 * Schema ↔ parser parity guard for the command-poll source.
 *
 * This source has TWO representations of one `scope` contract:
 *  1. the runtime parser, `parseScopeConfig` (throws on invalid scope), and
 *  2. the hand-authored JSON Schema, `scopeSchema`, validated for editor tooling
 *     via core's `validateScope` (`@cfworker/json-schema`, draft-07).
 *
 * They MUST accept and reject the same inputs. The defining drift class for this
 * source is the argv-vs-bare-string mistake: `command` is argv-only (spawned with
 * `shell: false`), so a bare string must be rejected by BOTH the parser (which
 * teaches the `["sh","-c", …]` idiom) and the JSON Schema. This test pins that.
 *
 * `parseScopeConfig` is not exported, so we exercise it through the public
 * `source.observe` entry point. To keep the valid-argv case deterministic and
 * cross-platform, the corpus uses `process.execPath` (the running Node binary,
 * always present) with a no-op script rather than assuming `git`/`true` exist.
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
 * Parity-first: both must accept, or both must reject. Each side is also anchored
 * to `expectValid` so a corpus row can't pass by both erroring for unrelated
 * reasons.
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

  expect(
    schemaValid,
    `[${testCase.label}] JSON-Schema valid=${String(schemaValid)} but parser valid=${String(parserValid)} — schema and parser disagree`,
  ).toBe(parserValid);

  expect(schemaValid, `[${testCase.label}] JSON-Schema verdict`).toBe(
    testCase.expectValid,
  );
  expect(parserValid, `[${testCase.label}] parser verdict`).toBe(
    testCase.expectValid,
  );
}

const cases: readonly ParityCase[] = [
  {
    label: 'valid argv array',
    // The running Node binary with a no-op `-e ''` script: always present,
    // exits 0 immediately, no external-tool dependency.
    input: { command: [process.execPath, '-e', ''] },
    expectValid: true,
  },
  {
    label: 'bare-string command is rejected (argv-only; teaches sh -c)',
    input: { command: 'git status | wc -l' },
    expectValid: false,
  },
  {
    label: 'empty command array is rejected',
    input: { command: [] },
    expectValid: false,
  },
  {
    label: 'missing command is rejected',
    input: {},
    expectValid: false,
  },
  {
    label: 'timeout "1s" is accepted',
    input: { command: [process.execPath, '-e', ''], timeout: '1s' },
    expectValid: true,
  },
  // Issue #304 review, finding 5 + 6: the `timeout` scope field is now parsed
  // by the same shared `parseOperationTimeoutMs` (core) that `api-poll` uses,
  // and its JSON Schema `pattern` (`OPERATION_TIMEOUT_PATTERN`) was updated in
  // lockstep — a zero-length deadline must be rejected by BOTH, not just one.
  {
    label: 'timeout "0s" is rejected (zero-length deadline)',
    input: { command: [process.execPath, '-e', ''], timeout: '0s' },
    expectValid: false,
  },
  // Issue #304 review, second round: the schema `pattern` (`[1-9]\d*`) has
  // always rejected a leading zero, but the parser's `parseOperationTimeoutMs`
  // (via `parseDuration`'s own `\d+` digit group) previously accepted it —
  // a schema/parser mismatch. Both now reject it.
  {
    label: 'timeout "01s" is rejected (leading zero)',
    input: { command: [process.execPath, '-e', ''], timeout: '01s' },
    expectValid: false,
  },
  // Issue #304 review, second round: a present non-string `timeout` (here a
  // number) was previously silently treated as "omitted" by the parser while
  // the schema already rejected it — both now reject it.
  {
    label: 'timeout 30 (number, not a string) is rejected',
    input: { command: [process.execPath, '-e', ''], timeout: 30 },
    expectValid: false,
  },
];

// Issue #304 review, second round: "25d" exceeds Node's 32-bit setTimeout max
// (2,147,483,647ms) and would otherwise silently fire almost immediately
// instead of the author's intended 25-day deadline. The JSON Schema
// `pattern` (a pure string grammar) cannot express this numeric upper bound,
// so the schema still ACCEPTS "25d" while the parser rejects it — a
// deliberate, narrow, documented gap between the two, not a parity bug. Kept
// as its own assertion rather than a `cases` row, since `expectParity` treats
// schema/parser disagreement as a failure by design (see its docstring).
describe('command-poll timeout upper bound (issue #304 review, second round)', () => {
  it('the parser rejects "25d" even though the schema pattern alone accepts it', async () => {
    const input = { command: [process.execPath, '-e', ''], timeout: '25d' };
    expect(validateScope(input, source.scopeSchema)).toEqual([]);
    await expect(
      source.observe(input, { now: new Date('2024-01-15T00:00:00.000Z') }),
    ).rejects.toThrow(/exceeds the maximum supported deadline/);
  });
});

describe('command-poll schema ↔ parser parity', () => {
  it.each(cases.map((c) => [c.label, c] as const))(
    'agrees on: %s',
    async (_label, testCase) => {
      await expectParity(testCase, source.scopeSchema);
    },
  );
});

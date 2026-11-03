/** Empty and failed jq results must be diagnosable before JSON parsing. */
import { expect, it } from 'vitest';
import { assertPresetOutput } from './fixtures/assert-preset-output.js';
it.each([
  ['0', '', '', false],
  ['7', 'jq: compile error', '', false],
  ['0', '', '[]', true],
])(
  'rejects unusable subprocess results with command, exit and stderr',
  (code, stderr, stdout, truncated) => {
    expect(() =>
      assertPresetOutput(['jq', '-sc', '.'], code, stderr, stdout, truncated),
    ).toThrow(/jq.*\nexit code:.*\nstderr:/);
  },
);
it('accepts valid empty JSON arrays', () => {
  expect(() => assertPresetOutput(['jq'], '0', '', '[]', false)).not.toThrow();
});

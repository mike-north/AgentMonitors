/** Empty and failed jq results must be diagnosable before JSON parsing. */
import { expect, it } from 'vitest';
import { assertPresetOutput } from './fixtures/assert-preset-output.js';
it.each([
  ['0', '', ''],
  ['7', 'jq: compile error', ''],
  ['0', '', '[]'],
])(
  'rejects unusable subprocess results with command, exit and stderr',
  (code, stderr, stdout) => {
    const truncated = stdout === '[]';
    expect(() =>
      assertPresetOutput(['jq', '-sc', '.'], code, stderr, stdout, truncated),
    ).toThrow(/jq.*\nexit code:.*\nstderr:/);
  },
);
it('accepts valid empty JSON arrays', () => {
  expect(() => assertPresetOutput(['jq'], '0', '', '[]', false)).not.toThrow();
});

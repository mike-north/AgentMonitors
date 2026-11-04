/** Empty and failed jq results must be diagnosable before JSON parsing. */
import { expect, it } from 'vitest';
import { assertPresetOutput } from './fixtures/assert-preset-output.js';
it.each([
  ['0', '', '', false],
  ['7', 'jq: compile error', '', false],
  ['7', 'jq: runtime error', '[]', false],
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

it('retains command arguments and bounded stderr text with a cutoff marker', () => {
  // A silent helper return must fail rather than bypass all diagnostic checks.
  expect.assertions(4);
  try {
    assertPresetOutput(
      ['jq', '-n', 'broken('],
      '3',
      'compile error: '.repeat(1000),
      '',
      false,
    );
  } catch (error) {
    const message = String(error);
    expect(message).toContain('broken(');
    expect(message).toContain('compile error:');
    expect(message).toContain('stderr truncated at 4096 bytes');
    expect(message.length).toBeLessThan(4500);
  }
});

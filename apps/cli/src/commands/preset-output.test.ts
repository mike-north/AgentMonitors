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
    ).toThrow(/context: jq; argv withheld\nexit code:.*\nfailure category:/);
  },
);
it('accepts valid empty JSON arrays', () => {
  expect(() => assertPresetOutput(['jq'], '0', '', '[]', false)).not.toThrow();
});

it('reports safe context and bounded metadata without forwarding argv or stderr', () => {
  expect.assertions(8);
  try {
    assertPresetOutput(
      ['jq', 'PRIVATE_ARGV_PAYLOAD'],
      '5',
      'PRIVATE_STDERR_PAYLOAD'.repeat(1000),
      '',
      false,
    );
  } catch (error) {
    const message = String(error);
    expect(message).not.toContain('PRIVATE_ARGV_PAYLOAD');
    expect(message).not.toContain('PRIVATE_STDERR_PAYLOAD');
    expect(message).toContain('context: jq; argv withheld');
    expect(message).toContain('exit code: 5');
    expect(message).toContain('stderr empty: false');
    expect(message).toContain('stderr truncated: true');
    expect(message).toContain('stdout empty: true');
    expect(message.length).toBeLessThan(600);
  }
});
it('distinguishes empty stderr from nonempty withheld stderr', () => {
  expect(() => assertPresetOutput(['jq'], '7', '', '[]', false)).toThrow(
    /stderr empty: true; retained bytes: 0; stderr truncated: false/,
  );
});

it.each([0, 4096, 4097])(
  'reports accurate cutoff and empty metadata for %i stderr bytes',
  (size) => {
    expect(() =>
      assertPresetOutput(
        ['PRIVATE_COMMAND'],
        '7',
        Buffer.alloc(size, 'x'),
        '[]',
        false,
      ),
    ).toThrow(
      `stderr empty: ${size === 0}; retained bytes: ${Math.min(size, 4096)}; stderr truncated: ${size > 4096}`,
    );
  },
);

it('does not invent empty or cutoff metadata for unavailable capture', () => {
  expect(() =>
    assertPresetOutput(['jq'], 'unavailable', '', '', false, 'unknown'),
  ).toThrow(
    'stderr empty: unknown; retained bytes: unknown; stderr truncated: unknown',
  );
});

it.each(['timeout', 'signal'] as const)(
  'reports %s without inventing current stdout or stderr metadata',
  (outcome) => {
    expect.assertions(3);
    try {
      assertPresetOutput(
        ['PRIVATE_ARGV'],
        'unavailable',
        '',
        '',
        false,
        'unknown',
        { outcome },
      );
    } catch (error) {
      const message = String(error);
      expect(message).toContain('stderr capture: incomplete');
      expect(message).toContain('stdout empty: unknown; truncated: unknown');
      expect(message).not.toContain('PRIVATE_ARGV');
    }
  },
);

/** Crafted layouts exercise exactly the parser embedded in the native helper. */
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { DARWIN_PROCARGS_PARSER } from './darwin-procargs.js';

/** A Latin-1 string preserves every kernel byte, including NUL and invalid UTF-8. */
function layout(
  argv: readonly string[],
  env: readonly string[],
  argc = argv.length,
  padding = '\0\0',
  execPath = '/node',
): string {
  const header = Buffer.alloc(4);
  header.writeInt32LE(argc);
  return (
    header.toString('latin1') +
    execPath +
    '\0' +
    padding +
    argv.join('\0') +
    '\0' +
    env.join('\0') +
    '\0\0'
  );
}
/** Evaluate the same pure JavaScript source that JXA receives, without native APIs. */
function parse(data: string): unknown {
  return runInNewContext(
    `${DARWIN_PROCARGS_PARSER}\nparseDarwinProcargs(data)`,
    { data },
  );
}
it('uses only exact environment keys after all argc arguments', () => {
  expect(
    parse(
      layout(['/node', 'AGENTMONITORS_COMMAND_LIFE=argv'], ['OTHER=value']),
    ),
  ).toBeNull();
  expect(
    parse(
      layout(
        ['/node', 'AGENTMONITORS_COMMAND_LIFE=argv'],
        ['AGENTMONITORS_COMMAND_LIFE=env'],
      ),
    ),
  ).toBe('env');
  expect(
    parse(
      layout(
        ['/node'],
        [
          'PREFIX_AGENTMONITORS_COMMAND_LIFE=no',
          'OTHER=AGENTMONITORS_COMMAND_LIFE=no',
        ],
      ),
    ),
  ).toBeNull();
});
it.each([
  // Only the kernel's exact bounded alignment is admissible; empty argv stays uncertain.
  layout(
    ['', '-e', 'worker'],
    ['AGENTMONITORS_COMMAND_LIFE=owned', 'OTHER=value'],
  ),
  layout(['', '', 'worker'], ['AGENTMONITORS_COMMAND_LIFE=owned']),
  layout(['', '/node', 'NAME=value'], ['AGENTMONITORS_COMMAND_LIFE=owned']),
  layout(['', 'worker', ''], ['AGENTMONITORS_COMMAND_LIFE=owned']),
  layout(['/node'], ['AGENTMONITORS_COMMAND_LIFE=owned'], 1, '\0x'),
  layout(['/node'], ['AGENTMONITORS_COMMAND_LIFE=owned'], 1, '\0'),
  layout(['/node'], ['AGENTMONITORS_COMMAND_LIFE=owned'], 1, '\0\0\0'),
  layout(['/node', '', 'AGENTMONITORS_COMMAND_LIFE=argv'], ['OTHER=value']),
  layout(['worker', '', ''], ['AGENTMONITORS_COMMAND_LIFE=retained']),
  layout(['/node'], []),
  layout(
    ['/node'],
    ['AGENTMONITORS_COMMAND_LIFE=a', 'AGENTMONITORS_COMMAND_LIFE=b'],
  ),
  layout(['/node'], ['AGENTMONITORS_COMMAND_LIFE=\xff']),
  layout(['/node'], ['OTHER=value']).slice(0, -2),
  '\x01\0',
  '\x01\0\0\0/no-terminator',
  layout(['/node'], ['OTHER=value'], 99),
])(
  'withholds evidence for ambiguous, padded, duplicate or truncated layouts (%#)',
  (data) => {
    expect(() => parse(data)).toThrow();
  },
);

// The executable path, excluding argc, determines 64-bit pointer alignment.
it.each(Array.from({ length: 8 }, (_, residue) => residue))(
  'accepts exact path alignment at residue %i and rejects an empty first argument',
  (residue) => {
    const execPath = '/node' + 'x'.repeat(residue);
    const padding = '\0'.repeat(
      (8 - ((Buffer.byteLength(execPath) + 1) % 8)) % 8,
    );
    expect(
      parse(
        layout(
          [execPath, 'worker'],
          ['AGENTMONITORS_COMMAND_LIFE=owned'],
          2,
          padding,
          execPath,
        ),
      ),
    ).toBe('owned');
    expect(() =>
      parse(
        layout(
          ['', 'worker'],
          ['AGENTMONITORS_COMMAND_LIFE=owned'],
          2,
          padding,
          execPath,
        ),
      ),
    ).toThrow();
  },
);

/** Crafted layouts exercise exactly the parser embedded in the native helper. */
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { DARWIN_PROCARGS_PARSER } from './darwin-procargs.js';

/** A Latin-1 string preserves every kernel byte, including NUL and invalid UTF-8. */
function layout(
  argv: readonly string[],
  env: readonly string[],
  argc = argv.length,
): string {
  const header = Buffer.alloc(4);
  header.writeInt32LE(argc);
  return (
    header.toString('latin1') +
    '/node\0\0' +
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

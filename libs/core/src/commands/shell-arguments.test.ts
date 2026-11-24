/** Existing core repair diagnostics keep their exact command text (002 §2.7). */
import { expect, it } from 'vitest';
import { _monitorCommandLine } from './shell-arguments.js';

it.each([
  {
    command: ['retry', 'rearm'],
    flags: ['--workspace', '/work/project'],
    ids: ['watcher', 'retry-1'],
    expected:
      'agentmonitors monitor retry rearm --workspace /work/project -- watcher retry-1',
  },
  {
    command: ['retry', 'skip'],
    flags: [],
    ids: ['-watcher', '-retry'],
    expected: 'agentmonitors monitor retry skip -- -watcher -retry',
  },
  {
    command: ['retry', 'rearm'],
    flags: ['--workspace', "Mike's workspace; $literal"],
    ids: ["it's mine", '--'],
    expected:
      "agentmonitors monitor retry rearm --workspace 'Mike'\\''s workspace; $literal' -- 'it'\\''s mine' --",
  },
])(
  'preserves diagnostic command bytes: $expected',
  ({ command, flags, ids, expected }) => {
    expect(_monitorCommandLine(command, flags, ids)).toBe(expected);
  },
);

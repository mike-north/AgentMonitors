/** Endpoint identity controls runtime failures; foreign metadata/churn is informational. */
import { expect, it } from 'vitest';
import { runtimeNetChanges } from './runtime-namespace.mjs';
const entry = {
  type: 'socket',
  device: '1',
  inode: '2',
  mode: '7',
  mtime: '1',
  size: '0',
};
it('ignores metadata changes to the same runtime entry', () =>
  expect(
    runtimeNetChanges(
      { '/runtime': entry },
      { '/runtime': { ...entry, mtime: '2', mode: '5', size: '8' } },
    ),
  ).toEqual([]));
it.each([
  ['created', {}, { '/runtime': entry }],
  ['removed', { '/runtime': entry }, {}],
  ['replaced', { '/runtime': entry }, { '/runtime': { ...entry, inode: '3' } }],
  [
    'type changed',
    { '/runtime': entry },
    { '/runtime': { ...entry, type: 'file' } },
  ],
] as const)('rejects an entry that was %s', (_name, before, after) =>
  expect(runtimeNetChanges(before, after)).toEqual(['/runtime']),
);

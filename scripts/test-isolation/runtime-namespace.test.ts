/** Runtime endpoint differences are observations with direction, never write attribution. */
import { expect, it } from 'vitest';
import { runtimeNetChanges } from './runtime-namespace.mjs';

/** Identity is separate from metadata, which may change on a shared socket. */
const entry = {
  type: 'socket',
  device: '1',
  inode: '2',
  mode: '7',
  mtime: '1',
  size: '0',
};
const socketIdentity = {
  type: 'socket',
  device: '1',
  inode: '2',
  target: null,
};

it('ignores metadata changes to the same runtime entry', () =>
  expect(
    runtimeNetChanges(
      { '/runtime': entry },
      { '/runtime': { ...entry, mtime: '2', mode: '5', size: '8' } },
    ),
  ).toEqual([]));

/** Presence changes have one absent endpoint; replacement keeps both identities. */
it.each([
  [
    'added',
    {},
    { '/runtime': entry },
    { direction: 'added', before: null, after: socketIdentity },
  ],
  [
    'removed',
    { '/runtime': entry },
    {},
    { direction: 'removed', before: socketIdentity, after: null },
  ],
  [
    'replaced inode',
    { '/runtime': entry },
    { '/runtime': { ...entry, inode: '3' } },
    {
      direction: 'replaced',
      before: socketIdentity,
      after: { ...socketIdentity, inode: '3' },
    },
  ],
  [
    'changed device',
    { '/runtime': entry },
    { '/runtime': { ...entry, device: '4' } },
    {
      direction: 'replaced',
      before: socketIdentity,
      after: { ...socketIdentity, device: '4' },
    },
  ],
  [
    'changed type',
    { '/runtime': entry },
    { '/runtime': { ...entry, type: 'file' } },
    {
      direction: 'replaced',
      before: socketIdentity,
      after: { ...socketIdentity, type: 'file' },
    },
  ],
  [
    'changed symlink target',
    { '/runtime': { ...entry, type: 'symlink', target: '/first' } },
    { '/runtime': { ...entry, type: 'symlink', target: '/second' } },
    {
      direction: 'replaced',
      before: { ...socketIdentity, type: 'symlink', target: '/first' },
      after: { ...socketIdentity, type: 'symlink', target: '/second' },
    },
  ],
] as const)(
  'reports the path and endpoint identities when %s',
  (_name, before, after, expected) =>
    expect(runtimeNetChanges(before, after)).toEqual([
      { path: '/runtime', ...expected },
    ]),
);

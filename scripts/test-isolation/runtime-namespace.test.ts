/** Runtime endpoint differences are observations with direction, never write attribution. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { inspection } from './native-inspection.mjs';
import {
  runtimeNetChanges,
  snapshotRuntimeNamespaces,
} from './runtime-namespace.mjs';

// Only this test module receives writable inspection references. The observer's
// real read-only capability remains frozen in application and boundary code.
vi.mock('./native-inspection.mjs', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('./native-inspection.mjs')>();
  return {
    inspection: { ...original.inspection, fs: { ...original.inspection.fs } },
  };
});

/**
 * Deterministically place real filesystem churn after lstat and before the
 * dependent read. This owns every entry and avoids timing-based race coverage.
 */
it.each([
  'directory removed',
  'directory replaced',
  'symlink removed',
  'symlink replaced',
  'directory identity replaced',
])('reports %s during a snapshot without failing it', (change) => {
  const base = fs.mkdtempSync(join(tmpdir(), 'runtime-race-'));
  const directory = join(base, 'runtime');
  const entry = join(directory, 'daemon.sock.lock.d');
  fs.mkdirSync(directory);
  const symlink = change.startsWith('symlink');
  if (symlink) fs.symlinkSync('old-target', entry);
  else fs.mkdirSync(entry);
  let changed = false;
  const observationErrors: string[] = [];
  const operation = symlink ? 'readlinkSync' : 'readdirSync';
  const read = inspection.fs[operation];
  const spy = vi.spyOn(inspection.fs, operation).mockImplementation(
    // Removing/replacing the actual entry here exercises the exact native
    // ENOENT/ENOTDIR/EINVAL window, not a fabricated error object.
    (file: string) => {
      if (file === entry && !changed) {
        changed = true;
        // Retain the old directory for the identity case so even a filesystem
        // that immediately reuses freed inode numbers must allocate a new one.
        if (change === 'directory identity replaced')
          fs.renameSync(entry, entry + '.previous');
        else fs.rmSync(entry, { recursive: true, force: true });
        if (change === 'directory identity replaced') fs.mkdirSync(entry);
        else if (change.endsWith('replaced'))
          fs.writeFileSync(entry, 'replacement');
      }
      return read(file);
    },
  );
  try {
    expect(() =>
      snapshotRuntimeNamespaces(
        [{ base, directory, aliases: [base] }],
        observationErrors,
      ),
    ).not.toThrow();
    expect(changed).toBe(true);
    expect(observationErrors).toEqual([expect.stringContaining(entry)]);
  } finally {
    spy.mockRestore();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

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

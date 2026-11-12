/** Attribution must prefer a false alarm whenever identity or ownership is uncertain. */
import { expect, it } from 'vitest';
import { classifyPathChanges } from './attribution.mjs';

// These identities describe the contract: an old peer owns /held at both reads;
// the coordinator and its descendants never provide foreign-write evidence.
const file = JSON.stringify({
  type: 'file',
  device: '1',
  inode: '2',
  size: '8',
});
const edited = JSON.stringify({
  type: 'file',
  device: '1',
  inode: '2',
  size: '9',
});
const processRow = { pid: 10, parent: 1, start: 1, command: 'peer writer' };
const inspection = {
  processes: new Map([
    [1, { pid: 1, parent: 0, start: 0, command: 'init' }],
    [10, processRow],
    [20, { pid: 20, parent: 1, start: 2000, command: 'coordinator' }],
  ]),
  files: new Map([['/held', [{ pid: 10, device: '1', inode: '2' }]]]),
};

it('reports stable pre-run peer identity and keeps unheld changes strict', () => {
  const result = classifyPathChanges(
    { '/held': file, '/unheld': file },
    { '/held': edited, '/unheld': edited },
    inspection,
    inspection,
    2000,
    20,
  );
  expect(result.strict).toEqual(['/unheld']);
  expect(result.foreign).toEqual([{ ...processRow, files: ['/held'] }]);
});

it.each([
  'missing before',
  'missing after',
  'reused pid',
  'new process',
  'descendant',
  'unknown ancestry',
  'unavailable',
])('does not exclude with %s evidence', (fault) => {
  const processes = new Map(inspection.processes);
  const files = new Map(inspection.files);
  let before: typeof inspection | { reason: string } = inspection;
  let after: typeof inspection | { reason: string } = { processes, files };
  if (fault === 'missing before') before = { ...inspection, files: new Map() };
  if (fault === 'missing after') files.clear();
  if (fault === 'reused pid') processes.set(10, { ...processRow, start: 2 });
  if (fault === 'new process') {
    before = {
      ...inspection,
      processes: new Map(
        [...inspection.processes].map(([pid, row]) => [
          pid,
          pid === 10 ? { ...row, start: 2000 } : row,
        ]),
      ),
    };
    processes.set(10, { ...processRow, start: 2000 });
  }
  if (fault === 'descendant') processes.set(10, { ...processRow, parent: 20 });
  if (fault === 'unknown ancestry')
    processes.set(10, { ...processRow, parent: 99 });
  if (fault === 'unavailable') after = { reason: 'no inspection' };
  expect(
    classifyPathChanges(
      { '/held': file },
      { '/held': edited },
      before,
      after,
      2000,
      20,
    ).strict,
  ).toEqual(['/held']);
});

it.each([
  ['creation', {}, { '/held': edited }],
  ['removal', { '/held': file }, {}],
  [
    'replacement',
    { '/held': file },
    { '/held': JSON.stringify({ type: 'file', device: '1', inode: '3' }) },
  ],
  [
    'directory metadata',
    { '/held': JSON.stringify({ type: 'directory', size: '8' }) },
    { '/held': JSON.stringify({ type: 'directory', size: '9' }) },
  ],
] as const)('always rejects %s', (_name, before, after) => {
  expect(
    classifyPathChanges(before, after, inspection, inspection, 2000, 20).strict,
  ).toEqual(['/held']);
});

it('keeps files with unknown filesystem identity strict', () => {
  expect(
    classifyPathChanges(
      { '/held': JSON.stringify({ type: 'file', size: '8' }) },
      { '/held': JSON.stringify({ type: 'file', size: '9' }) },
      inspection,
      inspection,
      2000,
      20,
    ).strict,
  ).toEqual(['/held']);
});

it.each(['before', 'after'])(
  'rejects an open predecessor at the %s snapshot',
  (when) => {
    const stale = {
      ...inspection,
      files: new Map([['/held', [{ pid: 10, device: '1', inode: '3' }]]]),
    };
    expect(
      classifyPathChanges(
        { '/held': file },
        { '/held': edited },
        when === 'before' ? stale : inspection,
        when === 'after' ? stale : inspection,
        2000,
        20,
      ).strict,
    ).toEqual(['/held']);
  },
);

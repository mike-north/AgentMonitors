/**
 * Packing must preserve argv literally, including paths that a shell would split
 * or interpret. Windows must never fall back to executing a command shim.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { packPackage } from './pack-helpers.mjs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

/** Every fixture is disposable; process-global selection inputs are restored. */
const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(existsSync).mockReset();
  vi.mocked(spawnSync).mockReset();
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A real JS entrypoint records what Node received, independent of shell syntax. */
function fixture(extension: string): { root: string; entry: string } {
  const root = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'am pack & spaces-')),
  );
  roots.push(root);
  const entry = path.join(root, `pnpm${extension}`);
  writeFileSync(
    entry,
    `import('node:fs').then(fs => {
     fs.writeFileSync(process.argv[4] + '/fixture.tgz', 'packed');
     fs.writeFileSync(process.argv[4] + '/argv.json', JSON.stringify(process.argv.slice(2)));
     });`,
  );
  return { root, entry };
}

describe('packPackage shell-free invocation (#520)', () => {
  it.each(['.cjs', '.js', '.mjs'])(
    'runs the %s entrypoint with literal path arguments',
    (extension) => {
      const { root, entry } = fixture(extension);
      vi.stubEnv('npm_execpath', entry);
      expect(packPackage(root, root)).toBe(path.join(root, 'fixture.tgz'));
      expect(
        JSON.parse(readFileSync(path.join(root, 'argv.json'), 'utf8')),
      ).toEqual(['pack', '--pack-destination', root]);
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [entry, 'pack', '--pack-destination', root],
        expect.not.objectContaining({ shell: expect.anything() }),
      );
    },
  );

  it.each([
    undefined,
    '/tools/pnpm.cmd',
    '/tools/npm-cli.js',
    '/tools/yarn.js',
    '/tools/bun.js',
  ])('fails clearly on Windows without a JS entrypoint (%s)', (entry) => {
    const { root } = fixture('.cjs');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('npm_execpath', entry);
    // Other managers can be installed without becoming valid pnpm launchers.
    vi.mocked(existsSync).mockImplementation(
      (candidate) => typeof entry === 'string' && candidate === entry,
    );
    expect(() => packPackage(root, root)).toThrow(/run via pnpm/i);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('retains a shell-free pnpm fallback on POSIX', () => {
    const { root } = fixture('.cjs');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubEnv('npm_execpath', undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(spawnSync).mockImplementationOnce(() => {
      writeFileSync(path.join(root, 'fallback.tgz'), 'packed');
      return {
        pid: 1,
        output: [],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
      };
    });
    expect(packPackage(root, root)).toBe(path.join(root, 'fallback.tgz'));
    expect(spawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['pack', '--pack-destination', root],
      expect.not.objectContaining({ shell: expect.anything() }),
    );
  });
});

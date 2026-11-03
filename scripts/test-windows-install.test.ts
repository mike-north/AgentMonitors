/**
 * The install harness must hand Node an npm JS entrypoint and literal argv,
 * keeping spaces in every isolated path. Native Windows execution belongs to CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './test-windows-install.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdtempSync: vi.fn(actual.mkdtempSync),
  };
});
vi.mock('./lib/pack-helpers.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/pack-helpers.mjs')>();
  return {
    ...actual,
    packPackage: (dir: string, dest: string) =>
      path.join(dest, `${path.basename(dir)} & package.tgz`),
  };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  for (const result of vi.mocked(mkdtempSync).mock.results) {
    if (result.type === 'return') {
      rmSync(result.value, { recursive: true, force: true });
    }
  }
  vi.clearAllMocks();
  vi.restoreAllMocks();
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

describe('Windows install harness argv (#520)', () => {
  it.each(['win32', 'linux'])(
    'resolves npm beside Node for the %s layout without a shell',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      const npmCli = path.join(
        path.dirname(process.execPath),
        platform === 'win32'
          ? 'node_modules/npm/bin/npm-cli.js'
          : '../lib/node_modules/npm/bin/npm-cli.js',
      );
      vi.mocked(existsSync).mockImplementation(
        (candidate) => candidate === npmCli,
      );
      const version = JSON.parse(
        readFileSync(
          new URL('../apps/cli/package.json', import.meta.url),
          'utf8',
        ),
      ).version;
      vi.mocked(spawnSync).mockImplementation((_command, args) => ({
        pid: 1,
        output: [],
        status: 0,
        signal: null,
        stderr: '',
        stdout: args?.includes('--version') ? version : 'native-addon-ok',
      }));
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await main();
      const [command, args, options] = vi.mocked(spawnSync).mock.calls[0];
      expect(command).toBe(process.execPath);
      expect(args?.slice(0, 4)).toEqual([
        npmCli,
        'install',
        '--global',
        '--prefix',
      ]);
      expect(existsSync).toHaveBeenCalledWith(npmCli);
      expect(vi.mocked(mkdtempSync).mock.calls[0]?.[0]).toContain(
        'am windows install-',
      );
      expect(args?.[4]).toContain('am windows install-');
      expect(options?.env?.npm_config_cache).toContain('am windows install-');
      expect(
        args?.slice(7).every((arg) => arg.includes(' & package.tgz')),
      ).toBe(true);
      for (const call of vi.mocked(spawnSync).mock.calls) {
        expect(call[2]).not.toHaveProperty('shell');
      }
    },
  );

  it('fails with a useful diagnosis when npm is absent from the Node installation', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(main()).rejects.toThrow(/npm-cli\.js.*Node installation/i);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

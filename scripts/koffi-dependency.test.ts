/** Packed native support is self-contained and cannot request registry-only Koffi packages. */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { packPackage } from './lib/pack-helpers.mjs';

const root = path.resolve(import.meta.dirname, '..');
/** Every dependency relationship can cause a consumer to consult its registry. */
function assertNoRegistryBinding(
  manifest: Record<string, Record<string, string>>,
) {
  for (const section of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    expect(
      Object.keys(manifest[section] ?? {}).filter(
        (name) => name === 'koffi' || name.startsWith('@koromix/'),
      ),
    ).toEqual([]);
  }
}
describe('vendored native exec dependency policy', () => {
  it.each(['plugins/source-command-poll', 'apps/cli'])(
    'ships complete native support without registry dependencies in %s',
    (dir) => {
      const packageDir = path.join(root, dir);
      assertNoRegistryBinding(
        JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')),
      );
      const packed = packPackage(
        packageDir,
        mkdtempSync(path.join(tmpdir(), 'kp-')),
      );
      const manifest = spawnSync(
        'tar',
        ['-xOf', packed, 'package/package.json'],
        { encoding: 'utf8' },
      );
      expect(manifest.status, manifest.stderr).toBe(0);
      assertNoRegistryBinding(JSON.parse(manifest.stdout));
      const listing = spawnSync('tar', ['-tf', packed], { encoding: 'utf8' });
      expect(listing.status, listing.stderr).toBe(0);
      for (const file of [
        'wrapper.cjs',
        'load.cjs',
        'LICENSE.txt',
        'manifest.json',
        ...['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'].map(
          (platform) => `${platform}/koffi.node`,
        ),
      ]) {
        expect(listing.stdout.split('\n')).toContain(
          `package/vendor/koffi/${file}`,
        );
      }
    },
    30_000,
  );
  it('does not exempt Koffi from the release cooldown', () => {
    const workspace = parse(
      readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );
    expect(
      workspace.minimumReleaseAgeExclude.filter((value: string) =>
        value.includes('koffi'),
      ),
    ).toEqual([]);
  });
  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'rejects a registry native binding in %s',
    (section) => {
      for (const name of ['koffi', '@koromix/koffi-linux-x64']) {
        expect(() =>
          assertNoRegistryBinding({ [section]: { [name]: '3.3.7' } }),
        ).toThrow();
      }
    },
  );
});

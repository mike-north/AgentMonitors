/** Native exec support must respect the workspace release cooldown without build permission. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
describe('native exec dependency policy', () => {
  it.each(['plugins/source-command-poll', 'apps/cli'])(
    'pins the eligible native binding in %s',
    (dir) => {
      const manifest = JSON.parse(
        readFileSync(new URL(`${dir}/package.json`, root), 'utf8'),
      );
      expect(manifest.dependencies.koffi).toBe('3.3.7');
    },
  );
  it('uses the native prebuild without cooldown exemptions or lifecycle permission', () => {
    const workspace = parse(
      readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8'),
    );
    expect(
      workspace.minimumReleaseAgeExclude.filter((value: string) =>
        value.includes('koffi'),
      ),
    ).toEqual([]);
    expect(workspace.allowBuilds.koffi).toBe(false);
    const lock = parse(readFileSync(new URL('pnpm-lock.yaml', root), 'utf8'));
    for (const dir of ['plugins/source-command-poll', 'apps/cli']) {
      expect(lock.importers[dir].dependencies.koffi).toEqual({
        specifier: '3.3.7',
        version: '3.3.7',
      });
    }
  });
});

/**
 * Exercises the BUILT `@agentmonitors/core` output (`dist/index.js` and
 * `dist/index.cjs`), not the TypeScript source, so the bundling of the CEL
 * stack is covered: the published build must evaluate CEL on its own, import
 * none of the bundled packages at run time, and ship their license notices.
 * The `test` target depends on `build`, so `dist/` is current when this runs.
 *
 * @see ../../../docs/specs/001-monitor-definition.md §5.1 (Shape declaration, CEL predicates)
 * @see ../THIRD_PARTY_NOTICES.md
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(here, '..');
const distEsm = path.join(coreRoot, 'dist', 'index.js');
const distCjs = path.join(coreRoot, 'dist', 'index.cjs');

/** Packages bundled into the build; they must not be runtime imports. */
const BUNDLED = ['cel-js', 'chevrotain', '@chevrotain/', 'lodash-es', 'ramda'];

interface CelSurface {
  computeDerivedFacts(
    snapshot: unknown,
    now: number,
    rules: { name: string; when: string }[],
  ): { name: string }[];
  validateCelPredicate(expression: string): string | undefined;
}

describe.each([
  ['ESM', async () => (await import(distEsm)) as CelSurface],
  ['CJS', async () => createRequire(import.meta.url)(distCjs) as CelSurface],
])('built core package (%s)', (_format, load) => {
  it('evaluates a CEL predicate over a snapshot', async () => {
    const core = await load();
    const facts = core.computeDerivedFacts({ count: 7, status: 'open' }, 0, [
      { name: 'busy', when: 'count > 5 && status == "open"' },
      { name: 'idle', when: 'count < 5' },
    ]);
    expect(facts).toEqual([{ name: 'busy' }]);
  });

  it('rejects an unparsable CEL predicate', async () => {
    const core = await load();
    expect(core.validateCelPredicate('count >')).toEqual(expect.any(String));
    expect(core.validateCelPredicate('count > 1')).toBeUndefined();
  });
});

describe('built core package contents', () => {
  it.each([distEsm, distCjs])(
    'does not import a bundled package at run time (%s)',
    (file) => {
      const source = readFileSync(file, 'utf8');
      for (const name of BUNDLED) {
        expect(source).not.toMatch(
          new RegExp(`(?:from|require\\()\\s*["']${name}`),
        );
      }
    },
  );

  it('declares none of the bundled packages as runtime dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(coreRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; files: string[] };
    for (const name of BUNDLED) {
      expect(Object.keys(pkg.dependencies)).not.toContain(
        name.replace(/\/$/, ''),
      );
    }
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md');
  });

  it('ships a license notice for every bundled package', () => {
    const notices = readFileSync(
      path.join(coreRoot, 'THIRD_PARTY_NOTICES.md'),
      'utf8',
    );
    for (const name of [
      'cel-js',
      'chevrotain',
      '@chevrotain/cst-dts-gen',
      '@chevrotain/gast',
      '@chevrotain/regexp-to-ast',
      '@chevrotain/types',
      '@chevrotain/utils',
      'lodash-es',
      'ramda',
    ]) {
      expect(notices).toContain(`## ${name} `);
    }
  });
});

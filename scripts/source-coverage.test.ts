// Unit tests for the source-coverage derivation/validation logic that keeps
// the standalone-consumer smoke test's `plugins/source-*` coverage in sync
// with `PACKAGE_DIRS` (scripts/publish-release-packages.mjs), per issue #264
// acceptance criterion 3 ("a test proves that an uncovered source-* package
// produces a loud failure").
// `source-coverage.mjs`, `publish-release-packages.mjs`, and
// `test-standalone-consumer.mjs` are plain JS (no `.d.ts`), consistent with
// the rest of `scripts/` (see eslint.config.mjs's `scripts/**/*.mjs`
// override) — this file isn't part of any tsconfig project either, so it
// relies on vitest's untyped esbuild transform rather than `tsc --noEmit`.
import { describe, expect, it } from 'vitest';
import {
  assertSourceCoverage,
  sourcePackageNamesFromDirs,
} from './source-coverage.mjs';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';
import { SOURCE_PLUGINS } from './test-standalone-consumer.mjs';

describe('sourcePackageNamesFromDirs', () => {
  it('extracts only plugins/source-* dirs, stripping the prefix', () => {
    expect(
      sourcePackageNamesFromDirs([
        'libs/core',
        'plugins/source-api-poll',
        'plugins/source-command-poll',
        'apps/cli',
      ]),
    ).toEqual(['api-poll', 'command-poll']);
  });

  it('sorts and de-duplicates the result', () => {
    expect(
      sourcePackageNamesFromDirs([
        'plugins/source-schedule',
        'plugins/source-api-poll',
        'plugins/source-api-poll',
      ]),
    ).toEqual(['api-poll', 'schedule']);
  });

  it('returns an empty list when there are no source-* dirs', () => {
    expect(sourcePackageNamesFromDirs(['libs/core', 'apps/cli'])).toEqual([]);
  });
});

describe('assertSourceCoverage', () => {
  it('does not throw when every source-* package dir is covered', () => {
    expect(() =>
      assertSourceCoverage(
        ['libs/core', 'plugins/source-api-poll', 'plugins/source-schedule'],
        ['api-poll', 'schedule'],
      ),
    ).not.toThrow();
  });

  it('does not throw when the covered list has extra, non-required names', () => {
    // Coverage is only required to be a superset of PACKAGE_DIRS-derived
    // names; a name that isn't (yet) published is not a drift failure here.
    expect(() =>
      assertSourceCoverage(
        ['plugins/source-api-poll'],
        ['api-poll', 'not-yet-published'],
      ),
    ).not.toThrow();
  });

  // Regression test for issue #264: before assertSourceCoverage existed, a
  // publishable `plugins/source-*` package with no corresponding smoke-test
  // coverage (e.g. the real `command-poll` package, once) went unnoticed. A
  // synthetic uncovered package here proves the check fails loudly, naming
  // exactly the missing package, rather than silently passing.
  it('throws loudly, naming the missing package, on an uncovered source-* dir', () => {
    expect(() =>
      assertSourceCoverage(
        [
          'libs/core',
          'plugins/source-api-poll',
          'plugins/source-fake-uncovered',
        ],
        ['api-poll'],
      ),
    ).toThrow(/fake-uncovered/);
  });

  it('names every missing package when more than one is uncovered', () => {
    expect(() =>
      assertSourceCoverage(
        ['plugins/source-alpha-fake', 'plugins/source-beta-fake'],
        [],
      ),
    ).toThrow(/alpha-fake.*beta-fake/s);
  });
});

// Drift guard: the real standalone-consumer smoke test's SOURCE_PLUGINS list
// must stay in sync with the real, authoritative PACKAGE_DIRS list. This is
// the actual regression this issue fixes — before the fix, `command-poll`
// was present in PACKAGE_DIRS but absent from the smoke test's coverage, and
// this assertion would have failed with that exact drift.
describe('standalone-consumer source coverage (real lists)', () => {
  it('covers every published plugins/source-* package', () => {
    expect(() =>
      assertSourceCoverage(
        PACKAGE_DIRS,
        SOURCE_PLUGINS.map(
          (plugin: { sourceName: string }) => plugin.sourceName,
        ),
      ),
    ).not.toThrow();
  });

  it('has a SOURCE_PLUGINS entry for every source-* package dir in PACKAGE_DIRS', () => {
    const requiredDirs = PACKAGE_DIRS.filter((dir: string) =>
      dir.startsWith('plugins/source-'),
    );
    const coveredDirs = SOURCE_PLUGINS.map(
      (plugin: { dir: string }) => plugin.dir,
    );
    for (const dir of requiredDirs) {
      expect(coveredDirs).toContain(dir);
    }
  });
});

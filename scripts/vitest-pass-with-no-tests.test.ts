/**
 * Regression guard for issue #288: every test-bearing package's vitest config
 * must reject an empty/misconfigured test run (vitest's own default,
 * `passWithNoTests: false`) rather than silently reporting green. Configs are
 * dynamically imported — the same module `vitest run` itself loads — so
 * these assertions reflect the real, resolved config value, not a
 * hand-parsed approximation of the file's source text.
 *
 * @see https://vitest.dev/config/#passwithnotests
 */
import { describe, expect, it } from 'vitest';
import { PACKAGE_DIRS, REPO_ROOT } from './publish-release-packages.mjs';
import {
  ADDITIONAL_VITEST_CONFIG_PATHS,
  allGuardedVitestConfigPaths,
  assertNoneOptIntoPassWithNoTests,
  defaultVitestConfigPaths,
  importVitestConfig,
  optsIntoPassWithNoTests,
} from './vitest-pass-with-no-tests.mjs';

describe('optsIntoPassWithNoTests', () => {
  it('flags an explicit passWithNoTests: true', () => {
    expect(optsIntoPassWithNoTests({ test: { passWithNoTests: true } })).toBe(
      true,
    );
  });

  it('does not flag an explicit passWithNoTests: false', () => {
    expect(optsIntoPassWithNoTests({ test: { passWithNoTests: false } })).toBe(
      false,
    );
  });

  it('does not flag a config that omits passWithNoTests (vitest default is false)', () => {
    expect(optsIntoPassWithNoTests({ test: {} })).toBe(false);
  });

  it('does not flag a config with no `test` key at all', () => {
    expect(optsIntoPassWithNoTests({})).toBe(false);
  });

  it('does not flag an entirely undefined resolved config', () => {
    expect(optsIntoPassWithNoTests(undefined)).toBe(false);
  });
});

describe('assertNoneOptIntoPassWithNoTests', () => {
  it('does not throw when nothing opts in', () => {
    expect(() =>
      assertNoneOptIntoPassWithNoTests([
        {
          configPath: 'a/vitest.config.ts',
          resolvedConfig: { test: { passWithNoTests: false } },
        },
        { configPath: 'b/vitest.config.ts', resolvedConfig: { test: {} } },
      ]),
    ).not.toThrow();
  });

  // Regression fixture for issue #288: reproduces the pre-fix shape of
  // libs/core, apps/cli, apps/agentmonitors, and every plugins/source-*
  // config (all `passWithNoTests: true`) to prove the guard would have
  // caught it, naming every offender rather than stopping at the first.
  it('throws, naming every offending config, when one or more opt in', () => {
    expect(() =>
      assertNoneOptIntoPassWithNoTests([
        {
          configPath: 'libs/core/vitest.config.ts',
          resolvedConfig: { test: { passWithNoTests: true } },
        },
        {
          configPath: 'apps/cli/vitest.config.ts',
          resolvedConfig: { test: { passWithNoTests: false } },
        },
        {
          configPath: 'plugins/source-schedule/vitest.config.ts',
          resolvedConfig: { test: { passWithNoTests: true } },
        },
      ]),
    ).toThrow(
      /libs\/core\/vitest\.config\.ts.*plugins\/source-schedule\/vitest\.config\.ts/s,
    );
  });

  it('does not name a config that correctly sets passWithNoTests: false alongside an offender', () => {
    let thrown: unknown;
    try {
      assertNoneOptIntoPassWithNoTests([
        {
          configPath: 'apps/cli/vitest.serial.config.ts',
          resolvedConfig: { test: { passWithNoTests: false } },
        },
        {
          configPath: 'libs/core/vitest.config.ts',
          resolvedConfig: { test: { passWithNoTests: true } },
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('libs/core/vitest.config.ts');
    expect((thrown as Error).message).not.toContain(
      'apps/cli/vitest.serial.config.ts',
    );
  });
});

describe('defaultVitestConfigPaths / allGuardedVitestConfigPaths', () => {
  it('derives one vitest.config.ts per packageDirs entry', () => {
    expect(defaultVitestConfigPaths(['libs/core', 'apps/cli'])).toEqual([
      'libs/core/vitest.config.ts',
      'apps/cli/vitest.config.ts',
    ]);
  });

  it('includes the serial CLI suite alongside every default config', () => {
    const all = allGuardedVitestConfigPaths(['libs/core']);
    expect(all).toEqual([
      'libs/core/vitest.config.ts',
      ...ADDITIONAL_VITEST_CONFIG_PATHS,
    ]);
  });
});

// Drift guard + the actual regression proof: every real, on-disk vitest
// config this repo's CI runs must reject an empty test run. The guarded set
// is derived from PACKAGE_DIRS (scripts/publish-release-packages.mjs) rather
// than a second hand-maintained list, so a newly added publishable package is
// covered automatically — it can't silently reintroduce passWithNoTests: true.
describe('real repo vitest configs (drift guard)', () => {
  it.each(allGuardedVitestConfigPaths())(
    '%s does not opt into passWithNoTests: true',
    async (configPath) => {
      const resolvedConfig = await importVitestConfig(REPO_ROOT, configPath);
      expect(optsIntoPassWithNoTests(resolvedConfig)).toBe(false);
    },
  );

  // Sanity-checks the fixture list itself so a future edit that quietly
  // empties PACKAGE_DIRS doesn't turn every `it.each` case above into a
  // vacuous pass.
  it('PACKAGE_DIRS is non-empty', () => {
    expect(PACKAGE_DIRS.length).toBeGreaterThan(0);
  });

  it('the serial CLI suite (already-correct pattern) is included by name', () => {
    expect(allGuardedVitestConfigPaths()).toContain(
      ADDITIONAL_VITEST_CONFIG_PATHS[0],
    );
  });
});

// Guards against a test-bearing package's vitest config silently opting into
// `passWithNoTests: true` (issue #288). Deleting, renaming, or accidentally
// excluding an entire package's test files would otherwise leave its Nx
// `test` target reporting green — a silent, high-leverage false pass for a
// repo that relies on package-level suites as executable evidence for
// durable-state and delivery invariants.
//
// Every config is loaded with a real dynamic `import()` — the same module
// `vitest run` itself resolves and executes — rather than a hand-parsed
// regex/AST approximation of the file's source text, so this reflects the
// config's real, resolved value.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';

/**
 * Default vitest config path for every publishable package in `packageDirs`.
 * Every `PACKAGE_DIRS` entry ships a plain `"test": "vitest run"` script (see
 * each package.json), so its default config file is always `vitest.config.ts`
 * at the package root.
 *
 * @param {readonly string[]} [packageDirs]
 * @returns {string[]} config paths relative to the repo root
 */
export function defaultVitestConfigPaths(packageDirs = PACKAGE_DIRS) {
  return packageDirs.map((dir) => path.join(dir, 'vitest.config.ts'));
}

/**
 * Named vitest configs, beyond each package's default `vitest.config.ts`,
 * that are wired into a CI test step and so must also be covered by this
 * audit. Today this is only the CLI's serial daemon-spawn suite
 * (`pnpm test:serial`) — it already correctly sets `passWithNoTests: false`
 * (the reference pattern this guard generalizes) — listed explicitly here so
 * it can never be silently dropped from the audit if it's ever loosened.
 */
export const ADDITIONAL_VITEST_CONFIG_PATHS = [
  'apps/cli/vitest.serial.config.ts',
];

/**
 * Every vitest config path this repo's CI actually runs that must reject an
 * empty test run: one default config per `packageDirs` entry, plus every
 * `ADDITIONAL_VITEST_CONFIG_PATHS` entry. Deriving the default set from
 * `packageDirs` (rather than a second hand-maintained list) means a newly
 * added publishable package is covered automatically.
 *
 * @param {readonly string[]} [packageDirs]
 * @returns {string[]}
 */
export function allGuardedVitestConfigPaths(packageDirs = PACKAGE_DIRS) {
  return [
    ...defaultVitestConfigPaths(packageDirs),
    ...ADDITIONAL_VITEST_CONFIG_PATHS,
  ];
}

/**
 * Whether a resolved vitest config (a `defineConfig({...})` module's
 * `default` export) opts into `passWithNoTests: true`.
 *
 * @param {{ test?: { passWithNoTests?: boolean } } | undefined} resolvedConfig
 * @returns {boolean}
 */
export function optsIntoPassWithNoTests(resolvedConfig) {
  return resolvedConfig?.test?.passWithNoTests === true;
}

/**
 * Validate a set of `{ configPath, resolvedConfig }` pairs, throwing a
 * single, loud error naming every config that opts into
 * `passWithNoTests: true`.
 *
 * @param {{ configPath: string, resolvedConfig: unknown }[]} resolvedConfigs
 */
export function assertNoneOptIntoPassWithNoTests(resolvedConfigs) {
  const offenders = resolvedConfigs
    .filter(({ resolvedConfig }) => optsIntoPassWithNoTests(resolvedConfig))
    .map(({ configPath }) => configPath);
  if (offenders.length > 0) {
    throw new Error(
      'The following vitest config(s) set passWithNoTests: true, which lets an ' +
        'emptied, renamed-away-from, or misconfigured test suite report a green ' +
        `result instead of failing: ${offenders.join(', ')}. Remove ` +
        'passWithNoTests (vitest 4 already defaults to false) or set it to ' +
        'false explicitly.',
    );
  }
}

/**
 * Dynamically import a vitest config file the same way `vitest run` resolves
 * it, and return its `defineConfig(...)` object (the module's default
 * export).
 *
 * @param {string} repoRoot
 * @param {string} configPath - relative to `repoRoot`
 * @returns {Promise<{ test?: { passWithNoTests?: boolean } } | undefined>}
 */
export async function importVitestConfig(repoRoot, configPath) {
  const absPath = path.join(repoRoot, configPath);
  const mod = await import(pathToFileURL(absPath).href);
  return mod.default;
}

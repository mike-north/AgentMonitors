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
import { PACKAGE_DIRS, packageInfo } from './publish-release-packages.mjs';

/**
 * The exact `test` script `assertPackageTestScriptsMatchAudit` requires of
 * every `PACKAGE_DIRS` package (absent a documented
 * `TEST_SCRIPT_EXCEPTIONS` entry). `defaultVitestConfigPaths` assumes every
 * such package's default config lives at `<dir>/vitest.config.ts` and is
 * invoked with no flags that change discovery — this is the script value
 * that assumption depends on.
 */
export const REQUIRED_TEST_SCRIPT = 'vitest run';

/**
 * Documented, reviewed exceptions to `REQUIRED_TEST_SCRIPT`, keyed by
 * `PACKAGE_DIRS` entry. Every entry here is a gap in the zero-test audit for
 * that package, so keep this empty unless a package has a genuine, reviewed
 * need to invoke vitest differently for its default `test` script — no
 * package needs one today.
 *
 * @type {Record<string, string>}
 */
export const TEST_SCRIPT_EXCEPTIONS = {};

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
  // Forward slashes only: these paths are compared against and returned
  // alongside ADDITIONAL_VITEST_CONFIG_PATHS' string literals below, and
  // `path.join` would emit backslashes on win32.
  return packageDirs.map((dir) => `${dir}/vitest.config.ts`);
}

/**
 * Named vitest configs, beyond each package's default `vitest.config.ts`,
 * that are wired into a CI test step and so must also be covered by this
 * audit: the CLI's serial daemon-spawn suite (`pnpm test:serial`) and this
 * guard's own home config (`pnpm test:scripts`, `scripts/vitest.config.ts`)
 * — both already correctly omit `passWithNoTests: true` (the reference
 * pattern this guard generalizes) — listed explicitly here so neither can be
 * silently dropped from the audit if either is ever loosened.
 */
export const ADDITIONAL_VITEST_CONFIG_PATHS = [
  'apps/cli/vitest.serial.config.ts',
  'scripts/vitest.config.ts',
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
 * Validate that every `packageDirs` entry's package.json `test` script is
 * exactly `REQUIRED_TEST_SCRIPT` (or matches its documented
 * `TEST_SCRIPT_EXCEPTIONS` entry), throwing a single, loud error naming
 * every offender.
 *
 * `defaultVitestConfigPaths` and the `passWithNoTests` check above only
 * inspect each package's `<dir>/vitest.config.ts` by filename — they never
 * verify that `pnpm test` (the command CI and Nx actually invoke) resolves
 * that exact file with no overriding flags. A `test` script rewritten to
 * `vitest run --config other.ts` would point Nx at an unaudited config, and
 * one rewritten to `vitest run --passWithNoTests` would defeat the audit's
 * whole purpose via a CLI flag, which overrides the config file's own
 * `passWithNoTests: false`. This closes that gap.
 *
 * @param {readonly string[]} packageDirs
 * @param {string} repoRoot
 * @param {(packageDir: string, repoRoot: string) => { packageJson: { scripts?: Record<string, string> } }} [getPackageInfo]
 * @param {Record<string, string>} [exceptions]
 */
export function assertPackageTestScriptsMatchAudit(
  packageDirs,
  repoRoot,
  getPackageInfo = packageInfo,
  exceptions = TEST_SCRIPT_EXCEPTIONS,
) {
  const offenders = packageDirs
    .map((packageDir) => {
      const { packageJson } = getPackageInfo(packageDir, repoRoot);
      const script = packageJson.scripts?.test;
      const required = exceptions[packageDir] ?? REQUIRED_TEST_SCRIPT;
      return script === required
        ? undefined
        : `${packageDir} (test: ${JSON.stringify(script)})`;
    })
    .filter((offender) => offender !== undefined);
  if (offenders.length > 0) {
    throw new Error(
      `The following package(s)' "test" script does not exactly match the ` +
        `required "${REQUIRED_TEST_SCRIPT}" (or a documented ` +
        `TEST_SCRIPT_EXCEPTIONS entry): ${offenders.join(', ')}. A "test" ` +
        'script with an extra --config, --passWithNoTests, or other flag ' +
        'that changes test discovery can silently escape the vitest ' +
        'zero-test audit above; add a reviewed TEST_SCRIPT_EXCEPTIONS entry ' +
        'only if the package genuinely needs to invoke vitest differently.',
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

// Derives the set of bundled observation-source names that MUST be exercised
// by the standalone-consumer smoke test (`scripts/test-standalone-consumer.mjs`)
// from the authoritative publishable-package list (`PACKAGE_DIRS` in
// `scripts/publish-release-packages.mjs`), and validates there is no drift
// between the two. See issue #264: before this module existed, the smoke
// test's covered-source list was hand-maintained and had silently fallen out
// of sync with `PACKAGE_DIRS` (missing `command-poll`).

/** Directory prefix identifying a bundled observation-source package. */
const SOURCE_PACKAGE_DIR_PREFIX = 'plugins/source-';

/**
 * Map publishable package directories (as listed in `PACKAGE_DIRS`) to the
 * observation-source names they must contribute (e.g.
 * `plugins/source-command-poll` -> `command-poll`). Non-source packages
 * (`libs/core`, `apps/*`) are not observation sources and are excluded.
 *
 * @param {readonly string[]} packageDirs
 * @returns {string[]} sorted, de-duplicated source names
 */
export function sourcePackageNamesFromDirs(packageDirs) {
  const names = packageDirs
    .filter((dir) => dir.startsWith(SOURCE_PACKAGE_DIR_PREFIX))
    .map((dir) => dir.slice(SOURCE_PACKAGE_DIR_PREFIX.length));
  return [...new Set(names)].sort();
}

/**
 * Validate that every publishable `plugins/source-*` package (per
 * `packageDirs`) is exercised by the standalone-consumer smoke test (per
 * `coveredSourceNames`). Throws a loud, name-the-package error on drift so a
 * new bundled source can never ship silently untested.
 *
 * @param {readonly string[]} packageDirs
 * @param {readonly string[]} coveredSourceNames
 */
export function assertSourceCoverage(packageDirs, coveredSourceNames) {
  const required = sourcePackageNamesFromDirs(packageDirs);
  const covered = new Set(coveredSourceNames);
  const missing = required.filter((name) => !covered.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Standalone-consumer smoke test does not cover published source package(s): ${missing.join(', ')}. ` +
        'Add each missing source to the SOURCE_PLUGINS list in scripts/test-standalone-consumer.mjs ' +
        '(and exercise it in the generated smoke script) to keep coverage in sync with PACKAGE_DIRS ' +
        'in scripts/publish-release-packages.mjs.',
    );
  }
}

// Ties together the four places license identity is asserted in this repo —
// README.md's "## License" section, the root package.json, every published
// package's package.json (`PACKAGE_DIRS` in publish-release-packages.mjs),
// and the LICENSE file text — and reports a loud, name-the-source issue when
// any of them disagree.
//
// Regression guard for issue #289: PR #255 relicensed every published
// manifest to MIT and added LICENSE files, but README.md's "## License"
// section still stated the old `UNLICENSED` label, so the repo silently
// contradicted itself (LICENSE + manifests said MIT; the README said
// UNLICENSED) across several releases with nothing catching it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_DIRS, REPO_ROOT } from './publish-release-packages.mjs';

/** The single license identity every source of truth below must agree on. */
export const EXPECTED_LICENSE = 'MIT';

const README_LICENSE_SECTION_RE = /^##\s+License\s*\n+([^\n]*)/m;

/**
 * Extract the license label stated in a README's "## License" section (e.g.
 * "MIT. See [LICENSE](LICENSE)." -> "MIT"). Returns `null` when there is no
 * "## License" heading, or its first line doesn't start with a recognizable
 * license token.
 *
 * @param {string} readmeContent
 * @returns {string | null}
 */
export function licenseLabelFromReadme(readmeContent) {
  const match = readmeContent.match(README_LICENSE_SECTION_RE);
  if (!match) return null;
  const firstLine = match[1].trim();
  const tokenMatch = /^([A-Za-z][A-Za-z0-9.-]*)/.exec(firstLine);
  return tokenMatch ? tokenMatch[1].replace(/\.+$/, '') : null;
}

/**
 * Whether a README's "## License" section (and everything after it, since a
 * README has no section-end marker) contains a markdown link targeting the
 * repo-root LICENSE file — `[...](LICENSE)` or `[...](./LICENSE)`.
 *
 * @param {string} readmeContent
 * @returns {boolean}
 */
export function readmeLicenseSectionLinksToLicenseFile(readmeContent) {
  const match = readmeContent.match(README_LICENSE_SECTION_RE);
  if (!match) return false;
  const section = readmeContent.slice(readmeContent.indexOf(match[0]));
  return /]\(\.?\/?LICENSE\)/.test(section);
}

/**
 * The license token from a LICENSE file's first line (e.g. "MIT License" ->
 * "MIT").
 *
 * @param {string} licenseFileContent
 * @returns {string | null}
 */
export function licenseLabelFromLicenseFile(licenseFileContent) {
  const firstLine = licenseFileContent.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const tokenMatch = /^([A-Za-z][A-Za-z0-9.-]*)/.exec(firstLine);
  return tokenMatch ? tokenMatch[1] : null;
}

/**
 * Validate that every license-identity source — the README label, the
 * README's link to LICENSE, the root manifest, every published manifest,
 * and the LICENSE file's own header — agrees on `expected`. Returns a list
 * of human-readable issue strings; an empty list means everything is
 * consistent.
 *
 * Pure: takes pre-read file contents rather than doing its own file I/O, so
 * the negative (contradiction) case can be exercised with synthetic input
 * instead of mutating real repo files.
 *
 * @param {object} input
 * @param {string} input.readmeContent
 * @param {string} input.licenseFileContent
 * @param {{ name: string, license: unknown }} input.rootPackage
 * @param {{ name: string, license: unknown }[]} input.publishedPackages
 * @param {string} [expected]
 * @returns {string[]}
 */
export function licenseConsistencyIssues(
  { readmeContent, licenseFileContent, rootPackage, publishedPackages },
  expected = EXPECTED_LICENSE,
) {
  const issues = [];

  const readmeLabel = licenseLabelFromReadme(readmeContent);
  if (readmeLabel !== expected) {
    issues.push(
      `README.md "## License" section states "${readmeLabel ?? '(none found)'}", expected "${expected}"`,
    );
  } else if (!readmeLicenseSectionLinksToLicenseFile(readmeContent)) {
    issues.push('README.md "## License" section does not link to LICENSE');
  }

  const licenseFileLabel = licenseLabelFromLicenseFile(licenseFileContent);
  if (licenseFileLabel !== expected) {
    issues.push(
      `LICENSE file's header states "${licenseFileLabel ?? '(none found)'}", expected "${expected}"`,
    );
  }

  if (rootPackage.license !== expected) {
    issues.push(
      `Root package.json ("${rootPackage.name}") "license" is "${String(rootPackage.license)}", expected "${expected}"`,
    );
  }

  for (const pkg of publishedPackages) {
    if (pkg.license !== expected) {
      issues.push(
        `${pkg.name} package.json "license" is "${String(pkg.license)}", expected "${expected}"`,
      );
    }
  }

  return issues;
}

/**
 * Read the real repo's README.md, LICENSE, root package.json, and every
 * `packageDirs` package.json, and run `licenseConsistencyIssues` against
 * them.
 *
 * @param {string} [repoRoot]
 * @param {readonly string[]} [packageDirs]
 * @returns {string[]}
 */
export function realRepoLicenseConsistencyIssues(
  repoRoot = REPO_ROOT,
  packageDirs = PACKAGE_DIRS,
) {
  const readmeContent = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const licenseFileContent = readFileSync(
    path.join(repoRoot, 'LICENSE'),
    'utf8',
  );
  const rootPackageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const publishedPackages = packageDirs.map((dir) => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'),
    );
    return { name: packageJson.name, license: packageJson.license };
  });

  return licenseConsistencyIssues({
    readmeContent,
    licenseFileContent,
    rootPackage: {
      name: rootPackageJson.name,
      license: rootPackageJson.license,
    },
    publishedPackages,
  });
}

// Tests for the license-consistency guard added for issue #289 ("Resolve the
// README's UNLICENSED vs MIT contradiction and guard license metadata").
// `license-consistency.mjs`, `publish-release-packages.mjs`, and the rest of
// `scripts/` are plain JS (no `.d.ts`), consistent with the eslint.config.mjs
// `scripts/**/*.mjs` override — this file relies on vitest's untyped esbuild
// transform rather than `tsc --noEmit`, same as `source-coverage.test.ts`.
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_LICENSE,
  licenseConsistencyIssues,
  licenseLabelFromLicenseFile,
  licenseLabelFromReadme,
  readmeLicenseSectionLinksToLicenseFile,
  realRepoLicenseConsistencyIssues,
} from './license-consistency.mjs';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';

const VALID_README = [
  '# Agent Monitors',
  '',
  'Some project description.',
  '',
  '## License',
  '',
  'MIT. See [LICENSE](LICENSE). © 2026 Mike North.',
  '',
].join('\n');

// The exact pre-fix statement issue #289 reports: README.md:192-194 said
// UNLICENSED while LICENSE and every package manifest said MIT.
const CONTRADICTORY_README = [
  '# Agent Monitors',
  '',
  '## License',
  '',
  'UNLICENSED. © Mike North.',
  '',
].join('\n');

const MIT_LICENSE_FILE = [
  'MIT License',
  '',
  'Copyright (c) 2026 Mike North',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
].join('\n');

describe('licenseLabelFromReadme', () => {
  it('extracts the MIT label from a well-formed License section', () => {
    expect(licenseLabelFromReadme(VALID_README)).toBe('MIT');
  });

  it('extracts UNLICENSED from the pre-fix statement (issue #289 regression)', () => {
    expect(licenseLabelFromReadme(CONTRADICTORY_README)).toBe('UNLICENSED');
  });

  it('returns null when there is no "## License" heading', () => {
    expect(
      licenseLabelFromReadme('# Title\n\nno license section here'),
    ).toBeNull();
  });
});

describe('readmeLicenseSectionLinksToLicenseFile', () => {
  it('detects a relative markdown link to LICENSE', () => {
    expect(readmeLicenseSectionLinksToLicenseFile(VALID_README)).toBe(true);
  });

  it('returns false when the License section has no LICENSE link', () => {
    expect(readmeLicenseSectionLinksToLicenseFile(CONTRADICTORY_README)).toBe(
      false,
    );
  });

  it('returns false when there is no "## License" heading at all', () => {
    expect(readmeLicenseSectionLinksToLicenseFile('# Title\n')).toBe(false);
  });
});

describe('licenseLabelFromLicenseFile', () => {
  it('extracts MIT from a standard MIT LICENSE header', () => {
    expect(licenseLabelFromLicenseFile(MIT_LICENSE_FILE)).toBe('MIT');
  });

  it('extracts a different SPDX token from a non-MIT header', () => {
    expect(licenseLabelFromLicenseFile('Apache License\nVersion 2.0')).toBe(
      'Apache',
    );
  });
});

describe('licenseConsistencyIssues', () => {
  const consistentInput = {
    readmeContent: VALID_README,
    licenseFileContent: MIT_LICENSE_FILE,
    rootPackage: { name: 'agentmonitors-workspace', license: EXPECTED_LICENSE },
    publishedPackages: [
      { name: '@agentmonitors/core', license: EXPECTED_LICENSE },
      { name: '@agentmonitors/cli', license: EXPECTED_LICENSE },
    ],
  };

  it('returns no issues when every source agrees on MIT', () => {
    expect(licenseConsistencyIssues(consistentInput)).toEqual([]);
  });

  // Regression test for issue #289: before this check existed, README.md
  // stated "UNLICENSED" while LICENSE and every package manifest said "MIT",
  // and nothing in the test suite caught the contradiction. This proves the
  // check fails loudly and names the offending source (the README) if that
  // state is ever reintroduced.
  it('fails loudly naming the README when it contradicts MIT (issue #289 regression)', () => {
    const issues = licenseConsistencyIssues({
      ...consistentInput,
      readmeContent: CONTRADICTORY_README,
    });
    expect(issues).toEqual([expect.stringMatching(/README\.md.*UNLICENSED/)]);
  });

  it('fails loudly naming the offending published package when its manifest disagrees', () => {
    const issues = licenseConsistencyIssues({
      ...consistentInput,
      publishedPackages: [
        { name: '@agentmonitors/core', license: EXPECTED_LICENSE },
        { name: '@agentmonitors/cli', license: 'UNLICENSED' },
      ],
    });
    expect(issues).toEqual([
      expect.stringMatching(/@agentmonitors\/cli.*UNLICENSED/),
    ]);
  });

  it('fails loudly when the root package.json disagrees', () => {
    const issues = licenseConsistencyIssues({
      ...consistentInput,
      rootPackage: { name: 'agentmonitors-workspace', license: 'UNLICENSED' },
    });
    expect(issues).toEqual([
      expect.stringMatching(/Root package\.json.*UNLICENSED/),
    ]);
  });

  it('fails loudly when the LICENSE file header disagrees', () => {
    const issues = licenseConsistencyIssues({
      ...consistentInput,
      licenseFileContent: 'Apache License\n\nVersion 2.0',
    });
    expect(issues).toEqual([expect.stringMatching(/LICENSE file.*Apache/)]);
  });

  it('fails loudly when the README license section omits the LICENSE link', () => {
    const issues = licenseConsistencyIssues({
      ...consistentInput,
      readmeContent: '# Title\n\n## License\n\nMIT.\n',
    });
    expect(issues).toEqual([expect.stringMatching(/does not link to LICENSE/)]);
  });

  it('reports every disagreeing source at once, not just the first', () => {
    const issues = licenseConsistencyIssues({
      readmeContent: CONTRADICTORY_README,
      licenseFileContent: 'Apache License\n\nVersion 2.0',
      rootPackage: { name: 'agentmonitors-workspace', license: 'UNLICENSED' },
      publishedPackages: [
        { name: '@agentmonitors/core', license: 'UNLICENSED' },
      ],
    });
    expect(issues).toHaveLength(4);
  });
});

// Drift guard: the real repo's README.md, LICENSE, root package.json, and
// every published package.json (per publish-release-packages.mjs's
// PACKAGE_DIRS) must actually agree on MIT. This is the real regression
// issue #289 fixes — before the README fix in this PR, this assertion would
// have failed on the real README.md contradiction.
describe('real repo license consistency', () => {
  it('has no license-consistency issues across README, LICENSE, and published manifests', () => {
    expect(realRepoLicenseConsistencyIssues()).toEqual([]);
  });

  it('is actually checking at least one published package (sanity check)', () => {
    expect(PACKAGE_DIRS.length).toBeGreaterThan(0);
  });
});

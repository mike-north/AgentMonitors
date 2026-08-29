/**
 * Committed lockfile-resolution regression check for better-sqlite3 (Refs
 * #516, #509): a review finding on the fix PR pointed out that the original
 * "everything resolves to 13.0.3" verification was only a one-off command
 * run by hand, not a committed check — so a future dependency bump could
 * silently reintroduce a pre-13.0.2 resolution (the version class that made
 * the native addon call `process.abort()` under Node 24 instead of throwing,
 * killing the daemon) with nothing in CI to catch it.
 *
 * This suite runs the real `pnpm why better-sqlite3 --json` against the
 * workspace (same technique as the `PATCHED_MINIMUMS` suite in
 * `check-dependency-audit.test.ts`, Refs #290) and is deliberately kept in
 * its own file/mechanism rather than folded into that list: this floor is a
 * process-stability fix, not a GHSA security advisory, and the two should
 * not be able to drift together.
 *
 * @see https://github.com/mike-north/AgentMonitors/issues/516
 * @see https://github.com/mike-north/AgentMonitors/issues/509
 * @see https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.2
 * @see https://pnpm.io/cli/why
 */
import { describe, expect, it } from 'vitest';
import { versionAtLeast } from './check-dependency-audit.mjs';
import {
  betterSqlite3Resolutions,
  EXPECTED_CONSUMERS,
  formatResolutions,
  parseWhyOutput,
  SAFE_MINIMUM_VERSION,
} from './check-better-sqlite3-resolution.mjs';

describe('better-sqlite3 workspace resolution (lockfile regression, Refs #516/#509)', () => {
  it('resolves to exactly one shared version across the entire workspace lockfile', () => {
    const resolutions = betterSqlite3Resolutions();

    expect(
      resolutions.length,
      `expected a single shared better-sqlite3 resolution; found ${resolutions.length}:\n${formatResolutions(resolutions)}`,
    ).toBe(1);
  });

  it(`the shared resolution satisfies the safe minimum (>=${SAFE_MINIMUM_VERSION})`, () => {
    const resolutions = betterSqlite3Resolutions();

    for (const resolution of resolutions) {
      expect(
        versionAtLeast(resolution.version, SAFE_MINIMUM_VERSION),
        `better-sqlite3@${resolution.version} is older than the safe minimum ` +
          `${SAFE_MINIMUM_VERSION} (the release that fixed the Node 24 ` +
          `process-abort crash, Refs #516/#509):\n${formatResolutions([resolution])}`,
      ).toBe(true);
    }
  });

  for (const consumer of EXPECTED_CONSUMERS) {
    it(`${consumer} is a named consumer of the shared resolution`, () => {
      const resolutions = betterSqlite3Resolutions();
      const matching = resolutions.filter((resolution) =>
        resolution.consumers.includes(consumer),
      );

      expect(
        matching.length,
        `expected exactly one resolution naming "${consumer}" as a consumer; ` +
          `found ${matching.length}:\n${formatResolutions(resolutions)}`,
      ).toBe(1);
    });
  }
});

describe('parseWhyOutput (pure parsing, no shell-out)', () => {
  it('collects nested peer-dependency consumers (drizzle-orm behind @agentmonitors/core)', () => {
    const fixture = JSON.stringify([
      {
        version: '13.0.3',
        dependents: [
          {
            name: '@agentmonitors/cli',
            version: '0.11.0',
            depField: 'dependencies',
          },
          {
            name: '@agentmonitors/core',
            version: '0.13.0',
            depField: 'dependencies',
          },
          {
            name: 'drizzle-orm',
            version: '0.45.2',
            dependents: [
              {
                name: '@agentmonitors/core',
                version: '0.13.0',
                depField: 'dependencies',
              },
            ],
          },
        ],
      },
    ]);

    expect(parseWhyOutput(fixture)).toEqual([
      {
        version: '13.0.3',
        consumers: ['@agentmonitors/cli', '@agentmonitors/core', 'drizzle-orm'],
      },
    ]);
  });

  it('returns an empty consumer list for an entry with no dependents', () => {
    const fixture = JSON.stringify([{ version: '13.0.3' }]);

    expect(parseWhyOutput(fixture)).toEqual([
      { version: '13.0.3', consumers: [] },
    ]);
  });

  // Regression fixture: reproduces the exact failure shape this check exists
  // to catch. Two dependents pinned to divergent version ranges cause pnpm
  // to resolve better-sqlite3 to two separate versions instead of one
  // shared one, and one of the two is below the safe minimum. Before this
  // check existed, only a one-off `pnpm why` command quoted in the PR body
  // caught this — nothing committed would fail CI on a future regression.
  it('flags a split resolution where one branch is below the safe minimum', () => {
    const fixture = JSON.stringify([
      {
        version: '13.0.3',
        dependents: [
          {
            name: '@agentmonitors/core',
            version: '0.13.0',
            depField: 'dependencies',
          },
        ],
      },
      {
        version: '11.10.0',
        dependents: [
          {
            name: '@agentmonitors/cli',
            version: '0.11.0',
            depField: 'dependencies',
          },
        ],
      },
    ]);

    const resolutions = parseWhyOutput(fixture);

    expect(resolutions).toHaveLength(2);
    expect(
      resolutions.some(
        (resolution) =>
          !versionAtLeast(resolution.version, SAFE_MINIMUM_VERSION),
      ),
    ).toBe(true);
    // formatResolutions must name both the safe and unsafe branch so a CI
    // failure is diagnosable from the printed output alone.
    expect(formatResolutions(resolutions)).toContain('@agentmonitors/core');
    expect(formatResolutions(resolutions)).toContain('@agentmonitors/cli');
  });

  it('reports "(no named consumers found)" for a resolution with an empty dependents list', () => {
    const fixture = JSON.stringify([{ version: '13.0.3', dependents: [] }]);

    expect(formatResolutions(parseWhyOutput(fixture))).toContain(
      '(no named consumers found)',
    );
  });
});

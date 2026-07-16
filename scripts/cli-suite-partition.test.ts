/**
 * Regression guard for issue #288: apps/cli's default (`vitest.config.ts`)
 * and serial (`vitest.serial.config.ts`) suites must partition the package's
 * tracked test files without overlap (a file run by both, wasting CI time
 * and — for the daemon-spawn tests — reintroducing the exact CPU-starvation
 * flakiness the serial suite exists to avoid) or gaps (a file run by
 * neither, silently never executed by either CI step).
 *
 * The real-repo assertions below call `vitest list` against both configs —
 * the actual file-resolution vitest performs — rather than a hand-built
 * glob matcher, so drift in either config's include/exclude patterns is
 * caught against real behavior.
 *
 * @see https://vitest.dev/guide/cli.html#vitest-list
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_DEFAULT_CONFIG,
  CLI_PACKAGE_DIR,
  CLI_SERIAL_CONFIG,
  partitionIssues,
  realCliSuitePartitionIssues,
} from './cli-suite-partition.mjs';
import { REPO_ROOT } from './publish-release-packages.mjs';

describe('partitionIssues', () => {
  it('reports no issues for a clean partition', () => {
    expect(
      partitionIssues({
        allFiles: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
        groupA: ['a.test.ts', 'b.test.ts'],
        groupAName: 'default',
        groupB: ['c.test.ts'],
        groupBName: 'serial',
      }),
    ).toEqual([]);
  });

  // Regression fixture: reproduces what would happen if a daemon-spawn test
  // were added to BOTH apps/cli/vitest.config.ts's include set (i.e. not
  // excluded) and vitest.serial.config.ts's include set — the exact overlap
  // this check exists to catch.
  it('reports an overlap when a file is run by both groups', () => {
    const issues = partitionIssues({
      allFiles: ['a.test.ts', 'b.test.ts'],
      groupA: ['a.test.ts', 'b.test.ts'],
      groupAName: 'default',
      groupB: ['b.test.ts'],
      groupBName: 'serial',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/BOTH default and serial/);
    expect(issues[0]).toContain('b.test.ts');
  });

  // Regression fixture: reproduces what would happen if a new test file were
  // added under apps/cli but never picked up by either suite (e.g. excluded
  // by the default config's exclude list and never added to the serial
  // config's include list) — the exact gap this check exists to catch.
  it('reports a gap when a file is run by neither group', () => {
    const issues = partitionIssues({
      allFiles: ['a.test.ts', 'orphaned.test.ts'],
      groupA: ['a.test.ts'],
      groupAName: 'default',
      groupB: [],
      groupBName: 'serial',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/NEITHER default nor serial/);
    expect(issues[0]).toContain('orphaned.test.ts');
  });

  it('reports both overlap and gap issues together, each naming its own files', () => {
    const issues = partitionIssues({
      allFiles: ['a.test.ts', 'b.test.ts', 'orphaned.test.ts'],
      groupA: ['a.test.ts', 'b.test.ts'],
      groupAName: 'default',
      groupB: ['b.test.ts'],
      groupBName: 'serial',
    });
    expect(issues).toHaveLength(2);
    expect(issues.join('\n')).toContain('b.test.ts');
    expect(issues.join('\n')).toContain('orphaned.test.ts');
  });

  it('flags a group file that is outside the tracked inventory entirely', () => {
    const issues = partitionIssues({
      allFiles: ['a.test.ts'],
      groupA: ['a.test.ts', 'untracked.test.ts'],
      groupAName: 'default',
      groupB: [],
      groupBName: 'serial',
    });
    expect(issues.some((issue) => issue.includes('untracked.test.ts'))).toBe(
      true,
    );
  });
});

// The real proof: apps/cli's actual, on-disk default and serial vitest
// configs must partition the package's actual tracked test files. If a
// future edit adds a test file that neither config's include/exclude picks
// up, or that both configs pick up, this fails against the real repo state.
describe('apps/cli suite partition (real repo)', () => {
  it('has no overlap or gap between the default and serial suites', () => {
    expect(realCliSuitePartitionIssues()).toEqual([]);
  }, 30_000);

  // CLI_DEFAULT_CONFIG / CLI_SERIAL_CONFIG are passed straight to `vitest
  // list --config <file>` above, resolved relative to apps/cli — so this
  // proves the two names this suite audits are real, on-disk config files,
  // not a comparison of the constants against their own literal values.
  it('CLI_DEFAULT_CONFIG and CLI_SERIAL_CONFIG name real, on-disk apps/cli vitest configs', () => {
    const packageAbsDir = path.join(REPO_ROOT, CLI_PACKAGE_DIR);
    expect(existsSync(path.join(packageAbsDir, CLI_DEFAULT_CONFIG))).toBe(true);
    expect(existsSync(path.join(packageAbsDir, CLI_SERIAL_CONFIG))).toBe(true);
  });
});

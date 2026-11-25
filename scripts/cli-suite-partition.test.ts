/**
 * Every tracked CLI test file must be discovered by exactly one Vitest suite.
 * @see https://vitest.dev/guide/cli.html#vitest-list
 */
import { describe, expect, it } from 'vitest';
import {
  CLI_PACKAGE_DIR,
  CLI_VITEST_CONFIGS,
  listVitestFiles,
  partitionIssues,
  realCliSuitePartitionIssues,
} from './cli-suite-partition.mjs';
import { REPO_ROOT } from './publish-release-packages.mjs';
import path from 'node:path';

describe('partitionIssues', () => {
  it('reports no issues for a clean partition', () => {
    expect(
      partitionIssues(['a.test.ts', 'b.test.ts', 'smoke.test.ts'], {
        default: ['a.test.ts'],
        serial: ['b.test.ts'],
        smoke: ['smoke.test.ts'],
      }),
    ).toEqual([]);
  });

  it('names every suite that runs a duplicate file', () => {
    const issues = partitionIssues(['smoke.test.ts'], {
      default: ['smoke.test.ts'],
      serial: ['smoke.test.ts'],
      smoke: ['smoke.test.ts'],
    });
    expect(issues).toEqual([
      'Multiple CLI suites run smoke.test.ts: default, serial, smoke',
    ]);
  });

  it('reports a gap when no suite runs a tracked file', () => {
    const issues = partitionIssues(['a.test.ts', 'orphaned.test.ts'], {
      default: ['a.test.ts'],
      serial: [],
      smoke: [],
    });
    expect(issues).toEqual(['No CLI suite runs: orphaned.test.ts']);
  });

  it('reports overlap and gap issues together', () => {
    const issues = partitionIssues(['a.test.ts', 'orphaned.test.ts'], {
      default: ['a.test.ts'],
      serial: ['a.test.ts'],
      smoke: [],
    });
    expect(issues).toEqual([
      'Multiple CLI suites run a.test.ts: default, serial',
      'No CLI suite runs: orphaned.test.ts',
    ]);
  });

  it('flags a suite file outside the tracked inventory', () => {
    const issues = partitionIssues(['a.test.ts'], {
      default: ['a.test.ts'],
      serial: [],
      smoke: ['untracked.test.ts'],
    });
    expect(issues).toEqual([
      'smoke runs file(s) outside the tracked test-file inventory: untracked.test.ts',
    ]);
  });
});

describe('apps/cli suite partition (real repo)', () => {
  it('covers all tracked tests once across the default, serial, and smoke suites', () => {
    expect(realCliSuitePartitionIssues()).toEqual([]);
  }, 30_000);

  it('runs only the install smoke in the dedicated suite', () => {
    const cliDir = path.join(REPO_ROOT, CLI_PACKAGE_DIR);
    const smokeConfig = 'vitest.docker-smoke.config.ts';
    expect(CLI_VITEST_CONFIGS).toContain(smokeConfig);
    expect(listVitestFiles(cliDir, smokeConfig)).toEqual([
      path.join(cliDir, 'src/commands/cli.docker.test.ts'),
    ]);
  }, 30_000);
});

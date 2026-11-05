/**
 * The Nx graph is the only owner of `apps/cli/dist` during a test run.
 *
 * `tsup` runs with `clean: true`, so every build removes the bundle before
 * writing it again. `nx run-many --target=test` runs the CLI and launcher suites
 * concurrently, and the launcher executes that bundle. A test that rebuilds it
 * makes the launcher exit 1 with MODULE_NOT_FOUND whenever the two overlap.
 *
 * @see https://nx.dev/docs/reference/project-configuration#dependson
 * @see docs/specs/004-validation-testing.md section 2.9
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './publish-release-packages.mjs';

/** A test process starting a package build; test sources have no other reason to do this. */
const BUILD_INVOCATION =
  /\b(?:exec|execFile|execFileSync|execSync|spawn|spawnSync)\(\s*['"`](?:tsup\b|(?:pnpm|npm|npx|nx)\b[^)]*?\bbuild\b)/;

function trackedTestSources(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'libs/**/*.test.ts',
      'plugins/**/*.test.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

describe('CLI build ownership', () => {
  // Pre-fix, these targets inherited only `^build`, so nothing but the
  // self-building test below ensured the CLI bundle existed for its own suite.
  it.each(['test', 'test:serial'])(
    'builds the CLI before its %s target',
    (target) => {
      const project = JSON.parse(
        readFileSync(path.join(REPO_ROOT, 'apps/cli/project.json'), 'utf8'),
      ) as { targets?: Record<string, { dependsOn?: string[] }> };

      expect(project.targets?.[target]?.dependsOn).toEqual(
        expect.arrayContaining(['^build', 'build']),
      );
    },
  );

  it('recognizes the ways a test could start a build', () => {
    for (const invocation of [
      "execFileSync('pnpm', ['build'], { cwd })",
      'spawnSync("pnpm", ["--filter", "@agentmonitors/cli", "build"])',
      "execSync('pnpm nx build @agentmonitors/cli')",
      "spawn('tsup', [])",
    ]) {
      expect(invocation).toMatch(BUILD_INVOCATION);
    }
    for (const unrelated of [
      "execFileSync('git', ['status'])",
      "spawnSync(process.execPath, [LAUNCHER_BIN, 'build'])",
      "failingChecks: ['build']",
    ]) {
      expect(unrelated).not.toMatch(BUILD_INVOCATION);
    }
  });

  it('never lets a test rebuild a package', () => {
    const offenders = trackedTestSources().filter((relativePath) =>
      BUILD_INVOCATION.test(
        readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });
});

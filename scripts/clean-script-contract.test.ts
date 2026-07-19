/**
 * Tests for the workspace `clean` script contract guard (issue #443).
 *
 * Before this guard existed, nothing in CI ever invoked `pnpm clean` (it
 * has no build/type-check/test side effect that any other check could
 * catch), so the contract had zero regression protection: a package's
 * `clean` script could silently regress to a `dist`-only `rm -rf` (losing
 * the api-extractor `temp/` scratch-dir cleanup), or the root `clean`
 * script could lose its `nx reset` step or its `NX_TUI=false` scoping,
 * and nothing would fail.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  ROOT_PACKAGE_JSON_PATH,
  WORKSPACE_ROOT_PROJECT_NAME,
  assertPackageCleanRemovesDistAndTemp,
  assertRootCleanRunsWorkspaceCleanAndReset,
  findApiExtractorPackageDirs,
} from './clean-script-contract.mjs';

describe('findApiExtractorPackageDirs', () => {
  it('discovers every real, on-disk package with an api-extractor config pair', () => {
    const found = findApiExtractorPackageDirs();
    // Not a hardcoded expectation of "the six package names" — just proof
    // that discovery actually finds something, and that it excludes both
    // the repo root (which carries the shared base config but no scripts
    // of its own) and a package with no api-extractor configs at all.
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('libs/core');
    expect(found).not.toContain('.');
    expect(found).not.toContain('apps/cli');
  });

  it('does not descend into ignored directories (sanity: no node_modules hits)', () => {
    const found = findApiExtractorPackageDirs();
    expect(found.some((dir) => dir.includes('node_modules'))).toBe(false);
  });
});

describe('assertPackageCleanRemovesDistAndTemp', () => {
  // Negative fixture #1: the pre-#443 shape — a package clean script that
  // removes only `dist`, exactly what every api-extractor package's
  // `clean` script looked like before this fix.
  it('rejects a "clean" script that only removes dist (pre-#443 shape)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // Negative fixture #3: a hypothetical FUTURE api-extractor package that
  // was scaffolded without ever adopting the temp-cleaning convention —
  // proves the guard rejects this drift shape wherever it appears, not
  // just in the specific packages that existed when #443 landed.
  it('rejects a future api-extractor package scaffolded with a dist-only clean', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        {
          scripts: {
            'check:api-report':
              'api-extractor run -c api-extractor.report.json',
            build: 'tsup && api-extractor run -c api-extractor.build.json',
            clean: 'rm -rf dist',
          },
        },
        'plugins/source-hypothetical-future',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  it('rejects a package missing a "clean" script entirely', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp({ scripts: {} }, 'test-package'),
    ).toThrow(/is missing a "clean" script/);
  });

  it('rejects a "clean" script that removes temp but not dist', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must remove "dist"/);
  });

  it('rejects a "clean" script that never runs `rm -rf` at all', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'echo not a real clean' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  it('accepts a correctly-shaped "clean" script (positive control)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp' } },
        'test-package',
      ),
    ).not.toThrow();
  });

  it('accepts dist and temp removed via separate chained rm -rf commands', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist && rm -rf temp' } },
        'test-package',
      ),
    ).not.toThrow();
  });

  // Regression fixture for the post-#443 review finding: `||` means "only
  // run if the previous command FAILED", so `rm -rf dist || rm -rf temp`
  // does NOT reliably remove `temp` — a successful `rm -rf dist` (the
  // normal case) skips the second command entirely. The pre-fix guard
  // flattened `&&` and `||` identically and wrongly accepted this.
  it('rejects "temp" removed only via `|| rm -rf temp` (guard false-accept #1)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist || rm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // The real proof: every actual, on-disk package discovered by
  // `findApiExtractorPackageDirs` must satisfy the contract. If any future
  // package's `clean` script drifts back to a `dist`-only shape, this
  // fails — closing the exact gap #443 shipped without: nothing else in
  // CI pins this per package.
  it.each(findApiExtractorPackageDirs())(
    'accepts the real, on-disk clean script for %s',
    (packageDir) => {
      const pkg: unknown = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf8'),
      );
      expect(() =>
        assertPackageCleanRemovesDistAndTemp(
          pkg as Parameters<typeof assertPackageCleanRemovesDistAndTemp>[0],
          packageDir,
        ),
      ).not.toThrow();
    },
  );
});

describe('assertRootCleanRunsWorkspaceCleanAndReset', () => {
  it('rejects a root "clean" script missing `nx run-many --target=clean` entirely', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: { clean: 'NX_TUI=false nx reset' },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  it('rejects a root "clean" script that does not exclude the workspace root project', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(new RegExp(`must exclude\\s+"${WORKSPACE_ROOT_PROJECT_NAME}"`));
  });

  it('rejects excluding a project whose name merely contains the workspace root name as a substring', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace2 && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must exclude/);
  });

  it('rejects `nx run-many --target=clean` that is not itself scoped with NX_TUI=false', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/`nx run-many --target=clean` invocation must itself be scoped/);
  });

  it('rejects a root "clean" script missing `nx reset` entirely', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  it('rejects `nx reset` running before `nx run-many --target=clean`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx reset && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace',
        },
      }),
    ).toThrow(/must run `nx reset` AFTER/);
  });

  // Negative fixture #2: `NX_TUI=false` scoped only to the first command in
  // the chain — a shared prefix that looks identical to a correctly-scoped
  // chain in a shell (both commands still run with the var unset for
  // `nx reset`... no: unset here means the var reverts to whatever the
  // parent shell had, i.e. NOT scoped), but leaves `nx reset` unguarded the
  // moment the chain is reordered or split into separate scripts. This is
  // exactly the mis-scoping issue #443's own fix commit corrected.
  it('rejects NX_TUI=false scoped only to the first command, leaving `nx reset` unscoped', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && nx reset',
        },
      }),
    ).toThrow(/`nx reset` invocation must itself be scoped/);
  });

  it('accepts a correctly-shaped root "clean" script (positive control)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).not.toThrow();
  });

  // Regression fixtures for the post-#443 review finding: `||` means "only
  // run if the previous command FAILED", so `nx reset` reachable only via
  // `run-many || nx reset` does NOT reliably reset the cache — a
  // successful `run-many` (the normal case) skips it entirely. The pre-fix
  // guard flattened `&&` and `||` identically and wrongly accepted both of
  // these shapes.
  it('rejects `nx run-many` reachable only via `||` (guard false-accept #1a)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'echo noop || NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  it('rejects `nx reset` reachable only via `||` (guard false-accept #1b)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace || NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  // Regression fixtures for the post-#443 review finding: `\b`-bounded
  // regexes match a word boundary right before a hyphen, so
  // `--target=clean-old`, `--exclude=agentmonitors-workspace-old`, and
  // `nx reset-old` were all wrongly accepted as the exact required tokens.
  it('rejects `--target=clean-old` masquerading as `--target=clean` (guard false-accept #2a)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean-old --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  it('rejects `--exclude=agentmonitors-workspace-old` masquerading as excluding the workspace root (guard false-accept #2b)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace-old && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(new RegExp(`must exclude\\s+"${WORKSPACE_ROOT_PROJECT_NAME}"`));
  });

  it('rejects `nx reset-old` masquerading as `nx reset` (guard false-accept #2c)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset-old',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  // The real proof: the actual, on-disk root package.json.
  it('accepts the real, on-disk root package.json', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8'),
    );
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset(
        pkg as Parameters<typeof assertRootCleanRunsWorkspaceCleanAndReset>[0],
      ),
    ).not.toThrow();
  });
});
